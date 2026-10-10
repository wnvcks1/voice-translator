/* 브라우저 전체 흐름 테스트. 가짜 마이크(페이지 안에서 남 120Hz → 여 220Hz 발화 합성) + Gemini 흉내.
   실제 API·실제 목소리는 안 씀 — 그건 폰에서 직접 확인. 실행: npm run e2e */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

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
    const origStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) { if (this.buffer?.duration > 0.05) window.__played++; return origStart.apply(this, a); };

    let src = null;
    navigator.mediaDevices.getUserMedia = async () => {
      window.__gum++;
      if (!src) {
        const ac = new AudioContext();
        const SR = ac.sampleRate;
        const seg = [[1.5, 0], [1.6, 120], [3.0, 0], [1.6, 220], [8, 0]];
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
      window.__spoken.push({ text: u.text, lang: u.lang, pitch: u.pitch, gum: window.__gum, stops: window.__stops });
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
      : 'L|zh\nG|female\nS|这个三十块。\nT|이건 30위안이에요.\n';
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
  check('[문장] Flash-Lite 우선 선택', (await page.inputValue('#chatModel')) === 'gemini-flash-lite-latest', await page.inputValue('#chatModel'));
  check('[문장] 실시간 모델 자동 선택', (await page.inputValue('#liveModel')) === 'gemini-3.5-live-translate-preview', await page.inputValue('#liveModel'));
  await page.screenshot({ path: join(out, 's1-settings.png') });
  await page.click('#btnCloseSheet');

  await page.click('#btnMic');
  await page.waitForFunction(() => document.querySelectorAll('.turn:not(.pending)').length >= 2, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(out, 's2-conversation.png') });

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
  check('[문장] 재생 전에 마이크를 놓음', spoken[0] && spoken[0].stops >= 1, JSON.stringify(spoken[0]));
  check('[문장] 재생 후 마이크 다시 잡음', st.gum >= 3, `getUserMedia ${st.gum}회`);
  check('[문장] 마이크 다시 잡은 뒤 문장 길이 정상 (무음 프레임에 소음 기준 안 무너짐)', !/\d{5}ms음성/.test(log) && /#2 zh→ko [12]\d{3}ms음성/.test(log), (log.match(/#2 \S+ \d+ms음성/) || [''])[0]);
  check('[문장] 폰 중국어 음성 실패 → AI 음성 대체 재생', calls.some((c) => c.tts) && st.played >= 1 && /AI 음성으로 대체/.test(log), `tts요청 ${calls.filter((c) => c.tts).length} 재생 ${st.played}`);
  check('[문장] 한국어 번역은 폰 음성·여자 음높이', spoken.some((s) => s.lang === 'ko-KR' && s.pitch >= 1), JSON.stringify(spoken));
  check('[문장] 두 번째 요청에 대화 맥락 포함', /이거 얼마예요\? => 这个多少钱？/.test(chatCalls[2]?.body.contents[0].parts[1].text || ''));
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

/* ================= 2. 실시간 모드 ================= */
{
  const { page, errors, ctx } = await newPage();
  await page.route('https://generativelanguage.googleapis.com/**', (route) => route.fulfill({ json: MODELS }));
  const setups = [];
  const counts = {};
  await page.routeWebSocket(/BidiGenerateContent/, (ws) => {
    let target = null;
    let n = 0;
    const sc = (o) => ws.send(JSON.stringify({ serverContent: o }));
    const pcm = Buffer.alloc(24000 * 0.5 * 2).toString('base64');
    ws.onMessage((m) => {
      const msg = JSON.parse(m);
      if (msg.setup) {
        setups.push(msg.setup);
        target = (msg.setup.generationConfig.translationConfig || msg.setup.translationConfig).targetLanguageCode;
        ws.send(JSON.stringify({ setupComplete: {} }));
        return;
      }
      if (!msg.realtimeInput) return;
      n++;
      counts[target] = n;
      // 약 2초(오디오 20조각) 뒤 한국어 발화, 약 6초 뒤 중국어 발화가 들어온 것처럼 응답
      if (n === 20) {
        sc({ inputTranscription: { text: '이거 ' } });
        sc({ inputTranscription: { text: '얼마예요?' } });
        if (target === 'zh-CN') {
          sc({ outputTranscription: { text: '这个多少钱？' }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm } }] } });
        } else {
          // echo 를 꺼도 혹시 같은 언어 소리가 오면 앱이 막아야 함
          sc({ outputTranscription: { text: '이거 얼마예요?' }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm } }] } });
        }
        sc({ turnComplete: true });
      }
      if (n === 60) {
        sc({ inputTranscription: { text: '这个三十块。' } });
        if (target === 'ko-KR') {
          sc({ outputTranscription: { text: '이건 30위안이에요.' }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm } }] } });
        }
        sc({ turnComplete: true });
      }
    });
  });

  await page.goto(url);
  await page.click('#btnSettings');
  await page.fill('#key', 'AIza-test');
  await page.click('#btnTest');
  await page.waitForSelector('#keyStatus .ok', { timeout: 5000 });
  await page.check('#liveMode');
  await page.click('#btnCloseSheet');
  await page.click('#btnMic');
  await page.waitForFunction(() => document.querySelectorAll('.turn:not(.pending)').length >= 2, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, 'l1-live.png') });
  const turns = await page.$$eval('.turn', (els) => els.map((e) => ({ cls: e.className, src: e.querySelector('.src').textContent, dst: e.querySelector('.dst').textContent })));
  const st = await page.evaluate(() => ({ played: window.__played }));
  const log = await page.textContent('#log');

  check('[실시간] 세션 2개 (→zh-CN, →ko-KR), echo 끔, 전사 켬', setups.length === 2 && setups.every((s) => s.inputAudioTranscription && s.outputAudioTranscription)
    && setups.map((s) => s.generationConfig.translationConfig?.targetLanguageCode).sort().join() === 'ko-KR,zh-CN'
    && setups.every((s) => s.generationConfig.translationConfig.echoTargetLanguage === false), JSON.stringify(setups));
  check('[실시간] 목소리 자동이면 speechConfig 없음', setups.every((s) => !s.generationConfig.speechConfig));
  check('[실시간] 마이크 소리를 두 세션에 모두 보냄', counts['zh-CN'] >= 60 && counts['ko-KR'] >= 60, JSON.stringify(counts));
  check('[실시간] 한국어 → 왼쪽 카드', turns.length === 2 && turns[0].cls.includes('left') && turns[0].src === '이거 얼마예요?' && turns[0].dst === '这个多少钱？', JSON.stringify(turns));
  check('[실시간] 중국어 → 오른쪽 카드', turns[1]?.cls.includes('right') && turns[1].src === '这个三十块。' && turns[1].dst === '이건 30위안이에요.', JSON.stringify(turns[1]));
  check('[실시간] 번역 음성 2번만 재생 (같은 언어 되풀이 소리는 막음)', st.played === 2, `재생 ${st.played}회`);
  check('[실시간] 페이지 오류 없음', errors.length === 0, errors.join(' | '));
  process.stdout.write(`\n--- 실시간 모드 로그 ---\n${log}\n`);
  await ctx.close();
}

process.stdout.write('\n');
for (const r of results) process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  → ${r.info}`}\n`);
await browser.close();
server.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
