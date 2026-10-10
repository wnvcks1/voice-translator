/* 동시통역 — 화면·흐름 제어.
   문장 모드: 마이크 → VAD 로 한 마디 끊기 → Gemini(언어판별+받아쓰기+번역, 스트리밍) → 성별 판정 → TTS 재생
   실시간 모드(베타): 마이크 소리를 Gemini Live Translate 세션 2개에 계속 흘려보내고 번역 음성을 바로 재생 */

import { startMic, estimateGender } from './audio.js';
import { interpret, listModels, pickModels, verifyTranslation, LANGS, AI_VOICES } from './gemini.js';
import { Speaker, loadVoices } from './tts.js';
import { LiveSession, PcmPlayer, scriptLang, SCRIPT_OF, EchoGuard } from './live.js';
import { voiceFeatures, VoiceProfiles } from './voice.js';

const VERSION = 'v0.7';
const $ = (id) => document.getElementById(id);
const SKEY = 'dt-settings';

const DEFAULTS = {
  key: '', chatModel: '', chatList: [], ttsModel: '', liveModel: '', models: [], bidiModels: [],
  them: 'zh', aiVoice: false, aiVoiceMale: 'Charon', aiVoiceFemale: 'Kore',
  echoBlock: false, rate: 1, silenceMs: 700, maleMax: 160, femaleMin: 180, sens: 'normal', volume: 0.6, verify: true,
  liveMode: true, meGender: 'auto', themGender: 'auto', sideGender: {}, ver: 3,
};

/** @returns {object} 저장된 설정 */
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SKEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
const S = loadSettings();
// v0.3: 전화처럼 계속 듣는 실시간 모드를 기본으로 (이전 버전에서 꺼 둔 값도 한 번 켬)
if ((S.ver || 0) < 3) {
  S.liveMode = true;
  S.ver = 3;
  try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch { /* 사생활 모드 */ }
}
// v0.1 에서 저장된 설정(Flash 하나만)은 일일 한도가 금방 참 → 저장된 모델 목록으로 Flash-Lite 우선 순서를 다시 만듦
if (!S.chatList.length && S.models.length) {
  const p = pickModels(S.models, S.bidiModels);
  S.chatList = p.chatList;
  S.chatModel = p.chat || S.chatModel;
  try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch { /* 사생활 모드 */ }
}
/** 설정 저장 */
function save() {
  try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch { /* 사생활 모드 */ }
}

/* ---------- 로그 (테스트 중 지연·성별 판정 확인용) ---------- */
const logLines = [];
/**
 * 화면 로그에 한 줄 추가함.
 * @param {string} msg
 */
function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  logLines.push(`${t} ${msg}`);
  if (logLines.length > 200) logLines.shift();
  $('log').textContent = logLines.slice().reverse().join('\n');
}

/* ---------- 상태 ---------- */
let mic = null;
let listening = false;
let lastTurn = null;
const history = [];
const lastGender = {}; // 언어별 직전 성별: 피치 판정 보류 시 사용 (같은 쪽은 대개 같은 사람)
const exhausted = new Map(); // 모델 → 다시 써볼 시각 (무료 한도 초과 시)
let seq = 0;
let live = null; // 실시간 모드 상태
const echo = new EchoGuard(20000); // 스피커로 내보낸 번역이 다시 들려 또 번역되는 것 방지
const voices = new VoiceProfiles(); // 나/상대 목소리를 대화 중에 배워 애매한 말의 쪽을 가름
const VOICE_CONF = 0.3; // 이 확신도 이상일 때만 목소리 판정을 씀 (합성 음성 실험: 같은 자리 잡음에서 최소 0.44)
let inflight = 0; // 백그라운드에서 번역 중인 문장 수
let speechT0 = 0;

const idleText = () => (listening ? '듣는 중… 그냥 말하면 됨' : '정지됨');
/** 아래 작은 줄: 백그라운드 번역 진행 상황 */
const bgText = () => (inflight ? `번역 ${inflight}건 처리 중 (계속 듣는 중)` : '');

const speaker = new Speaker({
  getSettings: () => S,
  // 기본은 재생 중에도 계속 들음(전화처럼). 되돌이 번역은 EchoGuard 가 글자 비교로 거름.
  // '에코 막기'를 켜면 재생하는 동안만 듣기를 멈춤 (스피커가 크고 폰 에코 제거가 약할 때)
  onBusy: (busy) => {
    if (!mic || live || !S.echoBlock) return;
    if (busy) mic.pause(); else mic.resume();
  },
  onError: (m) => log(m),
});

/* ---------- 화면 ---------- */
/**
 * 상태 문구 갱신.
 * @param {string} main
 * @param {string} [sub]
 */
function setStatus(main, sub) {
  $('statusText').textContent = main;
  if (sub !== undefined) $('statusSub').textContent = sub;
}

const bars = [...$('bars').children];
/**
 * 입력 음량 표시.
 * @param {number} db
 * @param {number} floor
 * @param {boolean} active
 */
function showLevel(db, floor, active) {
  const lv = Math.max(0, Math.min(1, (db - floor) / 30));
  bars.forEach((b, i) => {
    const k = i === 1 ? lv : lv * 0.7;
    b.style.transform = `scale(${1 + k * 1.2})`;
    b.style.opacity = active ? 1 : 0.35 + k * 0.5;
  });
  const orb = $('orb');
  if (orb) orb.style.transform = `scale(${1 + lv * 0.08})`;
}

/**
 * 대화 카드 생성.
 * @returns {{el:HTMLElement, src:HTMLElement, dst:HTMLElement, meta:HTMLElement}}
 */
function newCard() {
  $('empty')?.remove();
  const el = document.createElement('div');
  el.className = 'turn pending right';
  el.innerHTML = '<div class="src"></div><div class="dst"></div><div class="meta"></div>';
  $('feed').appendChild(el);
  el.scrollIntoView({ block: 'end' });
  return { el, src: el.querySelector('.src'), dst: el.querySelector('.dst'), meta: el.querySelector('.meta') };
}

/**
 * 크게 보여주기.
 * @param {{dst:string, src:string}} t
 */
function openShow(t) {
  $('showBig').textContent = t.dst;
  $('showSmall').textContent = t.src;
  $('show').classList.add('open');
}

/**
 * 시도할 번역 모델 순서: 설정에서 고른 것 → 자동 후보들. 한도 초과로 쉬는 중인 모델은 뒤로.
 * @returns {string[]}
 */
function modelQueue() {
  const all = [...new Set([S.chatModel, ...(S.chatList || [])].filter(Boolean))];
  const now = Date.now();
  const ok = all.filter((m) => !(exhausted.get(m) > now));
  return ok.length ? ok : all.slice(0, 1);
}

/** 마이크 감도 → 말 시작으로 볼 소음 대비 dB (높음 = 멀리서 작게 말해도 잡음) */
const vadCfg = () => ({ silenceMs: S.silenceMs, startDb: { high: 7, normal: 10, low: 13 }[S.sens] ?? 10 });

/** @param {string|null} m */
const shortModel = (m) => (m || '').replace(/^gemini-/, '');

/* ---------- 핵심: 한 마디 처리 ---------- */
/**
 * 발화 1건을 번역하고 재생함.
 * @param {{wav:Uint8Array, durationMs:number, gender:{gender:string,f0:number|null}}} u
 */
async function handleUtterance(u) {
  if (!S.key || !S.chatModel) {
    setStatus('API 키 필요', '⋯ 설정에서 Gemini 키 입력');
    return;
  }
  // 목소리 떨림(유성음)이 한 프레임도 없는 짧은 소리는 말이 아님 → 무료 한도 아끼려고 안 보냄
  if (u.gender.voicedFrames === 0 && u.durationMs < 1500) {
    log(`잡음 ${Math.round(u.durationMs)}ms (유성음 없음) → 전송 안 함`);
    setStatus(idleText(), '잡음으로 판단해 건너뜀');
    return;
  }
  const id = ++seq;
  const card = newCard();
  const a = 'ko', b = S.them;
  const t0 = performance.now();
  let firstText = 0;
  const feat = voiceFeatures(u.pcm, 16000);
  // 목소리 판정은 Gemini 에 알려 주지 않음: 알려 주면 그 언어로 들으려 해서 중국어를 한국어로 받아적음 (v0.4 실측)
  const guess = voices.classify(feat);
  const byVoice = guess.conf >= VOICE_CONF ? (guess.side === 'left' ? a : b) : null;
  inflight++;
  setStatus(idleText(), bgText());

  try {
    const onPartial = (p) => {
      if (!firstText && (p.src || p.dst)) firstText = performance.now() - t0;
      if (p.lang === a) card.el.className = 'turn pending left';
      if (p.src) card.src.textContent = p.src;
      if (p.dst) card.dst.textContent = p.dst;
      card.el.scrollIntoView({ block: 'end' });
    };
    let r = null;
    let model = null;
    for (const m of modelQueue()) {
      model = m;
      try {
        r = await interpret({ key: S.key, model: m, wav: u.wav, a, b, history: history.slice(-4), onPartial });
        break;
      } catch (e) {
        if (e.status !== 429 && e.status !== 503) throw e;
        // 하루 한도면 내일까지, 분당 한도면 1분 쉬게 하고 다음 모델로
        const daily = /per.?day|daily|PerDay/i.test(e.message);
        exhausted.set(m, Date.now() + (daily ? 6 * 3600e3 : 60e3));
        log(`#${id} ${m} ${e.status === 429 ? (daily ? '일일 한도 초과' : '분당 한도 초과') : '서버 혼잡'} → 다음 모델`);
      }
    }
    if (!r) {
      const err = new Error('모든 모델 한도 초과');
      err.status = 429;
      throw err;
    }

    // 누가 말했나: ① 받아적은 글자 종류(한글/한자 — 가장 확실) ② Gemini 판정 ③ 목소리 판정
    const scriptOf = (t) => {
      const sl = scriptLang(t);
      if (!sl || SCRIPT_OF[a] === SCRIPT_OF[b]) return null;
      return sl === SCRIPT_OF[a] ? a : sl === SCRIPT_OF[b] ? b : null;
    };
    const byScript = scriptOf(r.src);
    const lang = byScript || (r.lang === a || r.lang === b ? r.lang : null) || byVoice;
    if (!lang || !r.dst || r.lang === 'none') {
      card.el.remove();
      log(`#${id} 무시 (lang=${r.lang}, ${Math.round(r.ms)}ms) raw=${JSON.stringify(r.raw).slice(0, 120)}`);
      return;
    }
    const why = byScript ? '글자' : r.lang === lang ? 'Gemini' : '목소리';
    if (byScript && r.lang !== byScript) log(`#${id} Gemini 는 ${r.lang} 라 했지만 받아적은 글자가 ${byScript} → ${byScript} 로 분류`);
    r.lang = lang;
    if (echo.isEcho(r.src, r.lang)) {
      card.el.remove();
      log(`#${id} 에코 무시: 방금 스피커로 나간 말 "${r.src.slice(0, 20)}"`);
      return;
    }

    const mine = r.lang === a;
    const side = mine ? 'left' : 'right';
    // 글자 종류로 확실히 갈린 말만 목소리 학습에 씀 (잘못 배우면 이후 판정이 계속 틀림)
    if (byScript) voices.learn(side, feat);

    // 성별: 설정 고정값 → 이번 말 음높이 → 이 쪽 사람의 누적 음높이 → 직전 판정 → Gemini 추측 순.
    // Gemini 의 목소리 성별 추측은 v0.1 실측에서 98Hz 남성을 여성으로 틀린 적 있어 마지막 순위
    const fixed = mine ? S.meGender : S.themGender;
    const pitchG = u.gender.gender;
    const sideF0 = voices.pitch(side);
    const sideG = sideF0 ? (sideF0 <= S.maleMax ? 'male' : sideF0 >= S.femaleMin ? 'female' : 'unknown') : 'unknown';
    const aiG = r.gender === 'male' || r.gender === 'female' ? r.gender : 'unknown';
    const gender = fixed !== 'auto' ? fixed
      : pitchG !== 'unknown' ? pitchG
        : sideG !== 'unknown' ? sideG
          : lastGender[r.lang] || (aiG !== 'unknown' ? aiG : 'female');
    if (fixed === 'auto' && pitchG !== 'unknown') lastGender[r.lang] = pitchG;

    // 번역문이 실제로 어느 언어로 나왔는지 글자로 확인 (Gemini 가 방향을 헷갈린 경우 읽는 음성이라도 맞춤)
    const toLang = scriptOf(r.dst) && scriptOf(r.dst) !== r.lang ? scriptOf(r.dst) : (mine ? b : a);
    card.el.className = `turn ${side}`;
    card.src.textContent = r.src;
    card.dst.textContent = r.dst;
    const turn = { id, lang: r.lang, src: r.src, dst: r.dst, toLang, gender };
    lastTurn = turn;
    history.push({ lang: r.lang, src: r.src, dst: r.dst });
    if (history.length > 20) history.shift();
    $('btnShow').disabled = false;

    const f0 = u.gender.f0 ? `${Math.round(u.gender.f0)}Hz` : '피치?';
    card.meta.innerHTML = '';
    const vtxt = guess.side ? ` · 목소리 ${guess.side === 'left' ? '나' : '상대'} ${Math.round(guess.conf * 100)}%` : '';
    const play = document.createElement('button');
    play.textContent = '🔊 다시';
    play.onclick = () => { echo.add(turn.dst, turn.toLang); speaker.say(turn.dst, LANGS[turn.toLang].bcp, turn.gender); };
    const big = document.createElement('button');
    big.textContent = '🔍 크게';
    big.onclick = () => openShow(turn);
    card.meta.append(play, big);
    card.el.scrollIntoView({ block: 'end' });

    log(`#${id} ${r.lang}→${toLang} ${Math.round(u.durationMs)}ms음성 ${model} | 첫글자 ${Math.round(firstText)}ms 완료 ${Math.round(r.ms)}ms | 분류 ${why}${vtxt} | 피치 ${pitchG}(${f0}) 쪽평균 ${sideF0 ? Math.round(sideF0) : '-'}Hz AI ${aiG} → ${gender}`);

    // 재생 실패가 번역 결과를 오류로 덮지 않게 따로 처리
    const tts0 = performance.now();
    echo.add(r.dst, toLang);
    speaker.say(r.dst, LANGS[toLang].bcp, gender)
      .then((how) => log(`#${id} 재생 ${how.engine} ${how.status} [${how.voice}] ${Math.round(performance.now() - tts0)}ms`))
      .catch((e) => log(`#${id} 재생 실패 ${e.message}`));
  } catch (e) {
    card.el.classList.remove('pending');
    card.el.classList.add('err');
    const msg = e.status === 429 ? '모든 모델 무료 한도 초과. 1분 뒤 다시 (일일 한도면 내일 오후 4시 초기화)' : e.message;
    card.dst.textContent = `오류: ${msg}`;
    log(`#${id} 오류 ${e.message}`);
  } finally {
    inflight--;
    setStatus(idleText(), bgText());
  }
}

/* ---------- 마이크 ---------- */
/** 듣기 정지 (두 모드 공통) */
let muted = false;
/** 통화 화면 켜기/끄기: 가운데 버튼을 빨간 끊기 버튼으로, 음소거 버튼 활성 */
function callUi(on) {
  $('btnMic').classList.toggle('on', on);
  $('btnMic').innerHTML = on ? ICON_HANG : ICON_MIC;
  $('btnMic').setAttribute('aria-label', on ? '통화 끊기' : '통화 시작');
  $('btnMute').disabled = !on;
  muted = false;
  $('btnMute').classList.remove('muted');
  $('btnMute').textContent = '🎙️';
}
/** @param {boolean} m 음소거 (마이크 데이터를 버림, 장치는 유지) */
function setMuted(m) {
  muted = m;
  $('btnMute').classList.toggle('muted', m);
  $('btnMute').textContent = m ? '🔇' : '🎙️';
  if (!mic) return;
  if (m) mic.pause(); else mic.resume();
  setStatus(m ? '🔇 음소거 — 상대 말도 안 들음' : idleText(), bgText());
}
const ICON_MIC = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';
const ICON_HANG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1 0-1.36C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.72c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>';

function stopAll() {
  callUi(false);
  listening = false;
  live?.stop();
  live = null;
  mic?.stop();
  mic = null;
  speaker.stop();
  releaseWake();
  setStatus('통화 끝 — 다시 누르면 시작', '');
  showLevel(-100, 0, false);
}

async function toggleMic() {
  if (listening) { stopAll(); return; }
  if (!S.key) {
    openSheet();
    $('keyStatus').innerHTML = '<span class="warn">먼저 무료 API 키를 넣고 연결 확인을 누르세요</span>';
    return;
  }
  // 터치 안에서 재생 장치를 깨워 둠 (Android 는 터치 밖에서 처음 재생하면 막음)
  speaker.unlock();
  try {
    if (S.liveMode) {
      try {
        await startLive();
      } catch (e) {
        // 실시간 모델이 없거나 연결 실패 → 듣기는 멈추지 않게 문장 모드로 바로 전환
        live?.stop(); live = null;
        mic?.stop(); mic = null;
        log(`실시간 모드 실패 → 문장 모드로 전환: ${e.message}`);
        await startSentenceMode();
        setStatus(idleText(), '실시간 연결 실패 — 문장 모드로 듣는 중');
      }
    } else await startSentenceMode();
    listening = true;
    callUi(true);
    keepAwake();
  } catch (e) {
    live?.stop(); live = null;
    mic?.stop(); mic = null;
    setStatus(e.name === 'NotAllowedError' ? '마이크 권한 필요' : '시작 실패', e.message);
    log(`시작 실패 ${e.name}: ${e.message}`);
  }
}

async function startSentenceMode() {
  mic = await startMic({
    vad: vadCfg(),
    log,
    onLevel: (db, floor, active) => {
      showLevel(db, floor, active);
      if (active && speechT0) setStatus('🎙 듣는 중…', bgText());
    },
    onSpeechStart: () => { speechT0 = performance.now(); },
    onDiscard: () => { speechT0 = 0; setStatus(idleText(), bgText()); },
    onUtterance: (u) => {
      speechT0 = 0;
      u.gender = reGender(u.gender);
      handleUtterance(u);
      setStatus(idleText(), bgText());
    },
  });
  setStatus(idleText(), `문장 모드 · ${LANGS.ko.native} ⇄ ${LANGS[S.them].native}`);
  log(`문장 모드 시작 ${mic.ctx.sampleRate}Hz, 번역 ${modelQueue().join(' > ')}${S.aiVoice ? ` / TTS ${S.ttsModel}` : ''}`);
}

/* ---------- 실시간 모드 (베타) ---------- */
/**
 * 성별 설정 → Live 세션 목소리. auto 면 지정 안 함 (모델 기본/원래 말투 유지에 맡김).
 * @param {string} g
 * @returns {string|null}
 */
const liveVoice = (g) => (g === 'male' ? S.aiVoiceMale : g === 'female' ? S.aiVoiceFemale : null);

/**
 * 실시간 번역 검수: 끝난 말을 글 번역 모델(Flash-Lite)로 한 번 더 확인해 뜻이 틀렸으면 카드 고치고 정정본을 읽음.
 * 실시간 모델은 속도 우선이라 짧은 말 뜻을 놓칠 때가 있음 (실측: '밥도 먹어' → '좋아').
 * @param {{lang:string, src:string, dst:string, toLang:string, gender:string}} turn
 * @param {{el:HTMLElement, dst:HTMLElement, meta:HTMLElement}} card
 */
async function verifyLive(turn, card) {
  const model = modelQueue()[0];
  if (!model) return;
  const t0 = performance.now();
  try {
    const v = await verifyTranslation({ key: S.key, model, from: turn.lang, to: turn.toLang, src: turn.src, live: turn.dst, history: history.slice(-4) });
    const ms = Math.round(performance.now() - t0);
    if (!v) { log(`검수 응답 해석 실패 (${ms}ms)`); return; }
    if (v.ok) { log(`검수 OK (${ms}ms) "${turn.dst.slice(0, 20)}"`); return; }
    log(`검수 정정 (${ms}ms) "${turn.dst}" → "${v.text}"`);
    const old = document.createElement('div');
    old.className = 'was';
    old.textContent = turn.dst;
    card.dst.textContent = v.text;
    card.dst.after(old);
    const tag = document.createElement('span');
    tag.className = 'fix';
    tag.textContent = '✎ 정정';
    card.meta.prepend(tag, ' ');
    turn.dst = v.text;
    const h = history.find((x) => x.src === turn.src);
    if (h) h.dst = v.text;
    echo.add(v.text, turn.toLang);
    // 정정은 확실히 들리게 AI 음성 우선 (폰 음성은 소리 없이 '성공'하는 기기가 있었음)
    speaker.say(v.text, LANGS[turn.toLang].bcp, turn.gender, { preferAi: true })
      .then((r) => log(`정정 읽기 ${r.engine} ${r.status} [${r.voice}]`));
  } catch (e) {
    if (e.status === 429) exhausted.set(model, Date.now() + 60e3);
    log(`검수 실패 ${e.message}`);
  }
}

async function startLive() {
  if (!S.liveModel) throw new Error('실시간 번역 모델 없음 — 설정에서 연결 확인을 다시 누르세요');
  const player = new PcmPlayer(() => speaker.audioCtx(), () => speaker.out());
  const them = S.them;
  S.sideGender = S.sideGender || {};
  // 세션별 상태: →상대언어 세션은 한국어 말을 받아 왼쪽 카드, →한국어 세션은 상대 말을 받아 오른쪽 카드
  const blank = { inText: '', outText: '', card: null, mute: false, checked: false, voiceChecked: false, genderChecked: false, held: [], audio: [], holdTimer: 0, lastAt: 0, t0: 0, gotAudio: 0 };
  const mk = (target, side, from, to, fixed) => ({
    target, side, from, to, fixed, ...blank, held: [], audio: [],
    // 번역 목소리 성별: 설정 고정값 → 지난 통화에서 기억한 이 쪽 사람 성별 → 없으면 모델 기본 목소리
    voiceG: fixed !== 'auto' ? fixed : (S.sideGender[side] || null),
    session: null, switching: false, pending: [], ownTts: false,
  });
  const st = {
    out: mk(LANGS[them].bcp, 'left', 'ko', them, S.meGender),
    ko: mk('ko-KR', 'right', them, 'ko', S.themGender),
  };
  const both = [st.out, st.ko];
  let lastUtter = null; // 방금 끝난 말의 소리·목소리 특징 (화자 학습·성별 판정용)
  let speechFrom = 0; // 지금(또는 방금) 말의 시작 시각 — 목소리 바꿀 때 그 말을 처음부터 다시 보냄
  const ring = []; // 최근 12초 마이크 소리 [시각, 프레임]
  const play = (x, f, r) => { player.push(f, r); x.audio.push([f, r]); };
  const flush = (x) => {
    clearTimeout(x.holdTimer);
    for (const [f, r] of x.held) play(x, f, r);
    x.held = [];
  };
  // 글자 종류로 이 세션 몫인지 확실한가 (한국어 ↔ 중국어는 항상 확실, 영어 ↔ 스페인어 같은 라틴끼리는 아님)
  const decisive = (x, lang) => lang && SCRIPT_OF[x.from] !== SCRIPT_OF[x.to] && (lang === SCRIPT_OF[x.from] || lang === SCRIPT_OF[x.to]);
  const genderName = (g) => (g === 'male' ? '남' : g === 'female' ? '여' : '기본');

  /** 지금 말하는 사람의 성별: 이번 말 음높이 → 이 쪽 사람 누적 음높이 */
  const speakerGender = (x) => {
    if (x.fixed !== 'auto') return x.fixed;
    const cur = mic?.currentSpeech();
    const pcm = cur && cur.length > 16000 * 0.5 ? cur : lastUtter?.pcm;
    const g = pcm ? reGender(estimateGender(pcm, 16000)).gender : 'unknown';
    if (g !== 'unknown') return g;
    const f0 = voices.pitch(x.side);
    return f0 ? (f0 <= S.maleMax ? 'male' : f0 >= S.femaleMin ? 'female' : 'unknown') : 'unknown';
  };

  const finish = (x) => {
    // 보류 중이던 번역 소리를 먼저 내보내야 '다시 듣기'에도 담김
    if (!x.mute && !x.ownTts) flush(x);
    if (x.card && (x.inText || x.outText)) {
      x.card.el.classList.remove('pending');
      const turn = { id: ++seq, lang: x.from, src: x.inText.trim(), dst: x.outText.trim(), toLang: x.to, gender: x.voiceG || 'female' };
      lastTurn = turn;
      $('btnShow').disabled = false;
      // 글자로 쪽이 확실한 말이면 방금 끝난 말소리로 이 쪽 목소리를 배움
      const learned = decisive(x, scriptLang(turn.src)) && lastUtter && performance.now() - lastUtter.at < 8000;
      if (learned) { voices.learn(x.side, lastUtter.feat); lastUtter = null; }
      // 모델이 목소리 지정을 안 받으면 번역 글을 앱 음성(성별 맞춤)으로 읽음
      if (x.ownTts && turn.dst) {
        echo.add(turn.dst, turn.toLang);
        speaker.say(turn.dst, LANGS[turn.toLang].bcp, turn.gender)
          .then((h) => log(`실시간 앱 음성 ${h.engine} ${h.status} [${h.voice}]`));
      }
      const lat = x.gotAudio ? `첫 소리 ${((x.gotAudio - x.t0) / 1000).toFixed(1)}s` : x.ownTts ? '앱 음성' : '소리 없음';
      x.card.meta.textContent = '';
      const audio = x.audio.slice();
      if (audio.length || x.ownTts) {
        const again = document.createElement('button');
        again.textContent = '🔊 다시';
        again.onclick = () => {
          echo.add(turn.dst, turn.toLang);
          if (audio.length) for (const [f, r] of audio) player.push(f, r);
          else speaker.say(turn.dst, LANGS[turn.toLang].bcp, turn.gender);
        };
        x.card.meta.append(' ', again);
      }
      const big = document.createElement('button');
      big.textContent = '🔍 크게';
      big.onclick = () => openShow(turn);
      x.card.meta.append(' ', big);
      log(`실시간 ${x.from}→${x.to} | ${lat} | 목소리 ${genderName(x.voiceG)} | "${turn.src.slice(0, 30)}" → "${turn.dst.slice(0, 30)}"${learned ? ' | 목소리 학습' : ''}`);
      if (turn.src && turn.dst && S.verify) verifyLive(turn, x.card);
      history.push({ lang: turn.lang, src: turn.src, dst: turn.dst });
      if (history.length > 20) history.shift();
    } else if (x.card) x.card.el.remove();
    clearTimeout(x.holdTimer);
    Object.assign(x, { ...blank, held: [], audio: [] });
  };
  const ensureCard = (x) => {
    if (!x.card) {
      x.card = newCard();
      x.card.el.className = `turn pending ${x.side}`;
      x.t0 = performance.now();
    }
    x.lastAt = performance.now();
    return x.card;
  };

  /**
   * 번역 목소리 성별 바꾸기: 새 목소리로 세션을 다시 열고, 지금 말을 처음부터 다시 보냄. 옛 세션 출력은 버림.
   * 쪽마다 처음 한 번(또는 그 쪽 사람이 바뀔 때)만 일어남.
   */
  const switchVoice = async (x, g) => {
    const old = x.session;
    const prevG = x.voiceG;
    log(`목소리 맞춤: →${x.target} ${genderName(prevG)} → ${genderName(g)} (말한 사람 음높이 기준, 이번 말 다시 번역)`);
    x.voiceG = g;
    x.switching = true;
    x.pending = ring.filter(([t]) => t >= speechFrom).map(([, f]) => f);
    // 옛 목소리로 나온 이번 말 결과는 지우고 새로 받음 (카드는 유지)
    x.inText = ''; x.outText = ''; x.held = []; x.audio = []; x.gotAudio = 0; clearTimeout(x.holdTimer); x.holdTimer = 0;
    x.checked = false;
    if (x.card) { x.card.src.textContent = ''; x.card.dst.textContent = ''; }
    const s2 = makeSession(x, g);
    x.session = s2; // 이 순간부터 옛 세션 메시지는 무시됨
    try {
      await s2.connect();
      for (const f of x.pending) s2.send(f);
      x.lastAt = performance.now(); // 새 세션이 다시 번역하는 동안 카드가 시간 초과로 닫히지 않게
      if (!s2.voiceApplied) {
        x.ownTts = true;
        log(`실시간 모델이 목소리 지정을 안 받음 → →${x.target} 번역은 글로 받아 앱 음성(${genderName(g)})으로 읽음`);
      }
      old?.close();
    } catch (e) {
      log(`목소리 바꾸기 실패, 이전 목소리 유지: ${e.message}`);
      x.session = old;
      x.voiceG = prevG;
      for (const f of x.pending) old?.send(f);
    } finally {
      x.pending = [];
      x.switching = false;
    }
  };

  const handlers = (x, me) => ({
    onIn: (t) => {
      if (x.session !== me) return;
      x.inText += t;
      // 이미 목표 언어인 말(예: →한국어 세션이 한국어를 들음)은 이 세션 몫이 아님 → 소리·글 무시
      const lang = scriptLang(x.inText);
      const drop = (why) => {
        if (!x.mute && why) log(why);
        x.mute = true; x.held = []; clearTimeout(x.holdTimer);
        x.card?.el.remove(); x.card = null;
      };
      if (lang && lang === SCRIPT_OF[x.to] && SCRIPT_OF[x.to] !== SCRIPT_OF[x.from]) return drop('');
      // 스피커로 나간 번역이 다시 들린 것 → 또 번역하면 무한 반복
      if (echo.isEcho(x.inText, x.from)) return drop(`실시간 에코 무시 "${x.inText.slice(0, 20)}"`);
      // '네'·'OK'·숫자처럼 글자로 안 갈리는 말: 두 세션이 둘 다 번역해 소리가 겹침 → 목소리로 누구 말인지 판정
      if (!decisive(x, lang) && !x.voiceChecked && voices.ready) {
        x.voiceChecked = true;
        const cur = mic?.currentSpeech();
        const pcm = cur && cur.length > 16000 * 0.4 ? cur : lastUtter?.pcm;
        const g = voices.classify(pcm ? voiceFeatures(pcm, 16000) : null);
        if (x.side === 'left') log(`화자 확인 "${x.inText.slice(0, 12)}": ${g.side ? `${g.side === 'left' ? '나' : '상대'} ${Math.round(g.conf * 100)}%` : '판단 불가'} (${cur ? '말하는 중 소리' : '방금 끝난 말'})`);
        if (g.conf >= VOICE_CONF && g.side !== x.side) {
          return drop(`화자 판정: "${x.inText.slice(0, 12)}" 은 ${g.side === 'left' ? '내' : '상대'} 목소리(${Math.round(g.conf * 100)}%) → ${x.side === 'left' ? '내' : '상대'} 쪽 번역 버림`);
        }
      }
      if (lang && lang === SCRIPT_OF[x.from]) x.mute = false;
      if (x.mute) return;
      ensureCard(x).src.textContent = x.inText;
      x.card.el.scrollIntoView({ block: 'end' });
      // 이 세션이 번역할 말로 확인됨 → 말한 사람 성별에 번역 목소리를 맞춤
      if (!x.genderChecked && decisive(x, lang) && lang === SCRIPT_OF[x.from]) {
        x.genderChecked = true;
        const g = speakerGender(x);
        if (g !== 'unknown') {
          if (S.sideGender[x.side] !== g) { S.sideGender[x.side] = g; save(); }
          if (g !== x.voiceG && !x.switching) { switchVoice(x, g); return; }
        }
      }
      // 에코가 아님이 확인될 만큼 글자가 모이면 보류해 둔 번역 소리를 내보냄
      if (!x.checked && x.inText.replace(/[\s\p{P}]/gu, '').length >= 4) { x.checked = true; if (!x.ownTts) flush(x); }
    },
    onOut: (t) => {
      if (x.session !== me || x.mute) return;
      x.outText += t;
      echo.add(x.outText, x.to);
      ensureCard(x).dst.textContent = x.outText;
      x.card.el.scrollIntoView({ block: 'end' });
    },
    onAudio: (f, rate) => {
      if (x.session !== me || x.mute || x.ownTts) return;
      ensureCard(x);
      if (!x.gotAudio) x.gotAudio = performance.now();
      if (x.checked) { play(x, f, rate); return; }
      // 들은 말 글자가 아직 없으면 에코·목소리 성별을 모름 → 최대 1.2초 보류 후 재생
      x.held.push([f, rate]);
      if (!x.holdTimer) x.holdTimer = setTimeout(() => { if (!x.mute && x.session === me) { x.checked = true; flush(x); } }, 1200);
    },
    onTurnEnd: () => { if (x.session === me) finish(x); },
  });

  /**
   * @param {object} x 세션 상태
   * @param {string|null} g 번역 목소리 성별
   * @returns {LiveSession}
   */
  function makeSession(x, g) {
    const s = new LiveSession({
      key: S.key, model: S.liveModel, target: x.target, voice: liveVoice(g), log,
      onIn: (t) => handlers(x, s).onIn(t),
      onOut: (t) => handlers(x, s).onOut(t),
      onAudio: (f, r) => handlers(x, s).onAudio(f, r),
      onTurnEnd: () => handlers(x, s).onTurnEnd(),
      onDead: async (why) => {
        if (x.session !== s) return;
        log(`${s.name} 끊김 ${why}`);
        if (!live) return;
        // 세션 수명 제한(약 10~15분) 등으로 끊기면 한 번 다시 연결
        try { await s.connect(); log(`${s.name} 재연결됨`); } catch (e) {
          log(e.message);
          setStatus('실시간 연결 끊김', e.message);
        }
      },
    });
    return s;
  }

  setStatus('실시간 번역 연결 중…', S.liveModel);
  live = {
    stop() {
      clearInterval(this.timer);
      both.forEach((x) => x.session?.close());
      player.stop();
      finish(st.out); finish(st.ko);
    },
  };
  await Promise.all(both.map((x) => {
    x.session = makeSession(x, x.voiceG);
    return x.session.connect().then(() => {
      if (x.voiceG && !x.session.voiceApplied) x.ownTts = true;
    });
  }));
  // turnComplete 가 안 오는 경우 대비: 3초 동안 새 글자가 없으면 카드 마감
  live.timer = setInterval(() => {
    for (const x of both) if (x.card && !x.switching && performance.now() - x.lastAt > 3000 && !player.playing) finish(x);
  }, 500);

  let gated = false;
  mic = await startMic({
    vad: vadCfg(),
    log,
    onLevel: showLevel,
    onSpeechStart: () => { speechFrom = performance.now() - 450; },
    // 실시간 모드에선 번역 요청엔 안 쓰고, 화자 학습·성별 판정용으로만 씀
    onUtterance: (u) => { lastUtter = { pcm: u.pcm, feat: voiceFeatures(u.pcm, 16000), at: performance.now() }; },
    onFrame: (f) => {
      const now = performance.now();
      ring.push([now, f]);
      while (ring.length && now - ring[0][0] > 12000) ring.shift();
      // 기본은 전화처럼 재생 중에도 계속 들음. '에코 막기'를 켜면 재생 동안 무음을 보냄
      const gate = S.echoBlock && player.playing;
      if (gate !== gated) { gated = gate; setStatus(gate ? '🔊 번역 음성 재생 중' : '듣는 중… 그냥 말하면 바로 번역됨'); }
      const out = gate ? new Float32Array(f.length) : f;
      for (const x of both) {
        if (x.switching) x.pending.push(out);
        else x.session?.send(out);
      }
    },
  });
  setStatus('듣는 중… 그냥 말하면 바로 번역됨', `실시간 모드 · ${shortModel(S.liveModel)}`);
  log(`실시간 모드 시작: ${S.liveModel}, 세션 2개 (→${LANGS[them].bcp} 목소리 ${genderName(st.out.voiceG)}, →ko-KR 목소리 ${genderName(st.ko.voiceG)})`);
}

/**
 * 소리 테스트 3단계: ① 삐 소리(앱 오디오 경로) ② 폰 음성 ③ AI 음성. 어느 단계가 들렸는지로 원인을 가름.
 * 지금 마이크 상태(켜짐/꺼짐) 그대로 테스트 → 둘 다 해보면 마이크가 소리를 막는지도 알 수 있음.
 */
async function testSound() {
  speaker.unlock();
  const micState = listening ? '마이크 켜짐' : '마이크 꺼짐';
  const ctx = speaker.audioCtx();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  setStatus('🔊 1/3 삐 소리', micState);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  g.gain.value = 0.25;
  osc.frequency.value = 660;
  osc.connect(g).connect(speaker.out());
  osc.start();
  osc.stop(ctx.currentTime + 0.6);
  await new Promise((r) => setTimeout(r, 900));
  log(`소리 테스트 1/3 삐: AudioContext ${ctx.state} ${ctx.sampleRate}Hz (${micState})`);

  setStatus('🔊 2/3 폰 음성', micState);
  const p = await speaker.sayLocal('하나, 둘, 셋. 폰 음성 테스트입니다.', 'ko-KR', 'male', S);
  log(`소리 테스트 2/3 폰 음성: ${p.status} [${p.voice}] (${micState})`);

  if (S.key && S.ttsModel) {
    setStatus('🔊 3/3 AI 음성', micState);
    try {
      const r = await speaker.sayAi('하나, 둘, 셋. AI 음성 테스트입니다.', 'male', S);
      log(`소리 테스트 3/3 AI 음성: ${r.status} [${r.voice}] (${micState})`);
    } catch (e) {
      log(`소리 테스트 3/3 AI 음성 실패: ${e.message}`);
    }
  } else log('소리 테스트 3/3 건너뜀: 연결 확인 먼저');
  setStatus(listening ? idleText() : '소리 테스트 끝', '삐 / 폰 음성 / AI 음성 중 들린 것만 알려 주세요');
}

/**
 * 설정의 남/여 기준값으로 다시 판정함 (audio.js 기본값과 다를 수 있음).
 * @param {{gender:string,f0:number|null,voicedFrames:number}} g
 */
function reGender(g) {
  if (!g.f0) return g;
  const gender = g.f0 <= S.maleMax ? 'male' : g.f0 >= S.femaleMin ? 'female' : 'unknown';
  return { ...g, gender };
}

let wake = null;
async function keepAwake() {
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* 미지원 */ }
}
function releaseWake() {
  wake?.release().catch(() => {});
  wake = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && listening) keepAwake();
});

/* ---------- 설정 시트 ---------- */
function openSheet() {
  $('sheet').classList.add('open');
  renderVoiceList();
}

/**
 * 모델 드롭다운 채우기.
 * @param {HTMLSelectElement} sel
 * @param {string[]} names
 * @param {string} cur
 */
function fillSelect(sel, names, cur) {
  sel.innerHTML = '';
  for (const n of names) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n;
    if (n === cur) o.selected = true;
    sel.appendChild(o);
  }
  if (!names.length) sel.innerHTML = '<option value="">(연결 확인 먼저)</option>';
}

function renderModels() {
  const chat = [...new Set([...(S.chatList || []), ...S.models.filter((n) => /^gemini/.test(n) && !/(tts|image|embedding|live|native-audio|translate|transcribe)/.test(n))])];
  fillSelect($('chatModel'), chat, S.chatModel);
  fillSelect($('ttsModel'), S.models.filter((n) => /tts/.test(n)), S.ttsModel);
  fillSelect($('liveModel'), (S.bidiModels || []).filter((n) => /translate/.test(n)), S.liveModel);
}

async function testKey() {
  S.key = $('key').value.trim();
  save();
  $('keyStatus').textContent = '확인 중…';
  try {
    const { gen, bidi } = await listModels(S.key);
    const pick = pickModels(gen, bidi);
    S.models = gen;
    S.bidiModels = bidi;
    S.chatList = pick.chatList;
    // v0.1 은 Flash 를 골라 일일 한도가 빨리 찼음 → 연결 확인 때마다 Flash-Lite 우선으로 다시 고름
    S.chatModel = pick.chat || '';
    if (!S.ttsModel || !gen.includes(S.ttsModel)) S.ttsModel = pick.tts || '';
    if (!S.liveModel || !bidi.includes(S.liveModel)) S.liveModel = pick.live || '';
    save();
    renderModels();
    $('keyStatus').innerHTML = `<span class="ok">연결됨</span> · 번역 ${S.chatModel || '없음'} · 음성 ${S.ttsModel || '없음'} · 실시간 ${S.liveModel || '<span class="warn">없음</span>'}`;
    log(`키 확인: 일반 ${gen.length}개 / 실시간 ${bidi.length}개 | 번역 ${pick.chatList.join(' > ')} | TTS ${S.ttsModel} | 실시간 ${S.liveModel || '없음'} [${bidi.join(', ')}]`);
  } catch (e) {
    $('keyStatus').innerHTML = `<span class="bad">실패</span> ${e.message}`;
    log(`키 확인 실패 ${e.message}`);
  }
}

async function renderVoiceList() {
  const vs = await loadVoices();
  const want = ['ko', S.them];
  const rows = vs.filter((v) => want.some((w) => v.lang.toLowerCase().startsWith(w)))
    .map((v) => `${v.lang} · ${v.name}${v.localService ? '' : ' (온라인)'}`);
  $('voiceList').textContent = rows.length ? rows.join('\n') : '해당 언어 음성 없음 — 삼성 설정 > 텍스트 음성 변환에서 Google 음성 데이터 설치 필요';
  $('voiceList').style.whiteSpace = 'pre-wrap';
}

function bindSettings() {
  $('key').value = S.key;
  renderModels();
  for (const sel of ['aiVoiceMale', 'aiVoiceFemale']) {
    const g = sel === 'aiVoiceMale' ? 'male' : 'female';
    fillSelect($(sel), AI_VOICES[g], S[sel]);
    $(sel).onchange = (e) => { S[sel] = e.target.value; save(); };
  }
  $('aiVoice').checked = S.aiVoice;
  $('liveMode').checked = S.liveMode;
  $('meGender').value = S.meGender;
  $('themGender').value = S.themGender;
  $('liveMode').onchange = (e) => {
    S.liveMode = e.target.checked; save();
    if (listening) log('모드 변경은 마이크를 껐다 켜면 적용');
  };
  $('liveModel').onchange = (e) => { S.liveModel = e.target.value; save(); };
  $('meGender').onchange = (e) => { S.meGender = e.target.value; save(); };
  $('themGender').onchange = (e) => { S.themGender = e.target.value; save(); };
  $('btnSound').onclick = testSound;
  $('echoBlock').checked = S.echoBlock;
  $('volume').value = S.volume;
  $('volume').oninput = (e) => { S.volume = Number(e.target.value); speaker.setVolume(); save(); };
  $('verify').checked = S.verify;
  $('verify').onchange = (e) => { S.verify = e.target.checked; save(); };
  $('sens').value = S.sens;
  $('sens').onchange = (e) => { S.sens = e.target.value; save(); if (listening) log('감도는 통화를 다시 시작하면 적용'); };
  $('rate').value = S.rate; $('rateVal').textContent = `${S.rate}x`;
  $('silence').value = S.silenceMs; $('silVal').textContent = `${S.silenceMs}ms`;
  $('maleMax').value = S.maleMax; $('mVal').textContent = S.maleMax;
  $('femaleMin').value = S.femaleMin; $('fVal').textContent = S.femaleMin;
  $('themLang').value = S.them;
  $('themName').textContent = LANGS[S.them].native;

  $('btnTest').onclick = testKey;
  $('chatModel').onchange = (e) => { S.chatModel = e.target.value; save(); };
  $('ttsModel').onchange = (e) => { S.ttsModel = e.target.value; save(); };
  $('aiVoice').onchange = (e) => { S.aiVoice = e.target.checked; save(); };
  $('echoBlock').onchange = (e) => { S.echoBlock = e.target.checked; save(); };
  $('rate').oninput = (e) => { S.rate = Number(e.target.value); $('rateVal').textContent = `${S.rate}x`; save(); };
  $('silence').oninput = (e) => { S.silenceMs = Number(e.target.value); $('silVal').textContent = `${S.silenceMs}ms`; save(); };
  $('silence').onchange = () => { if (listening) log('침묵 길이는 마이크 다시 켜면 적용'); };
  $('maleMax').oninput = (e) => { S.maleMax = Number(e.target.value); $('mVal').textContent = S.maleMax; save(); };
  $('femaleMin').oninput = (e) => { S.femaleMin = Number(e.target.value); $('fVal').textContent = S.femaleMin; save(); };
  $('themLang').onchange = (e) => {
    S.them = e.target.value; save();
    $('themName').textContent = LANGS[S.them].native;
    history.length = 0;
    if (listening && S.liveMode) log('언어 변경은 마이크를 껐다 켜면 적용');
  };
  $('btnCopyLog').onclick = () => navigator.clipboard?.writeText(`${VERSION}\n${logLines.join('\n')}`);
  $('btnSettings').onclick = openSheet;
  $('btnCloseSheet').onclick = () => $('sheet').classList.remove('open');
  $('sheet').onclick = (e) => { if (e.target.id === 'sheet') $('sheet').classList.remove('open'); };
}

/* ---------- 버튼 ---------- */
$('btnMic').onclick = toggleMic;
$('btnMute').onclick = () => setMuted(!muted);
$('btnShow').onclick = () => lastTurn && openShow(lastTurn);
$('btnClear').onclick = () => {
  $('feed').innerHTML = '';
  history.length = 0;
  lastTurn = null;
  $('btnShow').disabled = true;
};
let pressTimer = 0;
$('show').addEventListener('pointerdown', () => {
  pressTimer = setTimeout(() => { pressTimer = -1; $('showBig').parentElement.classList.toggle('flip'); }, 500);
});
$('show').addEventListener('pointerup', () => {
  if (pressTimer !== -1) { clearTimeout(pressTimer); $('show').classList.remove('open'); }
  pressTimer = 0;
});

bindSettings();
$('ver').textContent = VERSION;
log(`${VERSION} 로드됨 · ${S.liveMode ? '실시간 모드' : '문장 모드'}`);
if (!S.key) setStatus('처음이면 ⋯ 설정에서 무료 API 키부터', '');
