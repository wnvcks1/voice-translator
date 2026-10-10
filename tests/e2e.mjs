/* 브라우저 전체 흐름 테스트: 가짜 마이크(남 120Hz → 여 220Hz 발화) + Gemini 응답 흉내.
   실제 API·실제 목소리는 안 씀 — 그건 폰에서 직접 확인. 실행: npm run e2e */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { encodeWav, concat } from '../audio.js';

// 로컬 설치가 없으면 전역 playwright 사용 (이 저장소는 의존성 설치 없이 돌게 유지)
let chromium;
try { ({ chromium } = await import('playwright')); } catch {
  ({ chromium } = await import(join(execSync('npm root -g').toString().trim(), 'playwright', 'index.mjs')));
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.E2E_OUT || join(root, 'tests', '.out');
await mkdir(out, { recursive: true });

const SR = 48000;
const tone = (f0, sec) => Float32Array.from({ length: SR * sec }, (_, i) => {
  const ph = (2 * Math.PI * f0 * i) / SR;
  const env = 0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / SR);
  return 0.25 * env * (Math.sin(ph) + 0.6 * Math.sin(2 * ph) + 0.4 * Math.sin(3 * ph) + 0.2 * Math.sin(4 * ph)) / 2.2;
});
const quiet = (sec) => Float32Array.from({ length: SR * sec }, () => (Math.random() * 2 - 1) * 0.002);
const wavPath = join(out, 'fake-mic.wav');
await writeFile(wavPath, encodeWav(concat([quiet(1.5), tone(120, 1.6), quiet(2.5), tone(220, 1.6), quiet(6)]), SR));

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = createServer(async (req, res) => {
  try {
    const p = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream' });
    res.end(await readFile(p));
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`, '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// 내장 TTS 가로채기: 무엇을 어떤 음높이로 읽었는지 기록
await page.addInitScript(() => {
  window.__spoken = [];
  const fakeVoices = [
    { name: 'Korean Korea', lang: 'ko-KR', voiceURI: 'ko-kr-x-ism-local', localService: true },
    { name: 'Chinese China', lang: 'zh-CN', voiceURI: 'cmn-cn-x-ccc-local', localService: true },
  ];
  speechSynthesis.getVoices = () => fakeVoices;
  speechSynthesis.speak = (u) => {
    if (u.text.trim()) window.__spoken.push({ text: u.text, lang: u.lang, pitch: u.pitch, voice: u.voice?.name });
    setTimeout(() => u.onend?.(), 300);
  };
  speechSynthesis.cancel = () => {};
});

let call = 0;
const bodies = [];
await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
  const u = route.request().url();
  if (/\/models\?/.test(u)) {
    return route.fulfill({ json: { models: ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3.8-flash-lite-tts'].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) } });
  }
  const body = JSON.parse(route.request().postData());
  bodies.push(body);
  call++;
  const text = call === 1
    ? 'L|ko\nG|male\nS|이거 얼마예요?\nT|这个多少钱？\n'
    : 'L|zh\nG|female\nS|这个三十块。\nT|이건 30위안이에요.\n';
  const sse = text.match(/[\s\S]{1,9}/g).map((c) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: c }] } }] })}\r\n\r\n`).join('');
  await new Promise((r) => setTimeout(r, 200));
  return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: sse });
});

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); };

await page.goto(url);
await page.screenshot({ path: join(out, '1-first.png') });

// 키 없이 마이크 → 설정창 열림
await page.click('#btnMic');
check('키 없으면 설정창', await page.isVisible('#sheet.open'));
await page.fill('#key', 'AIza-test');
await page.click('#btnTest');
await page.waitForSelector('#keyStatus .ok', { timeout: 5000 });
check('모델 자동선택', (await page.inputValue('#chatModel')) === 'gemini-flash-latest', await page.inputValue('#chatModel'));
await page.screenshot({ path: join(out, '2-settings.png') });
await page.click('#btnCloseSheet');

await page.click('#btnMic');
await page.waitForFunction(() => document.querySelectorAll('.turn:not(.pending)').length >= 2, null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: join(out, '3-conversation.png') });

const turns = await page.$$eval('.turn', (els) => els.map((e) => ({ cls: e.className, src: e.querySelector('.src').textContent, dst: e.querySelector('.dst').textContent, meta: e.querySelector('.meta').textContent })));
const spoken = await page.evaluate(() => window.__spoken);
const log = await page.textContent('#log');

check('발화 2건 감지·전송', bodies.length === 2, `요청 ${bodies.length}건`);
check('WAV 로 전송', bodies[0]?.contents[0].parts[0].inlineData.mimeType === 'audio/wav');
check('내 말 카드(오른쪽)', turns[0]?.cls.includes('me') && turns[0].src === '이거 얼마예요?' && turns[0].dst === '这个多少钱？', JSON.stringify(turns[0]));
check('상대 말 카드(왼쪽)', turns[1]?.cls.includes('them') && turns[1].src === '这个三十块。', JSON.stringify(turns[1]));
check('피치로 남성 판정(120Hz)', /♂ 1[12]\dHz/.test(turns[0]?.meta || ''), turns[0]?.meta);
check('피치로 여성 판정(220Hz)', /♀ 2[12]\dHz/.test(turns[1]?.meta || ''), turns[1]?.meta);
check('중국어 번역을 중국어 음성·남자 음높이로', spoken[0]?.lang === 'zh-CN' && spoken[0].pitch < 1, JSON.stringify(spoken[0]));
check('한국어 번역을 한국어 음성·여자 음높이로', spoken[1]?.lang === 'ko-KR' && spoken[1].pitch >= 1, JSON.stringify(spoken[1]));
check('두 번째 요청에 대화 맥락 포함', /이거 얼마예요\? => 这个多少钱？/.test(bodies[1]?.contents[0].parts[1].text || ''));
check('페이지 오류 없음', errors.length === 0, errors.join(' | '));

await page.click('#btnShow');
await page.screenshot({ path: join(out, '4-show.png') });

for (const r of results) process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  → ${r.info}`}\n`);
process.stdout.write(`\n--- 앱 로그 ---\n${log}\n`);
await browser.close();
server.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
