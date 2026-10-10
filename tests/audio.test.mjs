import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, estimateGender, createVad, encodeWav, resample, rmsDb, concat, Downsampler } from '../audio.js';

const SR = 16000;

/** 결정적 난수 (테스트 재현성) */
function rng(seed = 1) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/**
 * 성대 진동 흉내: 배음 합성 + 비브라토 + 잡음.
 * @param {number} f0
 * @param {number} sec
 * @param {{amp?:number, noise?:number, harmonics?:number[], vibrato?:number}} o
 */
function voice(f0, sec, o = {}) {
  const n = Math.round(SR * sec);
  const out = new Float32Array(n);
  const amp = o.amp ?? 0.3;
  const hs = o.harmonics ?? [1, 0.6, 0.45, 0.3, 0.2, 0.12, 0.08];
  const r = rng(Math.round(f0));
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = f0 * (1 + (o.vibrato ?? 0.03) * Math.sin((2 * Math.PI * 5 * i) / SR));
    // 음절 흉내: 초당 4번 음량이 출렁임
    const env = o.syll === false ? 1 : 0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / SR);
    phase += (2 * Math.PI * f) / SR;
    let s = 0;
    hs.forEach((h, k) => { s += h * Math.sin((k + 1) * phase); });
    out[i] = amp * env * (s / hs.length) + (o.noise ?? 0.005) * r();
  }
  return out;
}

const noise = (sec, a = 0.003) => { const r = rng(7); return Float32Array.from({ length: Math.round(SR * sec) }, () => a * r()); };

test('detectPitch: 순음 F0 를 3% 이내로 맞춤', () => {
  for (const f of [90, 120, 150, 200, 250, 320]) {
    const fr = voice(f, 0.04, { vibrato: 0, noise: 0, syll: false });
    const p = detectPitch(fr, SR);
    assert.ok(p, `${f}Hz null`);
    assert.ok(Math.abs(p.f0 - f) / f < 0.03, `${f}Hz → ${p.f0}`);
  }
});

test('detectPitch: 무음·백색잡음은 null 또는 낮은 clarity', () => {
  assert.equal(detectPitch(new Float32Array(640), SR), null);
  const p = detectPitch(noise(0.04, 0.3), SR);
  assert.ok(!p || p.clarity < 0.6);
});

test('estimateGender: 남성 음역', () => {
  for (const f of [95, 115, 135]) assert.equal(estimateGender(voice(f, 1.2), SR).gender, 'male', `${f}Hz`);
});

test('estimateGender: 여성 음역', () => {
  for (const f of [195, 220, 250]) assert.equal(estimateGender(voice(f, 1.2), SR).gender, 'female', `${f}Hz`);
});

test('estimateGender: 2배음이 기본음보다 강해도 옥타브 오류 없음 (남성 110Hz)', () => {
  const g = estimateGender(voice(110, 1.2, { harmonics: [0.3, 1, 0.7, 0.4, 0.2] }), SR);
  assert.equal(g.gender, 'male', `f0=${g.f0}`);
});

test('estimateGender: 기본음 누락(전화 대역 흉내)에도 남성 판정', () => {
  const g = estimateGender(voice(120, 1.2, { harmonics: [0, 0, 1, 0.8, 0.6, 0.4] }), SR);
  assert.equal(g.gender, 'male', `f0=${g.f0}`);
});

/** 실제 목소리에 가깝게: 주기 흔들림(jitter)·음량 흔들림·성도 공명(간이 필터)·잡음 */
function realish(f0, sec, seed = 3, noise = 0.01, jit = 0.02) {
  const r = rng(seed);
  const n = Math.round(SR * sec);
  const out = new Float32Array(n);
  let t = 0, period = SR / f0;
  // 성문 펄스열 → 2차 공명 필터 2개(포먼트 ~700Hz, ~1200Hz)
  let y1 = 0, y2 = 0, z1 = 0, z2 = 0;
  const reson = (f, bw) => { const R = Math.exp(-Math.PI * bw / SR); return [2 * R * Math.cos(2 * Math.PI * f / SR), -R * R]; };
  const [a1, a2] = reson(700, 120), [b1, b2] = reson(1200, 150);
  for (let i = 0; i < n; i++) {
    let x = 0;
    if (i >= t) { x = 1; period = (SR / f0) * (1 + jit * r()); t += period; }
    const y = x + a1 * y1 + a2 * y2; y2 = y1; y1 = y;
    const z = y + b1 * z1 + b2 * z2; z2 = z1; z1 = z;
    const env = 0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / SR);
    out[i] = 0.02 * env * z + noise * r();
  }
  return out;
}

test('estimateGender: 흔들림·공명·잡음 심한 목소리도 판정, 한 옥타브 아래로 안 틀림 (v0.1 실측 "피치?" 대응)', () => {
  // v0.1 판정기는 jitter 6%·잡음 0.06 에서 98/125Hz 를 unknown, 215Hz 를 male 로 틀렸음
  for (const [f0, want] of [[98, 'male'], [125, 'male'], [215, 'female']]) {
    for (const [noise, jit] of [[0.01, 0.02], [0.06, 0.06], [0.1, 0.06]]) {
      const g = estimateGender(realish(f0, 1.5, 7, noise, jit), SR);
      assert.equal(g.gender, want, `${f0}Hz noise ${noise} jit ${jit} → ${g.f0}`);
      assert.ok(Math.abs(g.f0 - f0) / f0 < 0.08, `${f0}Hz noise ${noise} jit ${jit} → f0 ${g.f0}`);
    }
  }
});

test('estimateGender: 경계 구간(170Hz)은 판단 보류, 잡음만이면 unknown', () => {
  assert.equal(estimateGender(voice(170, 1.2, { vibrato: 0.01 }), SR).gender, 'unknown');
  assert.equal(estimateGender(noise(1), SR).gender, 'unknown');
  assert.equal(estimateGender(new Float32Array(0), SR).gender, 'unknown');
});

/** 신호를 VAD 프레임으로 쪼개 넣고 이벤트 수집 */
function runVad(sig, cfg = {}) {
  const frameLen = 683; // 48kHz 2048 샘플을 16kHz 로 줄인 크기
  const vad = createVad({ frameMs: (frameLen / SR) * 1000, ...cfg });
  const ev = [];
  for (let i = 0; i + frameLen <= sig.length; i += frameLen) {
    const e = vad.push(sig.subarray(i, i + frameLen));
    if (e.type !== 'none') ev.push({ ...e, at: i / SR });
  }
  return ev;
}

test('VAD: 잡음 → 말 1.5초 → 침묵이면 start/end 한 쌍, 말 전체 포함', () => {
  const sig = concat([noise(1), voice(130, 1.5), noise(1.5)]);
  const ev = runVad(sig);
  assert.deepEqual(ev.map((e) => e.type), ['start', 'end']);
  const dur = concat(ev[1].frames).length / SR;
  assert.ok(dur >= 1.5 && dur < 2.6, `dur ${dur}`);
  assert.ok(ev[0].at > 0.9 && ev[0].at < 1.3, `start ${ev[0].at}`);
});

test('VAD: 짧은 기침(0.2초)은 discard', () => {
  const sig = concat([noise(1), voice(300, 0.2, { amp: 0.5 }), noise(1.5)]);
  const types = runVad(sig).map((e) => e.type);
  assert.ok(!types.includes('end'), types.join(','));
});

test('VAD: 말 중간 0.3초 쉼은 한 문장으로 유지, 1초 쉼은 둘로 분리', () => {
  const one = runVad(concat([noise(1), voice(200, 1), noise(0.3), voice(200, 1), noise(1.5)]));
  assert.equal(one.filter((e) => e.type === 'end').length, 1);
  const two = runVad(concat([noise(1), voice(200, 1), noise(1.2), voice(200, 1), noise(1.5)]));
  assert.equal(two.filter((e) => e.type === 'end').length, 2);
});

test('VAD: 최대 길이 넘으면 강제로 끊음', () => {
  const ev = runVad(concat([noise(1), voice(150, 6), noise(1)]), { maxMs: 2500 });
  assert.ok(ev.filter((e) => e.type === 'end').length >= 2);
});

test('VAD: 시끄러운 배경(-35dB)에서도 바닥이 따라가서 말 감지', () => {
  const sig = concat([noise(2, 0.03), voice(140, 1.5, { amp: 0.6, noise: 0.03 }), noise(1.5, 0.03)]);
  const snr = rmsDb(voice(140, 1.5, { amp: 0.6, noise: 0 })) - rmsDb(noise(1, 0.03));
  assert.ok(snr < 16, `SNR ${snr.toFixed(1)}dB — 식당 수준이어야 의미 있음`);
  assert.deepEqual(runVad(sig).map((e) => e.type), ['start', 'end']);
});

test('encodeWav: 헤더·길이·클리핑', () => {
  const w = encodeWav(Float32Array.from([0, 1, -1, 2]), SR);
  const v = new DataView(w.buffer);
  assert.equal(String.fromCharCode(...w.subarray(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...w.subarray(8, 12)), 'WAVE');
  assert.equal(v.getUint32(24, true), SR);
  assert.equal(v.getUint32(40, true), 8);
  assert.equal(w.length, 52);
  assert.equal(v.getInt16(46, true), 32767);
  assert.equal(v.getInt16(48, true), -32768);
  assert.equal(v.getInt16(50, true), 32767);
});

test('resample: 48k→16k 길이와 주파수 보존', () => {
  const n = 48000;
  const x = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 150 * i) / 48000));
  const y = resample(x, 48000, 16000);
  assert.equal(y.length, 16000);
  const p = detectPitch(y.subarray(0, 640), SR);
  assert.ok(Math.abs(p.f0 - 150) < 3);
  assert.ok(rmsDb(y) > -4 && rmsDb(y) < -2);
});

test('VAD: 켜는 도중 소음이 갑자기 커져 계속돼도 최대 길이 1번 끊긴 뒤 멈춤', () => {
  const ev = runVad(concat([noise(1, 0.002), noise(12, 0.05)]), { maxMs: 3000 });
  assert.ok(ev.filter((e) => e.type === 'end' || e.type === 'discard').length <= 1, ev.map((e) => e.type).join(','));
});

test('VAD: 마이크 재연결 직후 완전 무음 프레임이 와도 다음 말이 정상 길이로 끝남', () => {
  const sig = concat([noise(1), new Float32Array(SR * 0.5), voice(200, 1.2), noise(2)]);
  const ev = runVad(sig);
  const end = ev.find((e) => e.type === 'end');
  assert.ok(end, ev.map((e) => e.type).join(','));
  const dur = concat(end.frames).length / SR;
  assert.ok(dur < 2.4, `dur ${dur}`);
});

test('VAD: 말 끝나자 배경 소음이 커져도(폰 자동 음량) 문장이 끝남', () => {
  // 조용한 방(-55dB) → 말 → 쉬는 틈에 AGC 가 소음을 -40dB 대로 키움. 바닥+6dB 기준만으론 영원히 '말하는 중'
  const sig = concat([noise(1, 0.002), voice(130, 1.5, { amp: 0.5 }), noise(4, 0.012)]);
  const ev = runVad(sig);
  const end = ev.find((e) => e.type === 'end');
  assert.ok(end, ev.map((e) => e.type).join(','));
  const dur = concat(end.frames).length / SR;
  assert.ok(dur < 3, `dur ${dur}`);
  // 끝난 뒤 커진 소음을 새 말로 오인하지 않음
  assert.equal(ev.filter((e) => e.type === 'start').length, 1, ev.map((e) => e.type).join(','));
});

const tone48 = (f, sec) => Float32Array.from({ length: Math.round(48000 * sec) }, (_, i) => Math.sin((2 * Math.PI * f * i) / 48000));

test('Downsampler: 말소리 대역(1kHz)은 그대로, 8kHz 넘는 소리는 접혀 들어오지 않음', () => {
  const pass = new Downsampler(48000).process(tone48(1000, 1)).subarray(200);
  assert.ok(Math.abs(rmsDb(pass) - -3.01) < 0.3, `1kHz ${rmsDb(pass).toFixed(2)}dB`);
  // 10kHz 는 16k 변환 뒤 6kHz 로 접혀 들어옴(앨리어싱). 예전 선형 방식과 비교
  const hi = tone48(10000, 1);
  const newDb = rmsDb(new Downsampler(48000).process(hi).subarray(200));
  const oldDb = rmsDb(resample(hi, 48000, 16000).subarray(200));
  assert.ok(newDb < -50, `새 방식 10kHz 잔여 ${newDb.toFixed(1)}dB`);
  assert.ok(oldDb > -15, `예전 방식은 ${oldDb.toFixed(1)}dB 로 거의 그대로 섞였음`);
});

test('Downsampler: 조각으로 나눠 넣어도 한 번에 넣은 것과 같음, 44.1k 도 길이 맞음', () => {
  const x = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 7) * 0.5 + Math.sin(i / 31) * 0.3);
  const whole = new Downsampler(48000).process(x);
  const d = new Downsampler(48000);
  const parts = concat([0, 2048, 4096, 10000, 30000].map((a, k, arr) => d.process(x.subarray(a, arr[k + 1] ?? x.length))));
  assert.equal(parts.length, whole.length);
  let maxDiff = 0;
  for (let i = 0; i < whole.length; i++) maxDiff = Math.max(maxDiff, Math.abs(whole[i] - parts[i]));
  assert.ok(maxDiff < 1e-6, `차이 ${maxDiff}`);
  assert.ok(Math.abs(whole.length - 16000) <= 1);
  const d44 = new Downsampler(44100);
  let n = 0;
  for (let i = 0; i < 44100; i += 2048) n += d44.process(new Float32Array(Math.min(2048, 44100 - i))).length;
  assert.ok(Math.abs(n - 16000) <= 1, `44.1k → ${n}`);
});

test('Downsampler: 변환 뒤에도 음높이 판정 유지 (남 110Hz)', () => {
  const x = Float32Array.from({ length: 48000 }, (_, i) => {
    const ph = (2 * Math.PI * 110 * i) / 48000;
    return 0.3 * (Math.sin(ph) + 0.6 * Math.sin(2 * ph) + 0.4 * Math.sin(3 * ph));
  });
  const g = estimateGender(new Downsampler(48000).process(x), SR);
  assert.equal(g.gender, 'male');
  assert.ok(Math.abs(g.f0 - 110) < 3, `f0 ${g.f0}`);
});
