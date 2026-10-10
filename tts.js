/* 번역문 음성 재생. 기본은 폰 내장 TTS(무료·즉시), 옵션으로 Gemini AI 음성(자연스러움·느림). */

import { aiSpeech, AI_VOICES } from './gemini.js';

// 음성 이름으로 성별 추정. 목록에 없는 이름은 판단 보류 → 음높이로 구분
const FEMALE_HINT = /female|여성|女|yuna|sora|heami|sunhi|xiaoxiao|xiaoyi|xiaochen|huihui|yaoyao|ting-?ting|mei-?jia|sin-?ji|kyoko|samantha|monica|paulina/i;
const MALE_HINT = /(?<!fe)male|남성|男|minsu|injoon|hyunsu|yunxi|yunyang|yunjian|kangkang|otoya|daniel|jorge/i;

/**
 * 내장 TTS 음성 목록을 기다려서 받음 (Android Chrome 은 비동기 로딩).
 * @returns {Promise<SpeechSynthesisVoice[]>}
 */
export function loadVoices() {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve([]);
    const v = speechSynthesis.getVoices();
    if (v.length) return resolve(v);
    const t = setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
    speechSynthesis.addEventListener('voiceschanged', () => { clearTimeout(t); resolve(speechSynthesis.getVoices()); }, { once: true });
  });
}

/**
 * 언어·성별에 맞는 내장 음성을 고름. 이름으로 성별을 못 가리면 같은 음성 + 음높이(pitch)로 구분.
 * @param {SpeechSynthesisVoice[]} voices
 * @param {string} bcp 'zh-CN' 등
 * @param {'male'|'female'|'unknown'} gender
 * @param {{male?:string, female?:string}} [pinned] 설정에서 고른 voiceURI
 * @returns {{voice:SpeechSynthesisVoice|null, pitch:number, matched:boolean}}
 */
export function pickVoice(voices, bcp, gender, pinned = {}) {
  const lang = bcp.toLowerCase().replace('_', '-');
  const base = lang.split('-')[0];
  const norm = (v) => v.lang.toLowerCase().replace('_', '-');
  let pool = voices.filter((v) => norm(v) === lang);
  if (!pool.length) pool = voices.filter((v) => norm(v).startsWith(base));
  // 표준 중국어 요청인데 광둥어·대만 음성만 섞여 있으면 본토 음성 우선
  if (base === 'zh') pool.sort((a, b) => Number(/hk|yue|tw/i.test(norm(a))) - Number(/hk|yue|tw/i.test(norm(b))));
  if (!pool.length) return { voice: null, pitch: 1, matched: false };

  const g = gender === 'male' ? 'male' : 'female';
  const want = pinned[g] && pool.find((v) => v.voiceURI === pinned[g]);
  if (want) return { voice: want, pitch: 1, matched: true };

  const hint = g === 'male' ? MALE_HINT : FEMALE_HINT;
  const other = g === 'male' ? FEMALE_HINT : MALE_HINT;
  const hit = pool.find((v) => hint.test(`${v.name} ${v.voiceURI}`) && !other.test(`${v.name} ${v.voiceURI}`));
  if (hit) return { voice: hit, pitch: 1, matched: true };
  const neutral = pool.find((v) => !other.test(`${v.name} ${v.voiceURI}`)) || pool[0];
  // 대부분의 폰 기본 음성은 여성 → 남성은 음높이를 낮춰 흉내
  return { voice: neutral, pitch: g === 'male' ? 0.7 : 1.1, matched: false };
}

/**
 * 재생기. 한 번에 하나만 재생하고, 재생 전 onBusy(true) 로 마이크를 놓게 함.
 * 폰 음성이 시작조차 안 되면(음성 데이터 없음 등) AI 음성으로 자동 대체.
 */
export class Speaker {
  /**
   * @param {{onBusy:(busy:boolean)=>Promise<void>|void, getSettings:()=>object, onError?:(m:string)=>void}} o
   */
  constructor(o) {
    this.o = o;
    this.voices = [];
    this.queue = Promise.resolve();
    this.current = null;
    this.ctx = null;
    this.utt = null;
    loadVoices().then((v) => { this.voices = v; });
    if ('speechSynthesis' in window) speechSynthesis.addEventListener?.('voiceschanged', () => { this.voices = speechSynthesis.getVoices(); });
  }

  /** 재생용 AudioContext. 반드시 사용자 터치 안에서 처음 만들어야 Android 가 소리를 막지 않음 */
  audioCtx() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = null;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /**
   * 모든 번역 소리가 지나가는 음량 조절 노드. 통화 모드에선 폰 측면 버튼이 이 소리를 못 줄이는 기기가 있어
   * 앱 화면에서 직접 조절함.
   * @returns {GainNode}
   */
  out() {
    const ctx = this.audioCtx();
    if (!this.master) {
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
    }
    this.master.gain.value = this.volume();
    return this.master;
  }

  /** @returns {number} 0~1 */
  volume() {
    const v = Number(this.o.getSettings().volume);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.6;
  }

  /** 음량 바로 반영 */
  setVolume() {
    if (this.master) this.master.gain.value = this.volume();
  }

  /** 첫 재생은 사용자 터치 안에서 해야 Android 가 막지 않음 */
  unlock() {
    this.audioCtx();
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    this.utt = u;
    speechSynthesis.speak(u);
  }

  stop() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    try { this.current?.stop(); } catch { /* 이미 끝남 */ }
    this.current = null;
  }

  /**
   * @param {string} text
   * @param {string} bcp
   * @param {'male'|'female'|'unknown'} gender
   * @param {{preferAi?:boolean}} [opt] preferAi: 키가 있으면 AI 음성 먼저
   * @returns {Promise<{engine:string, voice:string, status:string}>}
   */
  say(text, bcp, gender, opt = {}) {
    const run = async () => {
      const s = this.o.getSettings();
      await this.o.onBusy(true);
      try {
        const canAi = s.key && s.ttsModel;
        if ((s.aiVoice || opt.preferAi) && canAi) {
          try {
            return await this.sayAi(text, gender, s);
          } catch (e) {
            this.o.onError?.(`AI 음성 실패 → 폰 음성으로: ${e.message}`);
          }
        }
        const r = await this.sayLocal(text, bcp, gender, s);
        if (r.status !== 'ok' && !s.aiVoice && canAi) {
          this.o.onError?.(`폰 음성 ${r.status} [${r.voice}] → AI 음성으로 대체`);
          try { return await this.sayAi(text, gender, s); } catch (e) { this.o.onError?.(`AI 음성도 실패: ${e.message}`); }
        }
        return r;
      } finally {
        // 스피커 잔향이 마이크에 다시 잡히지 않게 약간 쉼
        await new Promise((r) => setTimeout(r, 200));
        await this.o.onBusy(false);
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  /**
   * 폰 내장 TTS. 결과 status: ok | nostart(시작 안 됨) | error:<코드>
   */
  async sayLocal(text, bcp, gender, s) {
    if (!('speechSynthesis' in window)) return { engine: 'phone', voice: '-', status: 'unsupported' };
    if (!this.voices.length) this.voices = speechSynthesis.getVoices();
    const pinned = (s.voicePins || {})[bcp] || {};
    const { voice, pitch } = pickVoice(this.voices, bcp, gender, pinned);
    // Android Chrome: cancel 직후 바로 speak 하면 소리 없이 삼켜지는 버그 → 필요할 때만 cancel 후 잠깐 쉼
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
      await new Promise((r) => setTimeout(r, 80));
    }
    if (speechSynthesis.paused) speechSynthesis.resume();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = bcp;
      try { if (voice) u.voice = voice; } catch { /* 일부 브라우저: 음성 객체 불일치 → lang 으로 대체 */ }
      u.pitch = pitch;
      u.rate = s.rate || 1;
      u.volume = this.volume();
      // Chrome: 발화 객체가 GC 되면 onend 가 안 옴 → 참조 유지
      this.utt = u;
      const name = `${voice?.name || `(${bcp} 기본)`} p${pitch}`;
      let started = false, done = false;
      const fin = (status) => { if (!done) { done = true; resolve({ engine: 'phone', voice: name, status }); } };
      u.onstart = () => { started = true; };
      u.onend = () => fin(started ? 'ok' : 'nostart');
      u.onerror = (e) => fin(`error:${e.error || '?'}`);
      setTimeout(() => { if (!started) { speechSynthesis.cancel(); fin('nostart'); } }, 2500);
      // 일부 기기에서 onend 가 안 오는 버그 대비: 글자 수 기반 상한
      setTimeout(() => fin(started ? 'ok' : 'nostart'), 3000 + text.length * 300);
      speechSynthesis.speak(u);
    });
  }

  async sayAi(text, gender, s) {
    const g = gender === 'male' ? 'male' : 'female';
    const voice = (g === 'male' ? s.aiVoiceMale : s.aiVoiceFemale) || AI_VOICES[g][0];
    const { pcm, rate } = await aiSpeech({ key: s.key, model: s.ttsModel, text, voice });
    const ctx = this.audioCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    const buf = ctx.createBuffer(1, pcm.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    await new Promise((resolve) => {
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.playbackRate.value = s.rate || 1;
      node.connect(this.out());
      node.onended = resolve;
      this.current = node;
      node.start();
    });
    this.current = null;
    return { engine: 'ai', voice, status: 'ok' };
  }
}
