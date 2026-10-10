/* 실시간 모드(베타): Gemini Live Translate 로 말하는 도중에 번역 음성이 흘러나오게 함.
   한 세션은 번역 방향이 하나뿐이라 세션 두 개(→상대 언어, →한국어)를 동시에 열고 같은 마이크 소리를 둘 다에 보냄.
   각 세션은 이미 목표 언어인 말은 따라하지 않게(echoTargetLanguage=false) 설정 → 말한 쪽 반대 언어로만 나옴.
   Live API 프로토콜: https://ai.google.dev/gemini-api/docs/live-api (raw WebSocket) */

import { toBase64 } from './gemini.js';

const WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/**
 * 글자 종류로 언어를 추정함 (한글/한자/가나/라틴). 섞여 있으면 많은 쪽.
 * @param {string} text
 * @returns {'ko'|'zh'|'ja'|'latin'|null}
 */
export function scriptLang(text) {
  const n = (re) => (text.match(re) || []).length;
  const c = {
    ko: n(/[가-힣ᄀ-ᇿ㄰-㆏]/g),
    ja: n(/[぀-ヿ]/g),
    zh: n(/[一-鿿]/g),
    latin: n(/[A-Za-zÀ-ÿ]/g),
  };
  // 일본어 문장엔 한자가 섞이므로 가나가 조금이라도 있으면 일본어
  if (c.ja > 0 && c.ja * 3 >= c.zh) return 'ja';
  const best = Object.entries(c).filter(([k]) => k !== 'ja').sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : null;
}

/**
 * 글자 2개씩 묶은 집합 (공백·문장부호 제외). 한글·한자는 글자 하나가 정보가 커서 2-gram 이면 충분.
 * @param {string} text
 * @returns {Set<string>}
 */
export function bigrams(text) {
  const t = text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const out = new Set();
  if (t.length === 1) out.add(t);
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * 스피커로 나간 번역 음성이 마이크로 다시 들어와 또 번역되는 것(에코)을 글자 비교로 잡음.
 * 전화처럼 계속 듣는 모드에선 폰 에코 제거가 놓친 소리가 '되돌이 번역'을 무한 반복시킬 수 있음.
 */
export class EchoGuard {
  /** @param {number} [windowMs] 최근 몇 초 안에 내보낸 말과 비교할지 */
  constructor(windowMs = 20000) {
    this.windowMs = windowMs;
    this.items = [];
  }

  /**
   * 내보낸(재생한) 말 기록.
   * @param {string} text
   * @param {string} lang
   * @param {number} [now]
   */
  add(text, lang, now = Date.now()) {
    if (text) this.items.push({ g: bigrams(text), lang, at: now });
    this.items = this.items.filter((x) => now - x.at < this.windowMs);
  }

  /**
   * 들은 말이 최근 내보낸 말의 되울림인지. 들은 말의 2-gram 중 60% 이상이 내보낸 말에 있으면 에코.
   * @param {string} text 들은 말 (부분이어도 됨)
   * @param {string} lang 들은 말의 언어
   * @param {number} [now]
   * @returns {boolean}
   */
  isEcho(text, lang, now = Date.now()) {
    const g = bigrams(text);
    if (g.size < 3) return false;
    for (const x of this.items) {
      if (x.lang !== lang || now - x.at >= this.windowMs) continue;
      let hit = 0;
      for (const b of g) if (x.g.has(b)) hit++;
      if (hit / g.size >= 0.6) return true;
    }
    return false;
  }
}

/** 언어 코드 → 글자 종류 */
export const SCRIPT_OF = { ko: 'ko', zh: 'zh', ja: 'ja', en: 'latin', es: 'latin' };

/**
 * Float32 PCM → 16bit little-endian 바이트.
 * @param {Float32Array} pcm
 * @returns {Uint8Array}
 */
export function floatToPcm16(pcm) {
  const out = new Uint8Array(pcm.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/**
 * base64 16bit PCM → Float32.
 * @param {string} b64
 * @returns {Float32Array}
 */
export function pcm16ToFloat(b64) {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let x = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    if (x >= 0x8000) x -= 0x10000;
    out[i] = x / 32768;
  }
  return out;
}

/**
 * Live API 설정 메시지. 번역 설정 위치가 문서마다 달라 variant 로 바꿔 시도함.
 * @param {{model:string, target:string, voice?:string|null, placement:'gen'|'top'}} o
 * @returns {object}
 */
export function buildSetup(o) {
  const translationConfig = { targetLanguageCode: o.target, echoTargetLanguage: false };
  const generationConfig = { responseModalities: ['AUDIO'] };
  if (o.voice) generationConfig.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice } } };
  if (o.placement === 'gen') generationConfig.translationConfig = translationConfig;
  const setup = {
    model: `models/${o.model}`,
    generationConfig,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
  if (o.placement === 'top') setup.translationConfig = translationConfig;
  return { setup };
}

/** 설정 시도 순서: 공식 예제 위치 먼저, 목소리 지정은 거부되면 뺌 */
export const SETUP_VARIANTS = [
  { placement: 'gen', voice: true },
  { placement: 'gen', voice: false },
  { placement: 'top', voice: true },
  { placement: 'top', voice: false },
];

/**
 * Live 세션 하나 (번역 방향 하나).
 */
export class LiveSession {
  /**
   * @param {{key:string, model:string, target:string, voice?:string|null, log:(m:string)=>void,
   *          onIn:(t:string)=>void, onOut:(t:string)=>void, onAudio:(f:Float32Array, rate:number)=>void,
   *          onTurnEnd:()=>void, onDead:(why:string)=>void, WebSocketImpl?:typeof WebSocket}} o
   */
  constructor(o) {
    this.o = o;
    this.ws = null;
    this.ready = false;
    this.closing = false;
    this.variant = 0;
    this.voiceApplied = false;
    this.buf = [];
    this.bufLen = 0;
    this.name = `→${o.target}`;
  }

  /** @returns {Promise<void>} setupComplete 까지 기다림 */
  connect() {
    return new Promise((resolve, reject) => {
      const v = SETUP_VARIANTS[this.variant];
      const WSImpl = this.o.WebSocketImpl || WebSocket;
      const ws = new WSImpl(`${WS}?key=${encodeURIComponent(this.o.key)}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let settled = false;
      ws.onopen = () => {
        ws.send(JSON.stringify(buildSetup({ model: this.o.model, target: this.o.target, voice: v.voice ? this.o.voice : null, placement: v.placement })));
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
        } catch { return; }
        if (msg.setupComplete) {
          this.ready = true;
          // 목소리를 요청했는데 목소리 없는 형식으로만 연결됐다면 이 모델은 목소리 지정을 안 받는 것
          this.voiceApplied = !!(v.voice && this.o.voice);
          this.o.log(`${this.name} 연결됨 (설정 ${v.placement}${v.voice && this.o.voice ? `, 목소리 ${this.o.voice}` : ''})`);
          if (!settled) { settled = true; resolve(); }
          return;
        }
        this.handle(msg);
      };
      ws.onerror = () => { /* close 에서 처리 */ };
      ws.onclose = (ev) => {
        const why = `${ev.code}${ev.reason ? ` ${ev.reason}` : ''}`;
        this.ready = false;
        if (!settled) {
          settled = true;
          // 설정 거부(1007 잘못된 인자 등)면 다음 설정 위치로 재시도. 키·한도 문제면 그대로 실패
          const retryable = /translation|speech|voice|unknown|invalid|1007/i.test(why) && !/quota|exhaust|key|permission|denied/i.test(why);
          if (retryable && this.variant < SETUP_VARIANTS.length - 1) {
            this.o.log(`${this.name} 설정 거부(${why}) → 다른 형식으로 재시도`);
            this.variant++;
            this.connect().then(resolve, reject);
          } else {
            reject(new Error(`${this.name} 연결 실패: ${why}`));
          }
          return;
        }
        if (!this.closing) this.o.onDead(why);
      };
    });
  }

  /** @param {object} msg 서버 메시지 */
  handle(msg) {
    const sc = msg.serverContent;
    if (msg.goAway) this.o.log(`${this.name} 세션 곧 종료 예고 (${msg.goAway.timeLeft || '?'})`);
    if (!sc) return;
    if (sc.inputTranscription?.text) this.o.onIn(sc.inputTranscription.text);
    if (sc.outputTranscription?.text) this.o.onOut(sc.outputTranscription.text);
    for (const part of sc.modelTurn?.parts || []) {
      const d = part.inlineData;
      if (d?.data && /audio/.test(d.mimeType || 'audio')) {
        const rate = Number(((d.mimeType || '').match(/rate=(\d+)/) || [])[1] || 24000);
        this.o.onAudio(pcm16ToFloat(d.data), rate);
      }
    }
    if (sc.turnComplete || sc.generationComplete) this.o.onTurnEnd();
  }

  /**
   * 16kHz PCM 을 100ms 단위로 모아서 보냄 (너무 잘게 보내면 오버헤드, 크게 보내면 지연).
   * @param {Float32Array} frame
   */
  send(frame) {
    if (!this.ready || this.ws?.readyState !== 1) return;
    this.buf.push(frame);
    this.bufLen += frame.length;
    if (this.bufLen < 1600) return;
    const all = new Float32Array(this.bufLen);
    let o = 0;
    for (const f of this.buf) { all.set(f, o); o += f.length; }
    this.buf = []; this.bufLen = 0;
    this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: toBase64(floatToPcm16(all)), mimeType: 'audio/pcm;rate=16000' } } }));
  }

  close() {
    this.closing = true;
    this.ready = false;
    try { this.ws?.close(); } catch { /* 이미 닫힘 */ }
  }
}

/**
 * 받은 번역 음성 조각을 끊김 없이 이어서 재생함.
 */
export class PcmPlayer {
  /**
   * @param {()=>AudioContext} getCtx
   * @param {()=>AudioNode} [getOut] 음량 조절 노드 (없으면 바로 스피커)
   */
  constructor(getCtx, getOut) {
    this.getCtx = getCtx;
    this.getOut = getOut || (() => getCtx().destination);
    this.next = 0;
    this.nodes = new Set();
  }

  /** @returns {boolean} 재생 중 여부 (끝나기 0.25초 전부터는 아님으로 봄) */
  get playing() {
    const ctx = this.getCtx();
    return this.next > ctx.currentTime + 0.05;
  }

  /**
   * @param {Float32Array} f
   * @param {number} rate
   */
  push(f, rate) {
    const ctx = this.getCtx();
    if (!f.length) return;
    const buf = ctx.createBuffer(1, f.length, rate);
    buf.getChannelData(0).set(f);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(this.getOut());
    const at = Math.max(ctx.currentTime + 0.03, this.next);
    node.start(at);
    this.next = at + buf.duration;
    this.nodes.add(node);
    node.onended = () => this.nodes.delete(node);
  }

  stop() {
    for (const n of this.nodes) { try { n.stop(); } catch { /* 끝남 */ } }
    this.nodes.clear();
    this.next = 0;
  }
}
