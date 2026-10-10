import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, estimateGender, createVad, encodeWav, resample, rmsDb, concat } from '../audio.js';

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
