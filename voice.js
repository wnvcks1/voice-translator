/* 화자 구분: 목소리 특징(음높이 + 음색 MFCC 평균)을 대화 중에 배워서 '나(왼쪽)'와 '상대(오른쪽)'를 가름.
   언어(글자 종류)로 확실히 갈리는 말에서 배우고, '네'·'OK'·숫자처럼 언어로 애매한 짧은 말에 씀. */

import { detectPitch, rmsDb } from './audio.js';

const N_FFT = 512;
const N_MEL = 26;
const N_CEP = 13;

/**
 * 제자리 radix-2 FFT.
 * @param {Float64Array} re
 * @param {Float64Array} im
 */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

const mel = (f) => 2595 * Math.log10(1 + f / 700);
const imel = (m) => 700 * (10 ** (m / 2595) - 1);
let bankCache = null;
/**
 * 멜 필터뱅크 (16kHz, 80~7600Hz).
 * @param {number} sr
 * @returns {Float64Array[]}
 */
function melBank(sr) {
  if (bankCache?.sr === sr) return bankCache.bank;
  const lo = mel(80), hi = mel(Math.min(7600, sr / 2 - 100));
  const pts = Array.from({ length: N_MEL + 2 }, (_, i) => imel(lo + ((hi - lo) * i) / (N_MEL + 1)));
  const bin = pts.map((f) => Math.floor(((N_FFT + 1) * f) / sr));
  const bank = [];
  for (let m = 1; m <= N_MEL; m++) {
    const w = new Float64Array(N_FFT / 2 + 1);
    for (let k = bin[m - 1]; k < bin[m]; k++) w[k] = (k - bin[m - 1]) / Math.max(1, bin[m] - bin[m - 1]);
    for (let k = bin[m]; k < bin[m + 1]; k++) w[k] = (bin[m + 1] - k) / Math.max(1, bin[m + 1] - bin[m]);
    bank.push(w);
  }
  bankCache = { sr, bank };
  return bank;
}

/**
 * 한 발화의 목소리 특징 벡터: [log 음높이, MFCC 1~12 평균]. 말소리가 너무 적으면 null.
 * @param {Float32Array} pcm 16kHz mono
 * @param {number} sr
 * @returns {{vec:number[], f0:number|null, frames:number}|null}
 */
export function voiceFeatures(pcm, sr) {
  const win = Math.round(sr * 0.025), hop = Math.round(sr * 0.01);
  if (pcm.length < win * 10) return null;
  let peak = -120;
  for (let i = 0; i + win <= pcm.length; i += hop) peak = Math.max(peak, rmsDb(pcm.subarray(i, i + win)));
  const bank = melBank(sr);
  const hann = Float64Array.from({ length: win }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1)));
  const sum = new Float64Array(N_CEP);
  let frames = 0;
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
  const logE = new Float64Array(N_MEL);
  for (let i = 0; i + win <= pcm.length; i += hop) {
    const fr = pcm.subarray(i, i + win);
    // 말소리 구간만: 최고 음량 대비 -25dB 이내
    if (rmsDb(fr) < peak - 25) continue;
    re.fill(0); im.fill(0);
    for (let k = 0; k < win; k++) re[k] = (fr[k] - (k ? 0.97 * fr[k - 1] : 0)) * hann[k];
    fft(re, im);
    for (let m = 0; m < N_MEL; m++) {
      let e = 0;
      const w = bank[m];
      for (let k = 0; k <= N_FFT / 2; k++) if (w[k]) e += w[k] * (re[k] * re[k] + im[k] * im[k]);
      logE[m] = Math.log(e + 1e-10);
    }
    for (let c = 0; c < N_CEP; c++) {
      let v = 0;
      for (let m = 0; m < N_MEL; m++) v += logE[m] * Math.cos((Math.PI * c * (m + 0.5)) / N_MEL);
      sum[c] += v;
    }
    frames++;
  }
  if (frames < 8) return null;

  // 음높이: 40ms 창 중앙값
  const pw = Math.round(sr * 0.04);
  const f0s = [];
  for (let i = 0; i + pw <= pcm.length; i += Math.round(sr * 0.02)) {
    const fr = pcm.subarray(i, i + pw);
    if (rmsDb(fr) < peak - 30) continue;
    const p = detectPitch(fr, sr);
    if (p && p.clarity > 0.55) f0s.push(p.f0);
  }
  f0s.sort((a, b) => a - b);
  const f0 = f0s.length >= 4 ? f0s[f0s.length >> 1] : null;
  // c0(전체 음량)은 거리에 따라 바뀌므로 뺌. 음높이는 반음 단위(로그)로 맞춤
  const cep = Array.from(sum.slice(1), (v) => v / frames);
  return { vec: [f0 ? 12 * Math.log2(f0 / 100) : NaN, ...cep], f0, frames };
}

/**
 * 두 사람(left=나, right=상대)의 목소리 프로필을 대화 중에 배우고 새 소리가 누구 것인지 판정.
 */
export class VoiceProfiles {
  constructor() {
    this.sides = { left: [], right: [] };
    this.max = 12; // 쪽마다 최근 12개 발화만 (자리 바뀜·목소리 변화 따라감)
  }

  /**
   * 확실한 발화(언어로 쪽이 정해진 것)로 학습.
   * @param {'left'|'right'} side
   * @param {{vec:number[]}|null} feat
   */
  learn(side, feat) {
    if (!feat) return;
    const arr = this.sides[side];
    arr.push(feat.vec);
    if (arr.length > this.max) arr.shift();
  }

  /** @returns {boolean} 양쪽 다 1개 이상 배워서 판정 가능 (확신도 문턱이 오판을 막음) */
  get ready() {
    return this.sides.left.length >= 1 && this.sides.right.length >= 1;
  }

  /**
   * 차원별 표준편차(양쪽 전체) — 음높이(반음)와 MFCC 의 크기 차이를 맞추려고 씀.
   * @returns {number[]}
   */
  scales() {
    const all = [...this.sides.left, ...this.sides.right];
    const d = all[0].length;
    const out = [];
    for (let j = 0; j < d; j++) {
      const xs = all.map((v) => v[j]).filter((x) => Number.isFinite(x));
      const m = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
      const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length));
      out.push(Math.max(sd, j === 0 ? 1.5 : 0.5));
    }
    return out;
  }

  /**
   * @param {{vec:number[]}|null} feat
   * @returns {{side:'left'|'right'|null, conf:number, d:{left:number,right:number}|null}}
   *   conf 0~1: (먼 거리-가까운 거리)/(합). 0.25 이상이면 꽤 확실
   */
  classify(feat) {
    if (!feat || !this.ready) return { side: null, conf: 0, d: null };
    const sc = this.scales();
    const mean = (arr) => sc.map((_, j) => {
      const xs = arr.map((v) => v[j]).filter((x) => Number.isFinite(x));
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
    });
    const dist = (c) => {
      let s = 0, n = 0;
      feat.vec.forEach((x, j) => {
        if (!Number.isFinite(x) || !Number.isFinite(c[j])) return;
        // 음높이는 남녀를 가르는 가장 강한 단서라 가중치 2배
        const w = j === 0 ? 2 : 1;
        s += w * ((x - c[j]) / sc[j]) ** 2; n += w;
      });
      return n ? Math.sqrt(s / n) : Infinity;
    };
    const d = { left: dist(mean(this.sides.left)), right: dist(mean(this.sides.right)) };
    const side = d.left <= d.right ? 'left' : 'right';
    const conf = Math.abs(d.left - d.right) / (d.left + d.right || 1);
    return { side, conf, d };
  }

  /**
   * 한쪽의 대표 음높이 (성별 판정 안정화용).
   * @param {'left'|'right'} side
   * @returns {number|null} Hz
   */
  pitch(side) {
    const xs = this.sides[side].map((v) => v[0]).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return xs.length ? 100 * 2 ** (xs[xs.length >> 1] / 12) : null;
  }
}
