/* 동시통역 v0.1 — 화면·흐름 제어.
   흐름: 마이크 → VAD 로 한 마디 끊기 → Gemini(언어판별+받아쓰기+번역, 스트리밍) → 성별 판정 → TTS 재생 */

import { startMic } from './audio.js';
import { interpret, listModels, pickModels, LANGS, AI_VOICES } from './gemini.js';
import { Speaker, loadVoices } from './tts.js';

const VERSION = 'v0.1';
const $ = (id) => document.getElementById(id);
const SKEY = 'dt-settings';

const DEFAULTS = {
  key: '', chatModel: '', ttsModel: '', models: [],
  them: 'zh', aiVoice: false, aiVoiceMale: 'Charon', aiVoiceFemale: 'Kore',
  earphone: false, rate: 1, silenceMs: 700, maleMax: 160, femaleMin: 180,
};

/** @returns {object} 저장된 설정 */
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SKEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
const S = loadSettings();
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
const lastGender = {}; // 언어별 직전 성별: 피치 판정 보류 시 사용
let seq = 0;

const speaker = new Speaker({
  getSettings: () => S,
  getAudioCtx: () => mic?.ctx || null,
  onBusy: (busy) => {
    if (!mic || S.earphone) return;
    if (busy) mic.pause(); else mic.resume();
    setStatus(busy ? '🔊 재생 중' : listening ? '듣는 중… 말해 보세요' : '정지됨');
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
  el.className = 'turn pending them';
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
  const id = ++seq;
  const card = newCard();
  const a = 'ko', b = S.them;
  const t0 = performance.now();
  let firstText = 0;
  setStatus('번역 중…', `${(u.durationMs / 1000).toFixed(1)}초 분량 전송`);

  try {
    const r = await interpret({
      key: S.key, model: S.chatModel, wav: u.wav, a, b,
      history: history.slice(-4),
      onPartial: (p) => {
        if (!firstText && (p.src || p.dst)) firstText = performance.now() - t0;
        if (p.lang === a) card.el.className = 'turn pending me';
        if (p.src) card.src.textContent = p.src;
        if (p.dst) card.dst.textContent = p.dst;
        card.el.scrollIntoView({ block: 'end' });
      },
    });

    if (r.lang !== a && r.lang !== b || !r.dst) {
      card.el.remove();
      log(`#${id} 무시 (lang=${r.lang}, ${Math.round(r.ms)}ms) raw=${JSON.stringify(r.raw).slice(0, 120)}`);
      setStatus(listening ? '듣는 중… 말해 보세요' : '정지됨', '잡음으로 판단해 건너뜀');
      return;
    }

    // 성별: 음높이 판정 우선(기기 내 계산, 확실할 때만) → 보류면 Gemini 판정 → 그것도 없으면 같은 쪽 직전 성별
    const pitchG = u.gender.gender;
    const aiG = r.gender === 'male' || r.gender === 'female' ? r.gender : 'unknown';
    const gender = pitchG !== 'unknown' ? pitchG : aiG !== 'unknown' ? aiG : (lastGender[r.lang] || 'female');
    lastGender[r.lang] = gender;

    const mine = r.lang === a;
    const toLang = mine ? b : a;
    card.el.className = `turn ${mine ? 'me' : 'them'}`;
    card.src.textContent = r.src;
    card.dst.textContent = r.dst;
    const turn = { id, lang: r.lang, src: r.src, dst: r.dst, toLang, gender };
    lastTurn = turn;
    history.push({ lang: r.lang, src: r.src, dst: r.dst });
    if (history.length > 20) history.shift();
    $('btnReplay').disabled = false;
    $('btnShow').disabled = false;

    const f0 = u.gender.f0 ? `${Math.round(u.gender.f0)}Hz` : '피치?';
    card.meta.innerHTML = '';
    const info = document.createElement('span');
    info.textContent = `${gender === 'male' ? '♂' : '♀'} ${f0} · 첫글자 ${(firstText / 1000).toFixed(1)}s · 완료 ${(r.ms / 1000).toFixed(1)}s`;
    const play = document.createElement('button');
    play.textContent = '🔊 다시';
    play.onclick = () => speaker.say(turn.dst, LANGS[turn.toLang].bcp, turn.gender);
    const big = document.createElement('button');
    big.textContent = '🔍 크게';
    big.onclick = () => openShow(turn);
    card.meta.append(info, play, big);
    card.el.scrollIntoView({ block: 'end' });
    setStatus(listening ? '듣는 중… 말해 보세요' : '정지됨', '');

    log(`#${id} ${r.lang}→${toLang} ${Math.round(u.durationMs)}ms음성 | 첫글자 ${Math.round(firstText)}ms 완료 ${Math.round(r.ms)}ms | 피치 ${pitchG}(${f0}) AI ${aiG} → ${gender}`);

    // 재생 실패가 번역 결과를 오류로 덮지 않게 따로 처리
    const tts0 = performance.now();
    speaker.say(r.dst, LANGS[toLang].bcp, gender)
      .then((how) => log(`#${id} 재생 ${how.engine} [${how.voice}] ${Math.round(performance.now() - tts0)}ms`))
      .catch((e) => log(`#${id} 재생 실패 ${e.message}`));
  } catch (e) {
    card.el.classList.remove('pending');
    card.el.classList.add('err');
    const msg = e.status === 429 ? '무료 사용량 초과(분당/일일 한도). 잠시 후 다시' : e.message;
    card.dst.textContent = `오류: ${msg}`;
    log(`#${id} 오류 ${e.message}`);
    setStatus(listening ? '듣는 중… 말해 보세요' : '정지됨', '오류 발생 — 로그 확인');
  }
}

/* ---------- 마이크 ---------- */
async function toggleMic() {
  if (listening) {
    listening = false;
    mic?.stop();
    mic = null;
    speaker.stop();
    $('btnMic').classList.remove('on');
    $('liveDot').classList.remove('on');
    releaseWake();
    setStatus('정지됨', '');
    showLevel(-100, 0, false);
    return;
  }
  if (!S.key) {
    openSheet();
    $('keyStatus').innerHTML = '<span class="warn">먼저 무료 API 키를 넣고 연결 확인을 누르세요</span>';
    return;
  }
  speaker.unlock();
  try {
    mic = await startMic({
      vad: { silenceMs: S.silenceMs },
      onLevel: showLevel,
      onSpeechStart: () => setStatus('🎙 듣는 중…', ''),
      onDiscard: () => setStatus('듣는 중… 말해 보세요', '너무 짧아서 건너뜀'),
      onUtterance: (u) => {
        u.gender = reGender(u.gender);
        handleUtterance(u);
      },
    });
    listening = true;
    $('btnMic').classList.add('on');
    $('liveDot').classList.add('on');
    setStatus('듣는 중… 말해 보세요', `${LANGS.ko.native} ⇄ ${LANGS[S.them].native}`);
    keepAwake();
    log(`마이크 시작 ${mic.ctx.sampleRate}Hz, 모델 ${S.chatModel}${S.aiVoice ? ` / TTS ${S.ttsModel}` : ''}`);
  } catch (e) {
    setStatus('마이크 권한 필요', e.message);
    log(`마이크 실패 ${e.name}: ${e.message}`);
  }
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
  const chat = S.models.filter((n) => /gemini/.test(n) && !/(tts|image|embedding|live|native-audio)/.test(n));
  const tts = S.models.filter((n) => /tts/.test(n));
  fillSelect($('chatModel'), chat, S.chatModel);
  fillSelect($('ttsModel'), tts, S.ttsModel);
}

async function testKey() {
  S.key = $('key').value.trim();
  save();
  $('keyStatus').textContent = '확인 중…';
  try {
    const names = await listModels(S.key);
    const pick = pickModels(names);
    S.models = names;
    if (!S.chatModel || !names.includes(S.chatModel)) S.chatModel = pick.chat || '';
    if (!S.ttsModel || !names.includes(S.ttsModel)) S.ttsModel = pick.tts || '';
    save();
    renderModels();
    $('keyStatus').innerHTML = `<span class="ok">연결됨</span> · 번역 ${S.chatModel || '없음'} · 음성 ${S.ttsModel || '없음'}`;
    log(`키 확인: 모델 ${names.length}개, 번역=${S.chatModel}, TTS=${S.ttsModel}`);
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
  $('earphone').checked = S.earphone;
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
  $('earphone').onchange = (e) => { S.earphone = e.target.checked; save(); };
  $('rate').oninput = (e) => { S.rate = Number(e.target.value); $('rateVal').textContent = `${S.rate}x`; save(); };
  $('silence').oninput = (e) => { S.silenceMs = Number(e.target.value); $('silVal').textContent = `${S.silenceMs}ms`; save(); };
  $('silence').onchange = () => { if (listening) log('침묵 길이는 마이크 다시 켜면 적용'); };
  $('maleMax').oninput = (e) => { S.maleMax = Number(e.target.value); $('mVal').textContent = S.maleMax; save(); };
  $('femaleMin').oninput = (e) => { S.femaleMin = Number(e.target.value); $('fVal').textContent = S.femaleMin; save(); };
  $('themLang').onchange = (e) => {
    S.them = e.target.value; save();
    $('themName').textContent = LANGS[S.them].native;
    history.length = 0;
  };
  $('btnCopyLog').onclick = () => navigator.clipboard?.writeText(`${VERSION}\n${logLines.join('\n')}`);
  $('btnSettings').onclick = openSheet;
  $('btnCloseSheet').onclick = () => $('sheet').classList.remove('open');
  $('sheet').onclick = (e) => { if (e.target.id === 'sheet') $('sheet').classList.remove('open'); };
}

/* ---------- 버튼 ---------- */
$('btnMic').onclick = toggleMic;
$('btnReplay').onclick = () => lastTurn && speaker.say(lastTurn.dst, LANGS[lastTurn.toLang].bcp, lastTurn.gender);
$('btnShow').onclick = () => lastTurn && openShow(lastTurn);
$('btnClear').onclick = () => {
  $('feed').innerHTML = '';
  history.length = 0;
  lastTurn = null;
  $('btnReplay').disabled = true;
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
log(`${VERSION} 로드됨`);
if (!S.key) setStatus('처음이면 ⋯ 설정에서 무료 API 키부터', '');
