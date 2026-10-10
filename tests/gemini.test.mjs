import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLines, pickModels, buildPrompt, sseText, toBase64, interpret, thinkingVariants, parseVerify, buildVerifyPrompt, verifyTranslation } from '../gemini.js';

test('parseLines: 완성된 4줄', () => {
  const p = parseLines('L|zh\nG|female\nS|你好，请问洗手间在哪里？\nT|안녕하세요, 화장실이 어디예요?\n');
  assert.equal(p.lang, 'zh');
  assert.equal(p.gender, 'female');
  assert.equal(p.src, '你好，请问洗手间在哪里？');
  assert.equal(p.dst, '안녕하세요, 화장실이 어디예요?');
  assert.ok(p.done.T);
});

test('parseLines: 스트리밍 중간 — 마지막 줄은 미완료', () => {
  const p = parseLines('L|ko\nG|male\nS|이거 얼마');
  assert.equal(p.src, '이거 얼마');
  assert.equal(p.done.S, false);
  assert.equal(p.done.G, true);
  assert.equal(p.dst, undefined);
});

test('parseLines: 코드블록·전각 구분자·대소문자 변형 허용', () => {
  const p = parseLines('```\nL｜ZH\nG: Male\nS| 多少钱\nT|얼마예요\n```');
  assert.equal(p.lang, 'zh');
  assert.equal(p.gender, 'male');
  assert.equal(p.src, '多少钱');
  assert.equal(p.dst, '얼마예요');
});

test('parseLines: 잡음 응답', () => {
  const p = parseLines('L|none\nG|unknown\nS|\nT|\n');
  assert.equal(p.lang, 'none');
  assert.equal(p.dst, '');
});

test('pickModels: Flash-Lite 우선, 나머지는 한도 초과 대비 후보 순서', () => {
  const r = pickModels(['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest',
    'gemini-3.1-flash-tts-preview', 'gemini-3.8-flash-lite-tts', 'gemini-2.5-pro-preview-tts', 'gemini-3.5-transcribe']);
  assert.equal(r.chat, 'gemini-flash-lite-latest');
  assert.deepEqual(r.chatList, ['gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-flash-latest']);
  assert.equal(r.tts, 'gemini-3.8-flash-lite-tts');
});

test('pickModels: 실시간 번역 모델은 bidi 목록에서', () => {
  const r = pickModels(['gemini-2.5-flash'], ['gemini-live-2.5-flash', 'gemini-3.5-live-translate-preview']);
  assert.equal(r.live, 'gemini-3.5-live-translate-preview');
  assert.equal(pickModels(['gemini-2.5-flash'], []).live, null);
});

test('pickModels: flash 가 preview 뿐이어도 고르고, 없으면 null', () => {
  assert.equal(pickModels(['gemini-3-flash-preview', 'gemma-3-27b-it']).chat, 'gemini-3-flash-preview');
  assert.equal(pickModels(['gemma-3-27b-it']).chat, null);
});

test('thinkingVariants: 3세대는 thinkingLevel 먼저, 2세대는 budget', () => {
  assert.deepEqual(thinkingVariants('gemini-3.1-flash-lite')[0], { thinkingLevel: 'minimal' });
  assert.deepEqual(thinkingVariants('gemini-2.5-flash-lite')[0], { thinkingBudget: 0 });
  assert.equal(thinkingVariants('gemini-2.5-flash').at(-1), null);
});

test('buildPrompt: 두 언어 코드와 맥락 포함', () => {
  const s = buildPrompt('ko', 'zh', [{ lang: 'ko', src: '안녕', dst: '你好' }]);
  assert.match(s, /"ko"/);
  assert.match(s, /"zh"/);
  assert.match(s, /안녕 => 你好/);
});

test('sseText: data 줄에서 텍스트만, thought 파트 제외', () => {
  const ev = 'data: {"candidates":[{"content":{"parts":[{"text":"x","thought":true},{"text":"L|ko\\n"}]}}]}';
  assert.equal(sseText(ev), 'L|ko\n');
  assert.equal(sseText('data: [garbage'), '');
});

test('toBase64: 큰 배열도 스택 오버플로 없이', () => {
  const b = new Uint8Array(300000).fill(65);
  assert.equal(toBase64(b).length, 400000);
});

/** SSE 스트림 응답 흉내 */
function sseResponse(chunks) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: ch }] } }] })}\r\n\r\n`));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

test('interpret: 스트리밍 조각을 이어 붙이고 중간 결과 알림', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return sseResponse(['L|zh\nG|fem', 'ale\nS|你好\nT|안녕', '하세요']); };
  const partials = [];
  const r = await interpret({ key: 'k', model: 'gemini-2.5-flash-lite', wav: new Uint8Array(10), a: 'ko', b: 'zh', onPartial: (p) => partials.push(p) });
  assert.deepEqual([r.lang, r.gender, r.src, r.dst], ['zh', 'female', '你好', '안녕하세요']);
  assert.ok(partials.length >= 2);
  assert.match(calls[0].url, /streamGenerateContent\?alt=sse/);
  assert.equal(calls[0].body.contents[0].parts[0].inlineData.mimeType, 'audio/wav');
  assert.equal(calls[0].body.generationConfig.thinkingConfig.thinkingBudget, 0);
});

test('interpret: thinking 설정 거부(400)면 다음 후보로, 끝내 빼고 성공', async () => {
  let n = 0;
  globalThis.fetch = async (url, init) => {
    n++;
    const b = JSON.parse(init.body);
    if (b.generationConfig.thinkingConfig) return new Response(JSON.stringify({ error: { message: 'thinking_budget is not supported' } }), { status: 400 });
    return sseResponse(['L|ko\nG|male\nS|네\nT|好的\n']);
  };
  const r = await interpret({ key: 'k', model: 'gemini-3.1-flash-lite', wav: new Uint8Array(4), a: 'ko', b: 'zh' });
  assert.equal(n, 3);
  assert.equal(r.dst, '好的');
});

test('interpret: 429 는 status 달린 에러', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
  await assert.rejects(interpret({ key: 'k', model: 'm', wav: new Uint8Array(4), a: 'ko', b: 'zh' }), (e) => e.status === 429);
});

test('buildPrompt: 목소리 힌트 없음, 언어는 실제 말한 내용으로만 판단하라고 지시', () => {
  const t = buildPrompt('ko', 'zh', []);
  assert.doesNotMatch(t, /Voice analysis/);
  assert.match(t, /ONLY from what is actually said/);
  assert.match(t, /same person may speak either language/);
});

test('parseVerify: OK/FIX 한 줄, 구분자 변형 허용, 엉뚱한 답은 null', () => {
  assert.deepEqual(parseVerify('OK|也吃饭吧'), { ok: true, text: '也吃饭吧' });
  assert.deepEqual(parseVerify('FIX｜你也吃饭吧。\n'), { ok: false, text: '你也吃饭吧。' });
  assert.deepEqual(parseVerify('```\nfix: 你也吃饭吧'), { ok: false, text: '你也吃饭吧' });
  assert.equal(parseVerify('잘 모르겠음'), null);
});

test('buildVerifyPrompt: 원문·실시간 번역·맥락 포함', () => {
  const t = buildVerifyPrompt('ko', 'zh', '밥도 먹어', '好的', [{ lang: 'zh', src: '我吃过了', dst: '저는 먹었어요' }]);
  assert.match(t, /Korean utterance: 밥도 먹어/);
  assert.match(t, /Live Mandarin Chinese.*translation: 好的/);
  assert.match(t, /我吃过了 => 저는 먹었어요/);
  assert.match(t, /FIX\|/);
});

test('verifyTranslation: 글만 보내고 FIX 답을 돌려줌 (실측 사례: 밥도 먹어 → 좋아)', async () => {
  let body = null;
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    assert.match(url, /:generateContent$/);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'FIX|你也吃饭吧。' }] } }] }), { status: 200 });
  };
  const v = await verifyTranslation({ key: 'k', model: 'gemini-2.5-flash-lite', from: 'ko', to: 'zh', src: '밥도 먹어', live: '好的' });
  assert.deepEqual(v, { ok: false, text: '你也吃饭吧。' });
  assert.equal(body.contents[0].parts.length, 1, '소리 없이 글만');
  assert.match(body.contents[0].parts[0].text, /밥도 먹어/);
});
