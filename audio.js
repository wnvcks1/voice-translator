/* 마이크 입력 → 발화 구간 감지(VAD) → 16kHz WAV + 피치 기반 성별 추정.
   순수 함수(detectPitch, estimateGender, createVad, encodeWav, resample)는 node 테스트 대상. */

export const TARGET_RATE = 16000;

/**
 * 선형 보간으로 리샘플링함.
 * @param {Float32Array} input 원본 PCM
 * @param {number} fromRate 원본 샘플레이트
 * @param {number} toRate 목표 샘플레이트
 * @returns {Float32Array}
 */
export function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const len = Math.floor(input.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = pos - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

/**
 * 프레임 RMS 를 dBFS 로 반환함.
 * @param {Float32Array} frame
 * @returns {number}
 */
export function rmsDb(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  const rms = Math.sqrt(s / Math.max(1, frame.length));
  return 20 * Math.log10(rms + 1e-9);
}

/**
 * 한 프레임의 기본 주파수(F0)를 정규화 자기상관(YIN 간이판)으로 추정함.
 * @param {Float32Array} frame 16kHz 기준 30~50ms 프레임
 * @param {number} sampleRate
 * @param {number} [minHz=70]
 * @param {number} [maxHz=400]
 * @returns {{f0:number, clarity:number}|null} 무성음·무음이면 null
 */
export function detectPitch(frame, sampleRate, minHz = 70, maxHz = 400) {
  const n = frame.length;
  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.min(Math.floor(sampleRate / minHz), n - 1);
  if (maxLag <= minLag + 2) return null;

  // YIN 누적평균 정규화 차분함수: 옥타브 오류(배음을 F0로 잡는 문제)에 자기상관보다 강함
  const d = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) {
      const diff = frame[i] - frame[i + lag];
      s += diff * diff;
    }
    d[lag] = s;
  }
  const cmnd = new Float32Array(maxLag + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    running += d[lag];
    cmnd[lag] = running > 0 ? (d[lag] * lag) / running : 1;
  }

  const threshold = 0.2;
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (cmnd[lag] < threshold) {
      while (lag + 1 <= maxLag && cmnd[lag + 1] < cmnd[lag]) lag++;
      best = lag;
      break;
    }
  }
  if (best < 0) return null;

  // 포물선 보간으로 lag 정밀화
  let lag = best;
  if (lag > 1 && lag < maxLag) {
    const a = cmnd[lag - 1], b = cmnd[lag], c = cmnd[lag + 1];
    const den = a - 2 * b + c;
    if (den !== 0) lag += (a - c) / (2 * den);
  }
  return { f0: sampleRate / lag, clarity: 1 - cmnd[best] };
}

/**
 * 발화 전체에서 중앙값 F0 를 구하고 성별을 추정함.
 * 성인 평균 F0: 남성 ~85–155Hz, 여성 ~165–255Hz. 사이 구간은 판단 보류.
 * @param {Float32Array} pcm 16kHz mono
 * @param {number} sampleRate
 * @param {{maleMax?:number, femaleMin?:number}} [opts]
 * @returns {{gender:'male'|'female'|'unknown', f0:number|null, voicedFrames:number}}
 */
export function estimateGender(pcm, sampleRate, opts = {}) {
  const maleMax = opts.maleMax ?? 160;
  const femaleMin = opts.femaleMin ?? 180;
  const frameLen = Math.round(sampleRate * 0.04);
  const hop = Math.round(sampleRate * 0.02);

  // 전체 피크 대비 -30dB 이상 프레임만 유성음 후보로 씀 (숨소리·잡음 배제)
  let peakDb = -120;
  for (let i = 0; i + frameLen <= pcm.length; i += hop) peakDb = Math.max(peakDb, rmsDb(pcm.subarray(i, i + frameLen)));

  const f0s = [];
  for (let i = 0; i + frameLen <= pcm.length; i += hop) {
    const fr = pcm.subarray(i, i + frameLen);
    if (rmsDb(fr) < peakDb - 30) continue;
    const p = detectPitch(fr, sampleRate);
    if (p && p.clarity > 0.6) f0s.push(p.f0);
  }
  if (f0s.length < 5) return { gender: 'unknown', f0: null, voicedFrames: f0s.length };
  f0s.sort((a, b) => a - b);
  const f0 = f0s[Math.floor(f0s.length / 2)];
  const gender = f0 <= maleMax ? 'male' : f0 >= femaleMin ? 'female' : 'unknown';
  return { gender, f0, voicedFrames: f0s.length };
}

/**
 * 에너지 기반 VAD 상태기계. 프레임을 넣으면 이벤트를 돌려줌.
 * 잡음 바닥(noise floor)을 적응 추적해서 시끄러운 식당에서도 기준이 따라감.
 * @param {{frameMs:number, startDb?:number, endDb?:number, startFrames?:number,
 *          silenceMs?:number, maxMs?:number, minSpeechMs?:number, preRollMs?:number}} cfg
 */
export function createVad(cfg) {
  const frameMs = cfg.frameMs;
  const startDb = cfg.startDb ?? 10;
  const endDb = cfg.endDb ?? 6;
  const startFrames = cfg.startFrames ?? 3;
  const silenceFrames = Math.ceil((cfg.silenceMs ?? 700) / frameMs);
  const maxFrames = Math.ceil((cfg.maxMs ?? 15000) / frameMs);
  const minSpeechFrames = Math.ceil((cfg.minSpeechMs ?? 350) / frameMs);
  const preRoll = Math.ceil((cfg.preRollMs ?? 300) / frameMs);

  const calibFrames = cfg.calibFrames ?? 8;
  let floor = -60;
  let seen = 0;
  let inSpeech = false;
  let above = 0, quiet = 0, voiced = 0;
  let pre = [];
  let buf = [];
  let dbs = [];

  const reset = () => { inSpeech = false; above = 0; quiet = 0; voiced = 0; buf = []; dbs = []; };

  return {
    get noiseFloor() { return floor; },
    get active() { return inSpeech; },
    reset() { reset(); pre = []; },
    /**
     * @param {Float32Array} frame
     * @returns {{type:'none'|'start'|'end'|'discard', frames?:Float32Array[], db:number}}
     */
    push(frame) {
      const db = rmsDb(frame);
      if (!inSpeech) {
        // 켜자마자 0.3초는 주변 소음 측정만 함 (시끄러운 식당에서 켜도 바로 오작동 안 하게)
        if (seen < calibFrames) {
          floor = seen === 0 ? db : (floor * seen + db) / (seen + 1);
          seen++;
          pre.push(frame);
          if (pre.length > preRoll) pre.shift();
          return { type: 'none', db };
        }
        // 바닥은 내려갈 땐 빠르게, 올라갈 땐 천천히 (말소리가 바닥을 끌어올리지 않게)
        floor = db < floor ? floor * 0.7 + db * 0.3 : floor * 0.98 + db * 0.02;
        pre.push(frame);
        if (pre.length > preRoll) pre.shift();
        above = db > floor + startDb ? above + 1 : 0;
        if (above >= startFrames) {
          inSpeech = true;
          buf = pre.slice();
          pre = [];
          voiced = above; quiet = 0;
          return { type: 'start', db };
        }
        return { type: 'none', db };
      }
      buf.push(frame);
      dbs.push(db);
      if (db > floor + endDb) { quiet = 0; voiced++; } else quiet++;
      if (quiet >= silenceFrames || buf.length >= maxFrames) {
        const frames = buf;
        const ok = voiced >= minSpeechFrames;
        // 최대 길이로 끊겼는데 음량 변화가 거의 없으면 말이 아니라 소음(환풍기·차량)이 커진 것 → 바닥을 올림.
        // 말소리는 음절마다 음량이 출렁여서 표준편차가 큼
        if (quiet < silenceFrames) {
          const mean = dbs.reduce((x, y) => x + y, 0) / dbs.length;
          const sd = Math.sqrt(dbs.reduce((x, y) => x + (y - mean) ** 2, 0) / dbs.length);
          if (sd < 3) floor = Math.max(floor, mean - 1);
        }
        reset();
        return { type: ok ? 'end' : 'discard', frames, db };
      }
      return { type: 'none', db };
    },
  };
}

/**
 * Float32 PCM 을 16bit mono WAV 로 인코딩함.
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 * @returns {Uint8Array}
 */
export function encodeWav(pcm, sampleRate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/**
 * 프레임 배열을 이어 붙임.
 * @param {Float32Array[]} frames
 * @returns {Float32Array}
 */
export function concat(frames) {
  const len = frames.reduce((a, f) => a + f.length, 0);
  const out = new Float32Array(len);
  let o = 0;
  for (const f of frames) { out.set(f, o); o += f.length; }
  return out;
}

/**
 * 브라우저 마이크 캡처. 프레임(16kHz) 단위로 VAD 를 돌리고 발화가 끝나면 onUtterance 호출.
 * @param {{onUtterance:(u:{pcm:Float32Array, wav:Uint8Array, durationMs:number, gender:object})=>void,
 *          onLevel?:(db:number, floor:number, active:boolean)=>void,
 *          onSpeechStart?:()=>void, vad?:object}} handlers
 */
export async function startMic(handlers) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const frameMs = (2048 / ctx.sampleRate) * 1000;
  const vad = createVad({ frameMs, ...(handlers.vad || {}) });
  let paused = false;

  proc.onaudioprocess = (e) => {
    const raw = e.inputBuffer.getChannelData(0);
    const frame = resample(new Float32Array(raw), ctx.sampleRate, TARGET_RATE);
    if (paused) { handlers.onLevel?.(rmsDb(frame), vad.noiseFloor, false); return; }
    const ev = vad.push(frame);
    // 화면 갱신 오류가 발화 처리를 막지 않게 격리
    try { handlers.onLevel?.(ev.db, vad.noiseFloor, vad.active); } catch { /* 표시만 실패 */ }
    if (ev.type === 'start') handlers.onSpeechStart?.();
    if (ev.type === 'discard') handlers.onDiscard?.();
    if (ev.type === 'end') {
      const pcm = concat(ev.frames);
      handlers.onUtterance({
        pcm,
        wav: encodeWav(pcm, TARGET_RATE),
        durationMs: (pcm.length / TARGET_RATE) * 1000,
        gender: estimateGender(pcm, TARGET_RATE),
      });
    }
  };
  src.connect(proc);
  // ScriptProcessor 는 destination 에 연결돼야 콜백이 돎. 무음 gain 으로 하울링 방지
  const mute = ctx.createGain();
  mute.gain.value = 0;
  proc.connect(mute).connect(ctx.destination);

  return {
    ctx,
    /** TTS 재생 중엔 자기 목소리를 다시 번역하지 않게 멈춤 */
    pause() { paused = true; vad.reset(); },
    resume() { paused = false; },
    get paused() { return paused; },
    stop() {
      proc.disconnect(); src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
    },
  };
}
