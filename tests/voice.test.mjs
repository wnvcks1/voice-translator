import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceFeatures, VoiceProfiles } from '../voice.js';

const SR = 16000;
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/**
 * 사람 목소리 흉내: 성문 펄스(떨림 포함) → 포먼트 공명 3개 → 음절 강약 → 잡음.
 * 화자마다 음높이(f0)와 포먼트(성도 길이·모양 = 음색)가 다름. 모음이 바뀌는 것도 흉내 내려고 포먼트를 천천히 흔듦.
 */
function speaker(f0, formants, sec, seed, noise = 0.004, gain = 1) {
  const r = rng(seed);
  const n = Math.round(SR * sec);
  const out = new Float32Array(n);
  let t = 0;
  const st = formants.map(() => [0, 0]);
  for (let i = 0; i < n; i++) {
    let x = 0;
    if (i >= t) { x = 1; t += (SR / (f0 * (1 + 0.08 * Math.sin(i / 2500)))) * (1 + 0.02 * r()); }
    let y = x;
    formants.forEach(([f, bw], k) => {
      const ff = f * (1 + 0.12 * Math.sin(i / (1300 + 400 * k) + k));
      const R = Math.exp(-Math.PI * bw / SR);
      const a1 = 2 * R * Math.cos(2 * Math.PI * ff / SR), a2 = -R * R;
      const v = y + a1 * st[k][0] + a2 * st[k][1];
      st[k][1] = st[k][0]; st[k][0] = v;
      y = v * 0.5;
    });
    const env = 0.55 + 0.45 * Math.sin((2 * Math.PI * 4 * i) / SR);
    out[i] = gain * 0.05 * env * y + noise * r();
  }
  return out;
}

// 남성 둘(음높이 비슷, 음색 다름) + 여성 하나
const MAN_A = (sec, seed, ...o) => speaker(115, [[600, 90], [1100, 110], [2500, 160]], sec, seed, ...o);
const MAN_B = (sec, seed, ...o) => speaker(125, [[760, 90], [1450, 110], [2900, 160]], sec, seed, ...o);
const WOMAN = (sec, seed) => speaker(215, [[850, 100], [1650, 120], [3000, 170]], sec, seed);

test('voiceFeatures: 13차원, 음높이 반음값, 짧으면 null', () => {
  const f = voiceFeatures(MAN_A(1.2, 1), SR);
  assert.equal(f.vec.length, 13);
  assert.ok(Math.abs(f.f0 - 115) < 12, `f0 ${f.f0}`);
  assert.equal(voiceFeatures(new Float32Array(1000), SR), null);
});

test('VoiceProfiles: 남(나) vs 여(상대) — 두 번씩 배우면 새 발화를 맞힘', () => {
  const p = new VoiceProfiles();
  assert.equal(p.classify(voiceFeatures(MAN_A(1, 1), SR)).side, null, '배우기 전엔 판단 보류');
  p.learn('left', voiceFeatures(MAN_A(1.2, 2), SR));
  p.learn('left', voiceFeatures(MAN_A(1.5, 3), SR));
  p.learn('right', voiceFeatures(WOMAN(1.2, 4), SR));
  p.learn('right', voiceFeatures(WOMAN(1.0, 5), SR));
  for (let s = 10; s < 16; s++) {
    const m = p.classify(voiceFeatures(MAN_A(0.6, s), SR));
    const w = p.classify(voiceFeatures(WOMAN(0.6, s + 50), SR));
    assert.equal(m.side, 'left', `남 ${s} ${JSON.stringify(m)}`);
    assert.equal(w.side, 'right', `여 ${s} ${JSON.stringify(w)}`);
    assert.ok(m.conf > 0.25 && w.conf > 0.25, `확신도 ${m.conf.toFixed(2)} ${w.conf.toFixed(2)}`);
  }
  assert.ok(Math.abs(p.pitch('left') - 115) < 12 && Math.abs(p.pitch('right') - 215) < 20);
});

test('VoiceProfiles: 혼자 두 언어로 말하면(같은 목소리) 판정 안 함 — 언어를 사람으로 오인 금지', () => {
  const p = new VoiceProfiles();
  for (let s = 0; s < 3; s++) {
    p.learn('left', voiceFeatures(MAN_A(1.2, 100 + s), SR));
    p.learn('right', voiceFeatures(MAN_A(1.2, 200 + s), SR));
  }
  assert.equal(p.separable(), false);
  assert.equal(p.classify(voiceFeatures(MAN_A(0.6, 300), SR)).side, null);
});

test('VoiceProfiles: 음높이 비슷한 남자 둘도 판정 안 함 (오판보다 보류)', () => {
  const p = new VoiceProfiles();
  for (let s = 0; s < 3; s++) {
    p.learn('left', voiceFeatures(MAN_A(1.2, 100 + s), SR));
    p.learn('right', voiceFeatures(MAN_B(1.2, 200 + s), SR));
  }
  assert.equal(p.separable(), false);
  assert.equal(p.classify(voiceFeatures(MAN_B(0.6, 400), SR)).conf, 0);
});

test('VoiceProfiles: 쪽마다 최근 12개만 기억', () => {
  const p = new VoiceProfiles();
  const f = voiceFeatures(MAN_A(1, 1), SR);
  for (let i = 0; i < 20; i++) p.learn('left', f);
  assert.equal(p.sides.left.length, 12);
  p.learn('right', null);
  assert.equal(p.sides.right.length, 0);
});

test('VoiceProfiles: 시끄러운 식당(잡음 크고 상대가 멀어 작게 들림)에서도 남녀는 구분', () => {
  for (const noise of [0.02, 0.03]) {
    const p = new VoiceProfiles();
    for (let s = 0; s < 3; s++) {
      p.learn('left', voiceFeatures(MAN_A(1.2, 100 + s, noise, 0.6), SR));
      p.learn('right', voiceFeatures(WOMAN(1.2, 200 + s), SR));
    }
    let ok = 0;
    for (let s = 0; s < 10; s++) {
      ok += p.classify(voiceFeatures(MAN_A(0.6, 300 + s, noise, 0.6), SR)).side === 'left';
      ok += p.classify(voiceFeatures(WOMAN(0.6, 400 + s), SR)).side === 'right';
    }
    assert.ok(ok >= 19, `noise ${noise}: ${ok}/20`);
  }
});

test('VoiceProfiles: 한 번씩만 배워도 남녀는 가름 (대화 시작 직후)', () => {
  const p = new VoiceProfiles();
  p.learn('left', voiceFeatures(MAN_A(1.2, 7), SR));
  assert.equal(p.ready, false);
  p.learn('right', voiceFeatures(WOMAN(1.2, 8), SR));
  assert.equal(p.ready, true);
  for (let s = 20; s < 25; s++) {
    const m = p.classify(voiceFeatures(MAN_A(0.6, s), SR));
    const w = p.classify(voiceFeatures(WOMAN(0.6, s + 9), SR));
    assert.ok(m.side === 'left' && m.conf >= 0.3, JSON.stringify(m));
    assert.ok(w.side === 'right' && w.conf >= 0.3, JSON.stringify(w));
  }
});
