/* Gemini API 호출: 음성 1건 → 언어 판별 + 받아쓰기 + 번역 + 성별 (스트리밍), 그리고 AI 음성(TTS).
   키는 폰 브라우저 localStorage 에만 둠. 저장소에 절대 넣지 않음. */

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const LANGS = {
  ko: { name: '한국어', native: '한국어', en: 'Korean', bcp: 'ko-KR' },
  zh: { name: '중국어', native: '中文', en: 'Mandarin Chinese (write in Simplified Chinese characters)', bcp: 'zh-CN' },
  en: { name: '영어', native: 'English', en: 'English', bcp: 'en-US' },
  ja: { name: '일본어', native: '日本語', en: 'Japanese', bcp: 'ja-JP' },
  es: { name: '스페인어', native: 'Español', en: 'Spanish', bcp: 'es-ES' },
};

const ver = (n) => {
  const m = n.match(/gemini-(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
};

/**
 * 모델 목록에서 번역용·TTS용·실시간 번역용 모델을 고름. 모델명이 자주 바뀌므로 하드코딩 대신 목록 기반.
 * 번역은 Flash-Lite 우선: 무료 일일 한도가 Flash 보다 훨씬 크고 응답도 빠름.
 * @param {string[]} names generateContent 지원 모델명 ('models/' 뗀 것)
 * @param {string[]} [bidi] bidiGenerateContent(Live API) 지원 모델명
 * @returns {{chat:string|null, chatList:string[], tts:string|null, live:string|null}}
 */
export function pickModels(names, bidi = []) {
  const usable = (n) => /^gemini-/.test(n) && !/(tts|image|live|audio|embedding|thinking|computer|robotics|translate|transcribe)/.test(n);
  const byVer = (a, b) => ver(b) - ver(a);
  const has = (n) => names.includes(n);
  const lite = names.filter((n) => usable(n) && /flash-lite$/.test(n)).sort(byVer);
  const flash = names.filter((n) => usable(n) && /^gemini-[\d.]+-flash$/.test(n)).sort(byVer);
  const previews = names.filter((n) => usable(n) && /flash/.test(n) && /preview/.test(n)).sort(byVer);
  const chatList = [...new Set([
    ...(has('gemini-flash-lite-latest') ? ['gemini-flash-lite-latest'] : []),
    ...lite, ...flash,
    ...(has('gemini-flash-latest') ? ['gemini-flash-latest'] : []),
    ...previews,
  ])];
  const tts = names.filter((n) => /tts/.test(n) && !/pro/.test(n))
    .sort((a, b) => byVer(a, b) || Number(/preview/.test(a)) - Number(/preview/.test(b)));
  const live = bidi.filter((n) => /translate/.test(n)).sort(byVer);
  return { chat: chatList[0] || null, chatList, tts: tts[0] || null, live: live[0] || null };
}

/**
 * 키로 사용 가능한 모델 목록을 받음.
 * @param {string} key
 * @returns {Promise<{gen:string[], bidi:string[]}>}
 */
export async function listModels(key) {
  const gen = [], bidi = [];
  let page = '';
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${BASE}/models?pageSize=200${page ? `&pageToken=${page}` : ''}`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw await apiError(res);
    const j = await res.json();
    for (const m of j.models || []) {
      const name = m.name.replace(/^models\//, '');
      const ms = m.supportedGenerationMethods || [];
      if (ms.includes('generateContent')) gen.push(name);
      if (ms.includes('bidiGenerateContent')) bidi.push(name);
    }
    if (!j.nextPageToken) break;
    page = j.nextPageToken;
  }
  return { gen, bidi };
}

/**
 * thinking(생각) 끄는 설정 후보. 세대마다 받는 필드가 달라서 차례로 시도하고 통한 것을 기억함.
 * @param {string} model
 * @returns {(object|null)[]}
 */
export function thinkingVariants(model) {
  const v = ver(model);
  if (v >= 3 || /latest/.test(model)) return [{ thinkingLevel: 'minimal' }, { thinkingBudget: 0 }, null];
  return [{ thinkingBudget: 0 }, null];
}
const thinkingMemo = new Map();

/**
 * 오류 응답을 사람이 읽을 수 있는 Error 로 변환함.
 * @param {Response} res
 * @returns {Promise<Error>}
 */
async function apiError(res) {
  let msg = `HTTP ${res.status}`;
  try {
    const j = await res.json();
    if (j.error?.message) msg += ` — ${j.error.message}`;
  } catch { /* 본문 없음 */ }
  const e = new Error(msg);
  e.status = res.status;
  return e;
}

/**
 * 통역 지시문을 만듦.
 * @param {string} a 내 언어 코드
 * @param {string} b 상대 언어 코드
 * @param {{src:string, dst:string, lang:string}[]} history 최근 대화 (용어 일관성용)
 * @returns {string}
 */
export function buildPrompt(a, b, history = []) {
  const A = LANGS[a].en, B = LANGS[b].en;
  const ctx = history.length
    ? `\nRecent conversation for context (do not output it):\n${history.map((h) => `- [${h.lang}] ${h.src} => ${h.dst}`).join('\n')}\n`
    : '';
  return `You are a live interpreter between ${A} (code "${a}") and ${B} (code "${b}").
The audio contains ONE short utterance spoken in either ${A} or ${B}.
Output exactly these 4 lines, in this order, and nothing else:
L|<"${a}" or "${b}" — the language actually spoken; "none" if there is no intelligible speech>
G|<male|female|unknown — the speaker's voice>
S|<verbatim transcription in the spoken language and its own script. Do NOT translate on this line.>
T|<natural, spoken-style translation into the other language (${a}->${b} or ${b}->${a})>
Rules: one line each, no line breaks inside S or T, no quotes, no notes. Keep names and numbers exact.
If it is only noise, a cough or silence, output L|none and leave S and T empty.${ctx}`;
}

/**
 * 스트리밍 텍스트에서 L/G/S/T 줄을 뽑음. 마지막 줄은 아직 쓰는 중일 수 있음.
 * @param {string} text
 * @returns {{lang?:string, gender?:string, src?:string, dst?:string, done:{L:boolean,G:boolean,S:boolean,T:boolean}}}
 */
export function parseLines(text) {
  const out = { done: { L: false, G: false, S: false, T: false } };
  const lines = text.replace(/\r/g, '').split('\n');
  const finished = text.endsWith('\n') ? lines.length : lines.length - 1;
  lines.forEach((raw, i) => {
    const line = raw.replace(/^[`*\s]+/, '');
    const m = line.match(/^([LGST])\s*[|｜:]\s?(.*)$/);
    if (!m) return;
    const [, k, v] = m;
    const val = v.trim();
    if (k === 'L') out.lang = val.toLowerCase().replace(/[^a-z]/g, '');
    if (k === 'G') out.gender = val.toLowerCase().replace(/[^a-z]/g, '');
    if (k === 'S') out.src = val;
    if (k === 'T') out.dst = val;
    if (i < finished) out.done[k] = true;
  });
  return out;
}

/**
 * Uint8Array → base64.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

/**
 * 음성 1건을 통역함. 스트리밍으로 받으며 onPartial 로 중간 결과를 계속 알림.
 * @param {{key:string, model:string, wav:Uint8Array, a:string, b:string,
 *          history?:object[], onPartial?:(p:object)=>void, signal?:AbortSignal, noThinking?:boolean}} o
 * @returns {Promise<{lang:string, gender:string, src:string, dst:string, ms:number}>}
 */
export async function interpret(o) {
  const t0 = performance.now();
  const variants = thinkingMemo.has(o.model) ? [thinkingMemo.get(o.model)] : thinkingVariants(o.model);
  let res = null;
  for (let i = 0; i < variants.length; i++) {
    const generationConfig = { temperature: 0.2, maxOutputTokens: 600 };
    if (variants[i]) generationConfig.thinkingConfig = variants[i];
    const body = {
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/wav', data: toBase64(o.wav) } },
          { text: buildPrompt(o.a, o.b, o.history) },
        ],
      }],
      generationConfig,
    };
    res = await fetch(`${BASE}/models/${o.model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': o.key },
      body: JSON.stringify(body),
      signal: o.signal,
    });
    if (res.ok) { thinkingMemo.set(o.model, variants[i]); break; }
    const err = await apiError(res);
    // 생각 설정만 거부된 경우에만 다음 후보로. 그 외 오류(한도 초과 등)는 바로 올림
    if (err.status === 400 && /think/i.test(err.message) && i < variants.length - 1) continue;
    throw err;
  }

  let text = '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let pending = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += dec.decode(value, { stream: true });
    const events = pending.split(/\r?\n\r?\n/);
    pending = events.pop();
    for (const ev of events) text += sseText(ev);
    o.onPartial?.(parseLines(text));
  }
  if (pending.trim()) text += sseText(pending);
  const p = parseLines(text + '\n');
  return { lang: p.lang || 'none', gender: p.gender || 'unknown', src: p.src || '', dst: p.dst || '', ms: performance.now() - t0, raw: text };
}

/**
 * SSE 이벤트 하나에서 모델 텍스트를 꺼냄.
 * @param {string} ev
 * @returns {string}
 */
export function sseText(ev) {
  let s = '';
  for (const line of ev.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      const j = JSON.parse(line.slice(5).trim());
      for (const part of j.candidates?.[0]?.content?.parts || []) if (part.text && !part.thought) s += part.text;
    } catch { /* keep-alive 등 */ }
  }
  return s;
}

export const AI_VOICES = {
  female: ['Kore', 'Aoede', 'Leda', 'Zephyr'],
  male: ['Charon', 'Puck', 'Orus', 'Fenrir'],
};

/**
 * Gemini TTS 로 PCM 음성을 받음.
 * @param {{key:string, model:string, text:string, voice:string, signal?:AbortSignal}} o
 * @returns {Promise<{pcm:Int16Array, rate:number}>}
 */
export async function aiSpeech(o) {
  const res = await fetch(`${BASE}/models/${o.model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': o.key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: o.text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice } } },
      },
    }),
    signal: o.signal,
  });
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  const part = (j.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData);
  if (!part) throw new Error('TTS 응답에 오디오 없음');
  const rate = Number((part.inlineData.mimeType.match(/rate=(\d+)/) || [])[1] || 24000);
  const bin = atob(part.inlineData.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { pcm: new Int16Array(bytes.buffer, 0, bytes.length >> 1), rate };
}
