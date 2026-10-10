/* 브라우저 전체 흐름 테스트. 가짜 마이크(페이지 안에서 남 120Hz → 여 220Hz 발화 합성) + Gemini 흉내.
   실제 API·실제 목소리는 안 씀 — 그건 폰에서 직접 확인. 실행: npm run e2e */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { estimateGender, rmsDb, concat } from '../audio.js';

// 로컬 설치가 없으면 전역 playwright 사용 (이 저장소는 의존성 설치 없이 돌게 유지)
let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  ({ chromium } = await import(join(execSync('npm root -g').toString().trim(), 'playwright', 'index.mjs')));
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.E2E_OUT || join(root, 'tests', '.out');
await mkdir(out, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = createServer(async (req, res) => {
  try {
    const p = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream' });
    res.end(await readFile(p));
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok, info }); };

/**
 * 페이지 준비: 가짜 마이크(마이크를 껐다 켜도 시간축이 이어지게 전역 AudioContext 에서 생성), 가짜 TTS, 재생 횟수 기록.
 * @param {{zhTtsFails?:boolean}} o
 */
async function newPage(o = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((opt) => {
    window.__spoken = [];
    window.__gum = 0;
    window.__stops = 0;
    window.__played = 0;
    window.__playedVals = [];
    window.__gains = [];
    const origConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...a) {
      if (this instanceof AudioBufferSourceNode && dest instanceof GainNode) window.__gains.push(Math.round(dest.gain.value * 100) / 100);
      return origConnect.call(this, dest, ...a);
    };
    const origStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
      if (this.buffer?.duration > 0.05) { window.__played++; window.__playedVals.push(Math.round(this.buffer.getChannelData(0)[0] * 10) / 10); }
      return origStart.apply(this, a);
    };

    let src = null;
    navigator.mediaDevices.getUserMedia = async () => {
      window.__gum++;
      if (!src) {
        const ac = new AudioContext();
        const SR = ac.sampleRate;
        const seg = [[1.5, 0], [1.6, 120], [3.0, 0], [1.6, 220], [3.0, 0], [0.8, 122], [8, 0]];
        const total = seg.reduce((s, [d]) => s + d, 0);
        const buf = ac.createBuffer(1, Math.round(SR * total), SR);
        const ch = buf.getChannelData(0);
        let i = 0;
        for (const [d, f0] of seg) {
          const n = Math.round(SR * d);
          for (let k = 0; k < n; k++, i++) {
            if (!f0) { ch[i] = (Math.random() * 2 - 1) * 0.002; continue; }
            const ph = (2 * Math.PI * f0 * k) / SR;
            const env = 0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * k) / SR);
            ch[i] = 0.25 * env * (Math.sin(ph) + 0.6 * Math.sin(2 * ph) + 0.4 * Math.sin(3 * ph) + 0.2 * Math.sin(4 * ph)) / 2.2;
          }
        }
        const node = ac.createBufferSource();
        node.buffer = buf;
        const dest = ac.createMediaStreamDestination();
        node.connect(dest);
        origStart.call(node);
        src = dest.stream;
      }
      const track = src.getAudioTracks()[0].clone();
      const stop = track.stop.bind(track);
      track.stop = () => { window.__stops++; stop(); };
      return new MediaStream([track]);
    };

    const fakeVoices = [
      { name: 'Korean Korea', lang: 'ko-KR', voiceURI: 'ko-kr-x-ism-local', localService: true },
      { name: 'Chinese China', lang: 'zh-CN', voiceURI: 'cmn-cn-x-ccc-local', localService: true },
    ];
    speechSynthesis.getVoices = () => fakeVoices;
    speechSynthesis.speak = (u) => {
      if (!u.text.trim()) return;
      window.__spoken.push({ text: u.text, lang: u.lang, pitch: u.pitch, volume: u.volume, gum: window.__gum, stops: window.__stops });
      if (opt.zhTtsFails && u.lang === 'zh-CN') { setTimeout(() => u.onerror?.({ error: 'language-unavailable' }), 50); return; }
      setTimeout(() => u.onstart?.(), 20);
      setTimeout(() => u.onend?.(), 300);
    };
    speechSynthesis.cancel = () => {};
  }, o);
  return { page, errors, ctx };
}

const MODELS = {
  models: [
    ['gemini-2.5-flash', ['generateContent']], ['gemini-flash-latest', ['generateContent']],
    ['gemini-flash-lite-latest', ['generateContent']], ['gemini-2.5-flash-lite', ['generateContent']],
    ['gemini-3.8-flash-lite-tts', ['generateContent']],
    ['gemini-3.5-live-translate-preview', ['bidiGenerateContent']], ['gemini-live-2.5-flash', ['bidiGenerateContent']],
  ].map(([n, m]) => ({ name: `models/${n}`, supportedGenerationMethods: m })),
};

/* ================= 1. 문장 모드 ================= */
{
  const { page, errors, ctx } = await newPage({ zhTtsFails: true });
  const calls = [];
  await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
    const u = route.request().url();
    if (/\/models\?/.test(u)) return route.fulfill({ json: MODELS });
    const model = u.match(/models\/([^:]+):/)[1];
    const body = JSON.parse(route.request().postData());
    calls.push({ model, body, tts: /:generateContent/.test(u) });
    if (/:generateContent/.test(u)) {
      const pcm = Buffer.alloc(24000 * 0.4 * 2).toString('base64');
      return route.fulfill({ json: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm } }] } }] } });
    }
    const n = calls.filter((c) => !c.tts).length;
    // 첫 요청은 첫 모델이 일일 한도 초과 → 다음 모델로 넘어가야 함
    if (n === 1) return route.fulfill({ status: 429, json: { error: { message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-flash-lite, GenerateRequestsPerDayPerProjectPerModel-FreeTier' } } });
    const text = n === 2
      ? 'L|ko\nG|female\nS|이거 얼마예요?\nT|这个多少钱？\n'
      : n === 3
        ? 'L|zh\nG|female\nS|这个三十块。\nT|이건 30위안이에요.\n'
        : 'L|zh\nG|male\nS|这个多少钱？\nT|이거 얼마예요?\n';
    const sse = text.match(/[\s\S]{1,9}/g).map((c) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: c }] } }] })}\r\n\r\n`).join('');
    await new Promise((r) => setTimeout(r, 150));
    return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: sse });
  });

  await page.goto(url);
  await page.screenshot({ path: join(out, 's0-first.png') });
  await page.click('#btnMic');
  check('[문장] 키 없으면 설정창', await page.isVisible('#sheet.open'));
  await page.fill('#key', 'AIza-test');
  await page.click('#btnTest');
  await page.waitForSelector('#keyStatus .ok', { timeout: 5000 });
  check('[문장] 실시간 모드가 기본으로 켜져 있음', await page.isChecked('#liveMode'));
  await page.uncheck('#liveMode');
  check('[문장] Flash-Lite 우선 선택', (await page.inputValue('#chatModel')) === 'gemini-flash-lite-latest', await page.inputValue('#chatModel'));
  check('[문장] 실시간 모델 자동 선택', (await page.inputValue('#liveModel')) === 'gemini-3.5-live-translate-preview', await page.inputValue('#liveModel'));
  await page.screenshot({ path: join(out, 's1-settings.png') });
  await page.click('#btnCloseSheet');

  await page.click('#btnMic');
  await page.waitForFunction(() => document.querySelectorAll('.turn:not(.pending)').length >= 2, null, { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => /에코 무시/.test(document.getElementById('log').textContent), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, 's2-conversation.png') });
  await page.click('#btnSettings');
  await page.click('#btnSound');
  await page.waitForFunction(() => /소리 테스트 3\/3/.test(document.getElementById('log').textContent), null, { timeout: 15000 }).catch(() => {});

  const turns = await page.$$eval('.turn', (els) => els.map((e) => ({ cls: e.className, src: e.querySelector('.src').textContent, dst: e.querySelector('.dst').textContent, meta: e.querySelector('.meta').textContent })));
  const spoken = await page.evaluate(() => window.__spoken);
  const st = await page.evaluate(() => ({ gum: window.__gum, stops: window.__stops, played: window.__played }));
  const log = await page.textContent('#log');
  const chatCalls = calls.filter((c) => !c.tts);

  check('[문장] 429 나면 다음 모델로 넘어감', chatCalls[0]?.model === 'gemini-flash-lite-latest' && chatCalls[1]?.model === 'gemini-2.5-flash-lite', chatCalls.map((c) => c.model).join(','));
  check('[문장] 한도 초과 모델은 다음 발화에서 건너뜀', chatCalls[2]?.model === 'gemini-2.5-flash-lite', chatCalls[2]?.model);
  check('[문장] 한국어 카드는 왼쪽', turns[0]?.cls.includes('left') && turns[0].src === '이거 얼마예요?' && turns[0].dst === '这个多少钱？', JSON.stringify(turns[0]));
  check('[문장] 중국어 카드는 오른쪽', turns[1]?.cls.includes('right') && turns[1].src === '这个三十块。', JSON.stringify(turns[1]));
  check('[문장] Gemini 가 여자라 해도 피치(120Hz)로 남성', /♂ 1[12]\dHz/.test(turns[0]?.meta || ''), turns[0]?.meta);
  check('[문장] 피치(220Hz)로 여성', /♀ 2[12]\dHz/.test(turns[1]?.meta || ''), turns[1]?.meta);
  check('[문장] 전화처럼 재생 중에도 마이크 계속 켜 둠', st.gum === 1 && st.stops === 0, `getUserMedia ${st.gum}회, 끈 횟수 ${st.stops}`);
  check('[문장] 문장 길이 정상 (말 끝 판정)', !/\d{5}ms음성/.test(log) && /#2 zh→ko [12]\d{3}ms음성/.test(log), (log.match(/#2 \S+ \d+ms음성/) || [''])[0]);
  check('[문장] 스피커로 나간 중국어가 다시 들리면 에코로 무시 (카드·소리 없음)', /에코 무시/.test(log) && turns.length === 2 && !spoken.some((x) => x.text === '이거 얼마예요?'), `카드 ${turns.length}개`);
  check('[문장] 소리 테스트 3단계 기록', /1\/3 삐: AudioContext running/.test(log) && /2\/3 폰 음성: ok/.test(log) && /3\/3 AI 음성: ok/.test(log), log.split('\n').filter((l) => /소리 테스트/.test(l)).join(' / '));
  check('[문장] 폰 중국어 음성 실패 → AI 음성 대체 재생', calls.some((c) => c.tts) && st.played >= 1 && /AI 음성으로 대체/.test(log), `tts요청 ${calls.filter((c) => c.tts).length} 재생 ${st.played}`);
  check('[문장] 한국어 번역은 폰 음성·여자 음높이', spoken.some((s) => s.lang === 'ko-KR' && s.pitch >= 1), JSON.stringify(spoken));
  check('[음량] 기본 음량 0.6 이 폰 음성에도 적용', spoken.length > 0 && spoken.every((s) => Math.abs(s.volume - 0.6) < 1e-6), JSON.stringify(spoken.map((s) => s.volume)));
  check('[문장] 두 번째 요청에 대화 맥락 포함', /이거 얼마예요\? => 这个多少钱？/.test(chatCalls[2]?.body.contents[0].parts[1].text || ''));
  check('[문장] 마이크 켠 채 계속 처리 (3번째 발화도 전송)', chatCalls.length === 4, `${chatCalls.length}건`);
  check('[분류] 문장 모드 요청에 목소리 힌트 없음 (중국어를 한국어로 듣는 편향 방지)', chatCalls.every((c) => !/Voice analysis/.test(c.body.contents[0].parts[1].text)), '');
  check('[문장] 카드에 분류 근거(글자) 표시', /분류 글자/.test(turns[0]?.meta || '') && /분류 글자/.test(turns[1]?.meta || ''), turns.map((t) => t.meta).join(' / '));
  check('[통화] 통화 시간 표시', /통화 중 00:\d\d/.test(await page.textContent('#pillText')), await page.textContent('#pillText'));
  check('[통화] 마이크 정보 기록 (오디오 스레드·앨리어싱 필터)', /마이크: 오디오 스레드 · \d+Hz→16k\(앨리어싱 필터\)/.test(log), (log.match(/마이크: .*/) || [''])[0]);
  await page.click('#btnCloseSheet');
  await page.click('#btnMic');
  check('[통화] 빨간 버튼 누르면 통화 끝', (await page.textContent('#pillText')) === '동시통역' && await page.isDisabled('#btnMute') && /통화 끝/.test(await page.textContent('#statusText')), await page.textContent('#statusText'));
  check('[문장] 페이지 오류 없음', errors.length === 0, errors.join(' | '));
  process.stdout.write(`\n--- 문장 모드 로그 ---\n${log}\n`);
  await ctx.close();
}

/* ================= 1-b. v0.1 설정 이어받기 ================= */
{
  const { page, ctx } = await newPage();
  await page.addInitScript(() => {
    if (!localStorage.getItem('dt-settings')) localStorage.setItem('dt-settings', JSON.stringify({ key: 'AIza-old', chatModel: 'gemini-flash-latest', models: ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash-lite'] }));
  });
  await page.goto(url);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('dt-settings')));
  check('[이전 설정] v0.1 의 Flash 설정이 Flash-Lite 우선으로 바뀜', saved.chatModel === 'gemini-2.5-flash-lite' && saved.chatList[0] === 'gemini-2.5-flash-lite', JSON.stringify(saved));
  await ctx.close();
}

/**
 * REST API 흉내 (실시간 모드용): 모델 목록, 번역 검수(중국어 '这个三十块。' 은 정정), TTS.
 * @param {object[]} calls 요청 기록
 */
const restMock = (calls) => async (route) => {
  const u = route.request().url();
  if (/\/models\?/.test(u)) return route.fulfill({ json: MODELS });
  const body = JSON.parse(route.request().postData() || '{}');
  if (body.generationConfig?.responseModalities?.includes('AUDIO')) {
    calls.push({ kind: 'tts', text: body.contents[0].parts[0].text, voice: body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName });
    return route.fulfill({ json: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(24000 * 0.3 * 2).toString('base64') } }] } }] } });
  }
  const prompt = body.contents[0].parts.at(-1).text;
  calls.push({ kind: 'verify', prompt });
  // 맥락(이전 대화)이 아니라 이번 원문 줄만 보고 판단
  const utter = (prompt.match(/utterance: (.*)/) || ['', ''])[1];
  const text = /这个三十块/.test(utter) ? 'FIX|이거 30위안이에요.' : `OK|${(prompt.match(/translation: (.*)/) || ['', ''])[1]}`;
  return route.fulfill({ json: { candidates: [{ content: { parts: [{ text }] } }] } });
};

/* ================= 2. 실시간 모드 ================= */
/**
 * Live API 흉내: 받은 소리를 실제로 듣고(음량으로 말 구간, 음높이로 화자) 말이 끝나면 대답함.
 * 앱이 목소리를 바꾸려고 세션을 새로 열고 이번 말을 다시 보내도 그대로 동작해야 하므로 시간이 아니라 소리 내용으로 응답.
 * 번역 소리의 첫 샘플 값으로 어떤 목소리로 나왔는지 표시: 남(Charon)=0.1, 여(Kore)=0.2, 기본=0.3
 *   남 1.2초 이상 = 한국어 "이거 얼마예요?", 남 짧은 말 = "OK", 여 = 중국어 "这个三十块。"
 * @param {{rejectVoice?:boolean}} o
 */
function liveMock(o = {}) {
  const setups = [];
  const counts = {};
  const handler = (ws) => {
    let target = null, voice = null;
    let seg = [], inSeg = false, quiet = 0, acc = [];
    const sc = (x) => ws.send(JSON.stringify({ serverContent: x }));
    const mark = { Charon: 0.1, Kore: 0.2 };
    const audio = () => {
      const v = Math.round((voice ? mark[voice] ?? 0.3 : 0.3) * 32767);
      const b = Buffer.alloc(24000 * 0.5 * 2);
      for (let i = 0; i < b.length; i += 2) b.writeInt16LE(v, i);
      return { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: b.toString('base64') } }] } };
    };
    const respond = (pcm) => {
      const dur = pcm.length / 16000;
      const g = estimateGender(pcm, 16000);
      if (g.gender === 'female') {
        if (target === 'ko-KR') {
          sc(audio()); // 번역 소리가 들은 글자보다 먼저 오는 경우
          sc({ inputTranscription: { text: '这个三十块。' } });
          sc({ outputTranscription: { text: '이건 30위안이에요.' } });
        } else sc({ inputTranscription: { text: '这个三十块。' } });
      } else if (dur >= 1.2) {
        sc({ inputTranscription: { text: '이거 ' } });
        sc({ inputTranscription: { text: '얼마예요?' } });
        if (target === 'zh-CN') sc({ outputTranscription: { text: '这个多少钱？' }, ...audio() });
        else {
          // echo 를 꺼도 같은 언어 소리가 오면 앱이 막아야 함
          sc({ outputTranscription: { text: '이거 얼마예요?' }, ...audio() });
          sc({ turnComplete: true });
          // 스피커로 나간 '这个多少钱？' 가 마이크로 되들어온 상황
          setTimeout(() => { sc({ inputTranscription: { text: '这个多少钱' } }); sc({ outputTranscription: { text: '이거 얼마예요' }, ...audio() }); sc({ turnComplete: true }); }, 400);
          return;
        }
      } else {
        // 글자로는 누구 말인지 모름 → 두 세션 다 번역해 보냄. 앱이 목소리로 한쪽만 남겨야 함
        sc({ inputTranscription: { text: 'OK' } });
        sc({ outputTranscription: { text: target === 'zh-CN' ? '好的' : '알겠어요' }, ...audio() });
      }
      sc({ turnComplete: true });
    };
    ws.onMessage((m) => {
      const msg = JSON.parse(m);
      if (msg.setup) {
        const gc = msg.setup.generationConfig;
        if (o.rejectVoice && gc.speechConfig) { ws.close({ code: 1007, reason: 'Invalid JSON payload received. Unknown name "speechConfig"' }); return; }
        setups.push(msg.setup);
        target = (gc.translationConfig || msg.setup.translationConfig).targetLanguageCode;
        voice = gc.speechConfig?.voiceConfig.prebuiltVoiceConfig.voiceName || null;
        ws.send(JSON.stringify({ setupComplete: {} }));
        return;
      }
      if (!msg.realtimeInput) return;
      counts[target] = (counts[target] || 0) + 1;
      const b = Buffer.from(msg.realtimeInput.audio.data, 'base64');
      for (let i = 0; i + 1 < b.length; i += 2) acc.push(b.readInt16LE(i) / 32768);
      while (acc.length >= 1600) {
        const blk = Float32Array.from(acc.splice(0, 1600));
        const loud = rmsDb(blk) > -35;
        if (loud) { inSeg = true; quiet = 0; seg.push(blk); } else if (inSeg) {
          seg.push(blk);
          if (++quiet >= 7) { const pcm = concat(seg.slice(0, -7)); inSeg = false; seg = []; quiet = 0; respond(pcm); }
        }
      }
    });
  };
  return { setups, counts, handler };
}

{
  const { page, errors, ctx } = await newPage();
  const calls = [];
  await page.route('https://generativelanguage.googleapis.com/**', restMock(calls));
  const mock = liveMock();
  const { setups, counts } = mock;
  await page.routeWebSocket(/BidiGenerateContent/, mock.handler);

  await page.goto(url);
  await page.click('#btnSettings');
  await page.fill('#key', 'AIza-test');
  await page.click('#btnTest');
  await page.waitForSelector('#keyStatus .ok', { timeout: 5000 });
  await page.check('#liveMode');
  await page.click('#btnCloseSheet');
  await page.fill('#volume', '0.3');
  await page.dispatchEvent('#volume', 'input');
  await page.click('#btnMic');
  await page.waitForFunction(() => document.querySelectorAll('.turn:not(.pending)').length >= 2, null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, 'l1-live.png') });
  // 음소거: 누르면 세션에 소리를 안 보냄
  await page.click('#btnMute');
  const before = { ...counts };
  await page.waitForTimeout(1200);
  const mutedGrowth = Math.max(counts['zh-CN'] - before['zh-CN'], counts['ko-KR'] - before['ko-KR']);
  await page.click('#btnMute');
  await page.waitForTimeout(800);
  const resumed = counts['zh-CN'] - before['zh-CN'];
  await page.waitForFunction(() => document.querySelectorAll('.turn:not(.pending)').length >= 3, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, 'l2-live-ok.png') });
  const turns = await page.$$eval('.turn', (els) => els.map((e) => ({ cls: e.className, src: e.querySelector('.src').textContent, dst: e.querySelector('.dst').textContent, meta: e.querySelector('.meta').textContent })));
  const st = await page.evaluate(() => ({ played: window.__played, vals: window.__playedVals.filter((v) => v !== 0), all: window.__playedVals, gains: window.__gains }));
  const was = await page.$$eval('.turn .was', (els) => els.map((e) => e.textContent));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('dt-settings')).sideGender);
  const log = await page.textContent('#log');

  const first = setups.slice(0, 2);
  check('[실시간] 처음 세션 2개 (→zh-CN, →ko-KR), echo 끔, 전사 켬, 기억된 성별 없으면 목소리 미지정', first.length === 2 && first.every((s) => s.inputAudioTranscription && s.outputAudioTranscription && !s.generationConfig.speechConfig)
    && first.map((s) => s.generationConfig.translationConfig?.targetLanguageCode).sort().join() === 'ko-KR,zh-CN'
    && first.every((s) => s.generationConfig.translationConfig.echoTargetLanguage === false), JSON.stringify(first));
  const later = setups.slice(2).map((s) => `${s.generationConfig.translationConfig.targetLanguageCode}:${s.generationConfig.speechConfig?.voiceConfig.prebuiltVoiceConfig.voiceName}`);
  check('[목소리] 남자가 한국어로 말하면 →중국어 세션을 남자 목소리로, 여자가 중국어로 말하면 →한국어 세션을 여자 목소리로 다시 엶', later.join() === 'zh-CN:Charon,ko-KR:Kore', later.join());
  check('[목소리] 번역 소리: 한국어→중국어 남자, 중국어→한국어 여자, OK→중국어 남자 (기본 목소리 소리는 안 나감)', JSON.stringify(st.vals) === '[0.1,0.2,0.1]', JSON.stringify(st.vals));
  check('[목소리] 쪽마다 성별 기억 (다음 통화부터 바로 맞는 목소리)', saved?.left === 'male' && saved?.right === 'female', JSON.stringify(saved));
  check('[목소리] 카드에 성별 표시', /♂/.test(turns[0]?.meta || '') && /♀/.test(turns[1]?.meta || ''), turns.map((t) => t.meta).join(' / '));
  check('[분류] 글자로 애매한 "OK" 는 목소리로 내 말 판정 → 왼쪽 카드 하나만', turns.length === 3 && turns[2].cls.includes('left') && turns[2].dst === '好的' && /화자 판정: "OK" 은 내 목소리/.test(log), `${JSON.stringify(turns[2])} | ${(log.match(/화자 판정.*/) || ['판정 기록 없음'])[0]}`);
  check('[실시간] 마이크 소리를 두 세션에 모두 보냄', counts['zh-CN'] >= 90 && counts['ko-KR'] >= 90, JSON.stringify(counts));
  check('[통화] 음소거 중엔 안 보내고, 풀면 다시 보냄', mutedGrowth <= 1 && resumed >= 5, `음소거 중 +${mutedGrowth}, 해제 후 +${resumed}`);
  check('[실시간] 확실한 말로 양쪽 목소리 학습', (log.match(/목소리 학습/g) || []).length === 2, (log.match(/실시간 .*/g) || []).join(' / '));
  check('[실시간] 카드마다 🔊 다시 (보류됐던 소리도 저장)', (await page.$$eval('.turn', (els) => els.filter((e) => /다시/.test(e.querySelector('.meta').textContent)).length)) === 3);
  check('[실시간] 한국어 → 왼쪽 카드 (다시 번역해도 글자 안 겹침)', turns[0]?.cls.includes('left') && turns[0].src === '이거 얼마예요?' && turns[0].dst === '这个多少钱？', JSON.stringify(turns));
  check('[실시간] 중국어 → 오른쪽 카드', turns[1]?.cls.includes('right') && turns[1].src === '这个三十块。', JSON.stringify(turns[1]));
  check('[실시간] 번역 음성 3번 + 정정 1번만 재생 (같은 언어 되풀이·스피커 에코·상대 쪽 OK·옛 목소리는 막음)', st.played === 4 && st.all.filter((v) => v === 0).length === 1, `재생 ${st.played}회 ${JSON.stringify(st.all)}`);
  check('[음량] 화면 음량 0.3 이 모든 번역 소리에 적용', st.gains.length >= 4 && st.gains.every((g) => g === 0.3), JSON.stringify(st.gains));
  const verifies = calls.filter((c) => c.kind === 'verify');
  const tts = calls.filter((c) => c.kind === 'tts');
  check('[검수] 실시간 턴마다 글 번역으로 확인 (소리 없이 글만)', verifies.length === 3 && /Korean utterance: 이거 얼마예요\?/.test(verifies[0].prompt), verifies.map((v) => v.prompt.split('\n').find((l) => /utterance/.test(l))).join(' / '));
  check('[검수] 뜻이 틀린 번역은 카드 고치고 옛 번역은 줄 그어 표시', turns[1]?.dst === '이거 30위안이에요.' && was.includes('이건 30위안이에요.') && /✎ 정정/.test(turns[1]?.meta || ''), `${JSON.stringify(turns[1])} was=${JSON.stringify(was)}`);
  check('[검수] 정정본은 AI 음성으로 그 쪽 성별(여) 맞춰 읽음', tts.length === 1 && tts[0].text === '이거 30위안이에요.' && tts[0].voice === 'Kore', JSON.stringify(tts));
  check('[실시간] 에코 무시 기록', /실시간 에코 무시/.test(log), '');
  check('[실시간] 페이지 오류 없음', errors.length === 0, errors.join(' | '));
  process.stdout.write(`\n--- 실시간 모드 로그 ---\n${log}\n`);

  // 같은 브라우저로 다시 통화: 기억한 성별로 처음부터 맞는 목소리
  const n0 = setups.length;
  await page.click('#btnMic');
  await page.click('#btnMic');
  await page.waitForTimeout(1500);
  const again = setups.slice(n0).map((s) => `${s.generationConfig.translationConfig.targetLanguageCode}:${s.generationConfig.speechConfig?.voiceConfig.prebuiltVoiceConfig.voiceName}`).sort();
  check('[목소리] 두 번째 통화는 처음부터 기억한 목소리로 연결', again.join() === 'ko-KR:Kore,zh-CN:Charon', again.join());
  await ctx.close();
}

/* ================= 2-b. 모델이 목소리 지정을 거부하면 앱 음성으로 ================= */
{
  const { page, errors, ctx } = await newPage();
  await page.route('https://generativelanguage.googleapis.com/**', restMock([]));
  const mock = liveMock({ rejectVoice: true });
  await page.routeWebSocket(/BidiGenerateContent/, mock.handler);
  await page.goto(url);
  await page.click('#btnSettings');
  await page.fill('#key', 'AIza-test');
  await page.click('#btnTest');
  await page.waitForSelector('#keyStatus .ok', { timeout: 5000 });
  await page.click('#btnCloseSheet');
  await page.click('#btnMic');
  await page.waitForFunction(() => document.querySelectorAll('.turn:not(.pending)').length >= 2, null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const spoken = await page.evaluate(() => window.__spoken);
  const vals = await page.evaluate(() => window.__playedVals);
  const log = await page.textContent('#log');
  const zh = spoken.find((x) => x.lang === 'zh-CN');
  const ko = spoken.find((x) => x.lang === 'ko-KR');
  check('[목소리 미지원] 모델이 목소리 지정을 거부하면 번역 글을 앱 음성으로 성별 맞춰 읽음', /목소리 지정을 안 받음/.test(log) && zh?.text === '这个多少钱？' && zh.pitch < 1 && ko?.text === '이건 30위안이에요.' && ko.pitch > 1,
    `${JSON.stringify(spoken)} | ${(log.match(/목소리 지정.*/) || [''])[0]}`);
  check('[목소리 미지원] 모델 기본 목소리 소리는 안 나감 (0.3 표시 소리 없음, 0 은 정정 AI 음성)', !vals.includes(0.3), JSON.stringify(vals));
  check('[목소리 미지원] 페이지 오류 없음', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

/* ================= 3. 실시간 연결 실패 → 문장 모드 ================= */
{
  const { page, errors, ctx } = await newPage();
  await page.route('https://generativelanguage.googleapis.com/**', (route) => route.fulfill({ json: MODELS }));
  await page.routeWebSocket(/BidiGenerateContent/, (ws) => { ws.onMessage(() => ws.close({ code: 1008, reason: 'Quota exceeded' })); });
  await page.goto(url);
  await page.click('#btnSettings');
  await page.fill('#key', 'AIza-test');
  await page.click('#btnTest');
  await page.waitForSelector('#keyStatus .ok', { timeout: 5000 });
  await page.click('#btnCloseSheet');
  await page.click('#btnMic');
  await page.waitForTimeout(1500);
  const log = await page.textContent('#log');
  const status = await page.textContent('#statusSub');
  check('[실패 대비] 실시간 연결 실패하면 문장 모드로 계속 들음', /실시간 모드 실패 → 문장 모드로 전환/.test(log) && /문장 모드 시작/.test(log) && await page.isVisible('#btnMic.on') && /문장 모드로 듣는 중/.test(status), `${status} | ${log.split('\n').slice(0, 3).join(' / ')}`);
  check('[실패 대비] 페이지 오류 없음', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

process.stdout.write('\n');
for (const r of results) process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  → ${r.info}`}\n`);
await browser.close();
server.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
