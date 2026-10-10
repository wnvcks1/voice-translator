/* 마이크 입력(통화 모드) → 발화 구간 감지(VAD) → 16kHz WAV + 피치 기반 성별 추정.
   순수 함수·클래스(Downsampler, detectPitch, estimateGender, createVad, encodeWav)는 node 테스트 대상. */

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
 * 앨리어싱 없는 실시간 다운샘플러 (48k/44.1k → 16k).
 * 그냥 건너뛰며 줄이면 8kHz 넘는 소리(식기 소리·쉿 소리)가 말소리 대역으로 접혀 들어와 인식이 나빠짐
 * (v0.3 까지의 선형 보간 방식이 그랬음). 먼저 저역통과 FIR 로 거르고 출력 위치에서만 계산함.
 * 조각 단위로 넣어도 이어 붙인 결과가 한 번에 처리한 것과 같도록 앞 조각 꼬리를 기억함.
 */
export class Downsampler {
  /**
   * @param {number} fromRate
   * @param {number} [toRate]
   * @param {number} [taps] 홀수
   * @param {number} [cutoff] Hz
   */
  constructor(fromRate, toRate = TARGET_RATE, taps = 127, cutoff = 6800) {
    this.ratio = fromRate / toRate;
    this.taps = taps;
    const h = new Float32Array(taps);
    const fc = cutoff / fromRate;
    const mid = (taps - 1) / 2;
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const x = i - mid;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      // Blackman 창: 저지대역 감쇠 ~-74dB
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
      h[i] = sinc * w;
      sum += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= sum;
    this.h = h;
    this.hist = new Float32Array(taps);
    this.pos = 0;
  }

  /**
   * @param {Float32Array} input
   * @returns {Float32Array}
   */
  process(input) {
    if (this.ratio === 1) return Float32Array.from(input);
    const { taps, h } = this;
    const buf = new Float32Array(taps + input.length);
    buf.set(this.hist);
    buf.set(input, taps);
    const fir = (n) => {
      let y = 0;
      for (let k = 0; k < taps; k++) y += h[k] * buf[n - k];
      return y;
    };
    const out = [];
    for (;;) {
      const p = this.pos + taps;
      const i0 = Math.floor(p);
      if (i0 + 1 >= buf.length) break;
      const t = p - i0;
      out.push(t ? fir(i0) * (1 - t) + fir(i0 + 1) * t : fir(i0));
      this.pos += this.ratio;
    }
    this.pos -= input.length;
    this.hist = buf.slice(buf.length - taps);
    return Float32Array.from(out);
  }
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
export function detectPitch(frame, sampleRate, minHz = 60, maxHz = 400) {
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

  // 1차: 문턱 아래 첫 골짜기. 2차: 실제 목소리(잡음 제거·압축 거친 소리)는 문턱을 못 넘기도 해서 전체 최솟값으로 보완
  const threshold = 0.2;
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (cmnd[lag] < threshold) {
      while (lag + 1 <= maxLag && cmnd[lag + 1] < cmnd[lag]) lag++;
      best = lag;
      break;
    }
  }
  if (best < 0) {
    let min = Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) if (cmnd[lag] < min) min = cmnd[lag];
    if (min > 0.45) return null;
    // 전체 최솟값은 2배 주기(한 옥타브 아래)에 걸리기 쉬움 → 최솟값과 비슷한 골짜기 중 가장 짧은 주기를 택함
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (cmnd[lag] <= min + 0.06 && cmnd[lag] <= cmnd[lag - 1] && cmnd[lag] <= cmnd[lag + 1]) { best = lag; break; }
    }
  }

  // 한 옥타브 위 오류 보정: 폰 마이크는 남자 목소리의 기본음(~100Hz)을 약하게 잡아 2배음이 주기처럼 보임
  // (v0.6 실측: 남자 목소리가 192·198Hz 로 재져 여자로 판정). 2배 주기에서 주기성이 확연히 더 좋으면 그쪽이 진짜.
  // 진짜 고음(여자)은 2배 주기 주기성이 비슷한 수준이라 안 바뀜
  const t2 = best * 2;
  if (t2 + 2 <= maxLag) {
    let b2 = t2;
    for (let l = t2 - 2; l <= t2 + 2; l++) if (cmnd[l] < cmnd[b2]) b2 = l;
    if (cmnd[b2] < cmnd[best] * 0.5) best = b2;
  }

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
    if (p && p.clarity > 0.55) f0s.push(p.f0);
  }
  if (f0s.length < 4) return { gender: 'unknown', f0: null, voicedFrames: f0s.length };
  f0s.sort((a, b) => a - b);
  const f0 = f0s[Math.floor(f0s.length / 2)];
  const gender = f0 <= maleMax ? 'male' : f0 >= femaleMin ? 'female' : 'unknown';
  return { gender, f0, voicedFrames: f0s.length };
}

/**
 * 에너지 기반 VAD 상태기계. 프레임을 넣으면 이벤트를 돌려줌.
 * 잡음 바닥(noise floor)을 적응 추적해서 시끄러운 식당에서도 기준이 따라감.
 * 말 끝 판정은 두 기준 중 하나만 맞아도 '조용함': 바닥+endDb 아래, 또는 이번 말의 최고 음량-dropDb 아래.
 * 두 번째 기준이 없으면 폰 자동 음량(AGC)이 쉬는 틈에 배경 소음을 키울 때 말이 끝나지 않음 (v0.2 실측 "듣는 중" 고정).
 * @param {{frameMs:number, startDb?:number, endDb?:number, dropDb?:number, startFrames?:number,
 *          silenceMs?:number, maxMs?:number, minSpeechMs?:number, preRollMs?:number}} cfg
 */
export function createVad(cfg) {
  const frameMs = cfg.frameMs;
  const startDb = cfg.startDb ?? 10;
  const endDb = cfg.endDb ?? 6;
  const dropDb = cfg.dropDb ?? 15;
  const startFrames = cfg.startFrames ?? 3;
  const silenceFrames = Math.ceil((cfg.silenceMs ?? 700) / frameMs);
  const maxFrames = Math.ceil((cfg.maxMs ?? 12000) / frameMs);
  const minSpeechFrames = Math.ceil((cfg.minSpeechMs ?? 350) / frameMs);
  const preRoll = Math.ceil((cfg.preRollMs ?? 300) / frameMs);

  const calibFrames = cfg.calibFrames ?? 8;
  let floor = -60;
  let seen = 0;
  let inSpeech = false;
  let above = 0, quiet = 0, voiced = 0;
  let peak = -120, prevDb = -120;
  let pre = [];
  let buf = [];
  let dbs = [];

  const reset = () => { inSpeech = false; above = 0; quiet = 0; voiced = 0; buf = []; dbs = []; peak = -120; };

  return {
    get noiseFloor() { return floor; },
    get active() { return inSpeech; },
    reset() { reset(); pre = []; },
    /** 주변 소음 다시 측정 (마이크를 다시 잡은 뒤) */
    recalibrate() { reset(); pre = []; seen = 0; },
    /** @returns {Float32Array|null} 말하는 중이면 시작부터 지금까지 소리 */
    current() { return inSpeech && buf.length ? concat(buf) : null; },
    /**
     * @param {Float32Array} frame
     * @returns {{type:'none'|'start'|'end'|'discard', frames?:Float32Array[], db:number}}
     */
    push(frame) {
      const db = rmsDb(frame);
      // 마이크를 막 잡았을 때 들어오는 완전 무음(0) 프레임은 바닥 계산에서 뺌: 바닥이 -150dB 로 꺼지면
      // 평소 실내 소음도 말로 오인해 문장이 안 끝남 (v0.2 e2e 에서 2번째 문장이 11.7초로 늘어난 원인)
      if (db < -90) return { type: 'none', db };
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
          prevDb = db;
          buf = pre.slice();
          pre = [];
          voiced = above; quiet = 0;
          return { type: 'start', db };
        }
        return { type: 'none', db };
      }
      buf.push(frame);
      dbs.push(db);
      // 순간 튀는 소리 하나로 최고치가 올라가지 않게 연속 두 프레임 중 낮은 값으로 최고 음량 갱신
      peak = Math.max(peak, Math.min(db, prevDb));
      prevDb = db;
      const loud = db > floor + endDb && db > peak - dropDb;
      if (loud) { quiet = 0; voiced++; } else quiet++;
      if (quiet >= silenceFrames || buf.length >= maxFrames) {
        const frames = buf;
        const ok = voiced >= minSpeechFrames;
        // 최대 길이로 끊겼는데 음량 변화가 거의 없으면 말이 아니라 소음(환풍기·차량)이 커진 것 → 바닥을 올림.
        // 말소리는 음절마다 음량이 출렁여서 표준편차가 큼
        if (quiet < silenceFrames) {
          const mean = dbs.reduce((x, y) => x + y, 0) / dbs.length;
          const sd = Math.sqrt(dbs.reduce((x, y) => x + (y - mean) ** 2, 0) / dbs.length);
          if (sd < 3) floor = Math.max(floor, mean - 1);
        } else {
          // 말 끝 직후의 조용한 구간 = 지금의 배경 소음. AGC 로 커졌으면 바닥도 따라 올림 (작아지면 위에서 빠르게 내려감)
          const tail = dbs.slice(-silenceFrames);
          const tailMean = tail.reduce((x, y) => x + y, 0) / tail.length;
          floor = Math.max(floor, tailMean - 2);
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

// 오디오 전용 스레드에서 마이크 소리를 2048 샘플씩 모아 넘김. ScriptProcessor 는 화면 그리는 스레드에서 돌아서
// 화면이 바쁘면 소리 조각을 놓침 → 말 일부가 잘려 인식이 나빠짐
const WORKLET = `
class Cap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === 2048) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(2048); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('cap', Cap);
`;

/** 통화 수준 마이크 설정. 지원 안 하는 항목(voiceIsolation 등)은 브라우저가 무시함 */
export const CALL_AUDIO = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  voiceIsolation: true,
  channelCount: 1,
};

/**
 * 브라우저 마이크 캡처 (통화 모드). 저역 잡음 제거(85Hz 고역통과) → 오디오 스레드 수집 → 앨리어싱 없는 16kHz 변환
 * → 프레임 단위 VAD. 발화가 끝나면 onUtterance 호출.
 * @param {{onUtterance?:(u:{pcm:Float32Array, wav:Uint8Array, durationMs:number, gender:object})=>void,
 *          onFrame?:(frame:Float32Array)=>void, onLevel?:(db:number, floor:number, active:boolean)=>void,
 *          onSpeechStart?:()=>void, onDiscard?:()=>void, vad?:object, log?:(m:string)=>void}} handlers
 */
export async function startMic(handlers) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') await ctx.resume();
  const frameMs = (2048 / ctx.sampleRate) * 1000;
  const vad = createVad({ frameMs, ...(handlers.vad || {}) });
  const down = new Downsampler(ctx.sampleRate);
  let paused = false;
  let stream = null;
  let src = null;

  // 에어컨·차 진동 같은 낮은 웅웅거림 제거 (말소리 기본음 최저 ~85Hz 보다 아래)
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 85;
  hp.Q.value = 0.707;

  const onChunk = (raw) => {
    if (!src) return;
    const frame = down.process(raw);
    if (paused) { handlers.onLevel?.(rmsDb(frame), vad.noiseFloor, false); return; }
    handlers.onFrame?.(frame);
    const ev = vad.push(frame);
    // 화면 갱신 오류가 발화 처리를 막지 않게 격리
    try { handlers.onLevel?.(ev.db, vad.noiseFloor, vad.active); } catch { /* 표시만 실패 */ }
    if (ev.type === 'start') handlers.onSpeechStart?.();
    if (ev.type === 'discard') handlers.onDiscard?.();
    if (ev.type === 'end' && handlers.onUtterance) {
      const pcm = concat(ev.frames);
      handlers.onUtterance({
        pcm,
        wav: encodeWav(pcm, TARGET_RATE),
        durationMs: (pcm.length / TARGET_RATE) * 1000,
        gender: estimateGender(pcm, TARGET_RATE),
      });
    }
  };

  let capture;
  let engine = 'worklet';
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    capture = new AudioWorkletNode(ctx, 'cap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    capture.port.onmessage = (e) => onChunk(e.data);
  } catch {
    // 구형 브라우저: 화면 스레드 방식으로 대체
    engine = 'script';
    capture = ctx.createScriptProcessor(2048, 1, 1);
    capture.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
  }
  hp.connect(capture);
  // 처리 노드는 출력까지 이어져야 브라우저가 돌림. 무음 gain 으로 하울링 방지
  const mute = ctx.createGain();
  mute.gain.value = 0;
  capture.connect(mute).connect(ctx.destination);

  const acquire = async () => {
    stream = await navigator.mediaDevices.getUserMedia({ audio: CALL_AUDIO });
    src = ctx.createMediaStreamSource(stream);
    src.connect(hp);
    const st = stream.getAudioTracks()[0]?.getSettings?.() || {};
    handlers.log?.(`마이크: ${engine === 'worklet' ? '오디오 스레드' : '화면 스레드'} · ${ctx.sampleRate}Hz→16k(앨리어싱 필터) · 에코제거 ${st.echoCancellation ?? '?'} · 잡음제거 ${st.noiseSuppression ?? '?'} · 자동음량 ${st.autoGainControl ?? '?'} · 목소리분리 ${st.voiceIsolation ?? '미지원'}`);
  };
  const drop = () => {
    try { src?.disconnect(); } catch { /* 이미 끊김 */ }
    stream?.getTracks().forEach((t) => t.stop());
    stream = null; src = null;
  };
  await acquire();

  return {
    ctx,
    engine,
    /** 듣기 일시정지(음소거): 데이터만 버림 (마이크는 유지) */
    pause() { paused = true; vad.reset(); },
    resume() { paused = false; },
    get paused() { return paused; },
    /** 지금 말하는 중인 소리(시작 이후) — 실시간 모드 화자 판정용 */
    currentSpeech() { return vad.current(); },
    /** 마이크 장치를 완전히 놓음 */
    release() { paused = true; vad.reset(); drop(); },
    /** release 후 다시 잡음 */
    async reacquire() { if (!stream) await acquire(); vad.recalibrate(); paused = false; },
    get released() { return !stream; },
    stop() {
      drop();
      try { capture.disconnect(); } catch { /* 끊김 */ }
      ctx.close();
    },
  };
}
