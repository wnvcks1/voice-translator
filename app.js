/* 동시통역 — 화면·흐름 제어.
   문장 모드: 마이크 → VAD 로 한 마디 끊기 → Gemini(언어판별+받아쓰기+번역, 스트리밍) → 성별 판정 → TTS 재생
   실시간 모드(베타): 마이크 소리를 Gemini Live Translate 세션 2개에 계속 흘려보내고 번역 음성을 바로 재생 */

import { startMic } from './audio.js';
import { interpret, listModels, pickModels, LANGS, AI_VOICES } from './gemini.js';
import { Speaker, loadVoices } from './tts.js';
import { LiveSession, PcmPlayer, scriptLang, SCRIPT_OF } from './live.js';

const VERSION = 'v0.2';
const $ = (id) => document.getElementById(id);
const SKEY = 'dt-settings';

const DEFAULTS = {
  key: '', chatModel: '', chatList: [], ttsModel: '', liveModel: '', models: [], bidiModels: [],
  them: 'zh', aiVoice: false, aiVoiceMale: 'Charon', aiVoiceFemale: 'Kore',
  earphone: false, rate: 1, silenceMs: 700, maleMax: 160, femaleMin: 180,
  liveMode: false, meGender: 'auto', themGender: 'auto',
};

/** @returns {object} 저장된 설정 */
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SKEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
const S = loadSettings();
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

const idleText = () => (listening ? '듣는 중… 말해 보세요' : '정지됨');

const speaker = new Speaker({
  getSettings: () => S,
  // 재생 전 마이크를 완전히 놓음 (Android 통화 모드 해제 → 스피커로 정상 출력, 자기 목소리 재번역도 방지)
  onBusy: async (busy) => {
    if (!mic || S.earphone) return;
    if (busy) {
      mic.release();
      setStatus('🔊 재생 중');
    } else if (listening) {
      try { await mic.reacquire(); } catch (e) { log(`마이크 다시 켜기 실패 ${e.message}`); }
      setStatus(idleText());
    }
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
  setStatus('번역 중…', `${(u.durationMs / 1000).toFixed(1)}초 분량 전송`);

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

    if (r.lang !== a && r.lang !== b || !r.dst) {
      card.el.remove();
      log(`#${id} 무시 (lang=${r.lang}, ${Math.round(r.ms)}ms) raw=${JSON.stringify(r.raw).slice(0, 120)}`);
      setStatus(idleText(), '잡음으로 판단해 건너뜀');
      return;
    }

    // 성별: 설정에 고정값 → 음높이(기기 내 계산) → 같은 쪽 직전 판정 → Gemini 추측 순.
    // Gemini 의 목소리 성별 추측은 v0.1 실측에서 98Hz 남성을 여성으로 틀린 적 있어 마지막 순위
    const fixed = r.lang === a ? S.meGender : S.themGender;
    const pitchG = u.gender.gender;
    const aiG = r.gender === 'male' || r.gender === 'female' ? r.gender : 'unknown';
    const gender = fixed !== 'auto' ? fixed
      : pitchG !== 'unknown' ? pitchG
        : lastGender[r.lang] || (aiG !== 'unknown' ? aiG : 'female');
    if (fixed === 'auto' && pitchG !== 'unknown') lastGender[r.lang] = pitchG;

    const mine = r.lang === a;
    const toLang = mine ? b : a;
    card.el.className = `turn ${mine ? 'left' : 'right'}`;
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
    info.textContent = `${gender === 'male' ? '♂' : '♀'} ${f0} · 첫글자 ${(firstText / 1000).toFixed(1)}s · 완료 ${(r.ms / 1000).toFixed(1)}s · ${shortModel(model)}`;
    const play = document.createElement('button');
    play.textContent = '🔊 다시';
    play.onclick = () => speaker.say(turn.dst, LANGS[turn.toLang].bcp, turn.gender);
    const big = document.createElement('button');
    big.textContent = '🔍 크게';
    big.onclick = () => openShow(turn);
    card.meta.append(info, play, big);
    card.el.scrollIntoView({ block: 'end' });
    setStatus(idleText(), '');

    log(`#${id} ${r.lang}→${toLang} ${Math.round(u.durationMs)}ms음성 ${model} | 첫글자 ${Math.round(firstText)}ms 완료 ${Math.round(r.ms)}ms | 피치 ${pitchG}(${f0}) AI ${aiG} → ${gender}`);

    // 재생 실패가 번역 결과를 오류로 덮지 않게 따로 처리
    const tts0 = performance.now();
    speaker.say(r.dst, LANGS[toLang].bcp, gender)
      .then((how) => log(`#${id} 재생 ${how.engine} ${how.status} [${how.voice}] ${Math.round(performance.now() - tts0)}ms`))
      .catch((e) => log(`#${id} 재생 실패 ${e.message}`));
  } catch (e) {
    card.el.classList.remove('pending');
    card.el.classList.add('err');
    const msg = e.status === 429 ? '모든 모델 무료 한도 초과. 1분 뒤 다시 (일일 한도면 내일 오후 4시 초기화)' : e.message;
    card.dst.textContent = `오류: ${msg}`;
    log(`#${id} 오류 ${e.message}`);
    setStatus(idleText(), '오류 발생 — 로그 확인');
  }
}

/* ---------- 마이크 ---------- */
/** 듣기 정지 (두 모드 공통) */
function stopAll() {
  listening = false;
  live?.stop();
  live = null;
  mic?.stop();
  mic = null;
  speaker.stop();
  $('btnMic').classList.remove('on');
  $('liveDot').classList.remove('on');
  releaseWake();
  setStatus('정지됨', '');
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
    if (S.liveMode) await startLive();
    else await startSentenceMode();
    listening = true;
    $('btnMic').classList.add('on');
    $('liveDot').classList.add('on');
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
    vad: { silenceMs: S.silenceMs },
    onLevel: showLevel,
    onSpeechStart: () => setStatus('🎙 듣는 중…', ''),
    onDiscard: () => setStatus(idleText(), '너무 짧아서 건너뜀'),
    onUtterance: (u) => {
      u.gender = reGender(u.gender);
      handleUtterance(u);
    },
  });
  setStatus('듣는 중… 말해 보세요', `문장 모드 · ${LANGS.ko.native} ⇄ ${LANGS[S.them].native}`);
  log(`문장 모드 시작 ${mic.ctx.sampleRate}Hz, 번역 ${modelQueue().join(' > ')}${S.aiVoice ? ` / TTS ${S.ttsModel}` : ''}`);
}

/* ---------- 실시간 모드 (베타) ---------- */
/**
 * 성별 설정 → Live 세션 목소리. auto 면 지정 안 함 (모델 기본/원래 말투 유지에 맡김).
 * @param {string} g
 * @returns {string|null}
 */
const liveVoice = (g) => (g === 'male' ? S.aiVoiceMale : g === 'female' ? S.aiVoiceFemale : null);

async function startLive() {
  if (!S.liveModel) throw new Error('실시간 번역 모델 없음 — 설정에서 연결 확인을 다시 누르세요');
  const player = new PcmPlayer(() => speaker.audioCtx());
  const them = S.them;
  // 세션별 상태: →상대언어 세션은 한국어 말을 받아 왼쪽 카드, →한국어 세션은 상대 말을 받아 오른쪽 카드
  const mk = (target, side, from, to, gender) => ({ target, side, from, to, gender, inText: '', outText: '', card: null, mute: false, lastAt: 0, t0: 0, gotAudio: 0 });
  const st = {
    out: mk(LANGS[them].bcp, 'left', 'ko', them, S.meGender),
    ko: mk('ko-KR', 'right', them, 'ko', S.themGender),
  };
  const finish = (x) => {
    if (x.card && (x.inText || x.outText)) {
      x.card.el.classList.remove('pending');
      const turn = { id: ++seq, lang: x.from, src: x.inText.trim(), dst: x.outText.trim(), toLang: x.to, gender: x.gender === 'auto' ? 'female' : x.gender };
      lastTurn = turn;
      $('btnReplay').disabled = false;
      $('btnShow').disabled = false;
      const lat = x.gotAudio ? `첫 소리 ${((x.gotAudio - x.t0) / 1000).toFixed(1)}s` : '소리 없음';
      x.card.meta.textContent = `실시간 · ${lat}`;
      const big = document.createElement('button');
      big.textContent = '🔍 크게';
      big.onclick = () => openShow(turn);
      x.card.meta.append(' ', big);
      log(`실시간 ${x.from}→${x.to} | ${lat} | "${turn.src.slice(0, 30)}" → "${turn.dst.slice(0, 30)}"`);
    } else if (x.card) x.card.el.remove();
    Object.assign(x, { inText: '', outText: '', card: null, mute: false, lastAt: 0, t0: 0, gotAudio: 0 });
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
  const handlers = (x) => ({
    onIn: (t) => {
      x.inText += t;
      // 이미 목표 언어인 말(예: →한국어 세션이 한국어를 들음)은 이 세션 몫이 아님 → 소리·글 무시
      const lang = scriptLang(x.inText);
      if (lang && lang === SCRIPT_OF[x.to]) { x.mute = true; x.card?.el.remove(); x.card = null; return; }
      if (lang && lang === SCRIPT_OF[x.from]) x.mute = false;
      if (x.mute) return;
      ensureCard(x).src.textContent = x.inText;
      x.card.el.scrollIntoView({ block: 'end' });
    },
    onOut: (t) => {
      if (x.mute) return;
      x.outText += t;
      ensureCard(x).dst.textContent = x.outText;
      x.card.el.scrollIntoView({ block: 'end' });
    },
    onAudio: (f, rate) => {
      if (x.mute) return;
      if (!x.gotAudio) x.gotAudio = performance.now();
      ensureCard(x);
      player.push(f, rate);
    },
    onTurnEnd: () => finish(x),
  });
  const sessions = [];
  const open = (x) => {
    const s = new LiveSession({
      key: S.key, model: S.liveModel, target: x.target, voice: liveVoice(x.gender), log,
      ...handlers(x),
      onDead: async (why) => {
        log(`${s.name} 끊김 ${why}`);
        if (!live) return;
        // 세션 수명 제한(약 10~15분) 등으로 끊기면 한 번 다시 연결
        try { await s.connect(); log(`${s.name} 재연결됨`); } catch (e) {
          log(e.message);
          setStatus('실시간 연결 끊김', e.message);
        }
      },
    });
    sessions.push(s);
    return s.connect();
  };
  setStatus('실시간 번역 연결 중…', S.liveModel);
  live = {
    stop() {
      clearInterval(this.timer);
      sessions.forEach((s) => s.close());
      player.stop();
      finish(st.out); finish(st.ko);
    },
  };
  await Promise.all([open(st.out), open(st.ko)]);
  // turnComplete 가 안 오는 경우 대비: 3초 동안 새 글자가 없으면 카드 마감
  live.timer = setInterval(() => {
    for (const x of [st.out, st.ko]) if (x.card && performance.now() - x.lastAt > 3000 && !player.playing) finish(x);
  }, 500);

  let gated = false;
  mic = await startMic({
    vad: { silenceMs: S.silenceMs },
    onLevel: showLevel,
    onFrame: (f) => {
      // 스피커 재생 중엔 자기 번역 음성을 다시 번역하지 않게 무음을 보냄 (이어폰 모드는 계속 들음)
      const gate = !S.earphone && player.playing;
      if (gate !== gated) { gated = gate; setStatus(gate ? '🔊 번역 음성 재생 중' : '듣는 중… 말하는 동안 번역됨'); }
      const out = gate ? new Float32Array(f.length) : f;
      for (const s of sessions) s.send(out);
    },
  });
  setStatus('듣는 중… 말하는 동안 번역됨', `실시간 모드(베타) · ${shortModel(S.liveModel)}`);
  log(`실시간 모드 시작: ${S.liveModel}, 세션 2개 (→${LANGS[them].bcp}, →ko-KR)`);
}

/** 소리 테스트: 마이크 끈 상태에서 한국어·상대 언어를 차례로 읽어 결과를 로그에 남김 */
async function testSound() {
  speaker.unlock();
  const samples = { ko: '안녕하세요. 소리 테스트입니다.', zh: '你好，这是声音测试。', en: 'Hello, this is a sound test.', ja: 'こんにちは、音声テストです。', es: 'Hola, esto es una prueba de sonido.' };
  for (const [lang, g] of [['ko', 'male'], [S.them, 'female']]) {
    const r = await speaker.say(samples[lang], LANGS[lang].bcp, g);
    log(`소리 테스트 ${lang}/${g}: ${r.engine} ${r.status} [${r.voice}]`);
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
    if (listening && S.liveMode) log('언어 변경은 마이크를 껐다 켜면 적용');
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
log(`${VERSION} 로드됨 · ${S.liveMode ? '실시간 모드' : '문장 모드'}`);
if (!S.key) setStatus('처음이면 ⋯ 설정에서 무료 API 키부터', '');
