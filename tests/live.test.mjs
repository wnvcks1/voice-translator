import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptLang, floatToPcm16, pcm16ToFloat, buildSetup, LiveSession, SETUP_VARIANTS } from '../live.js';
import { toBase64 } from '../gemini.js';

test('scriptLang: 한글/한자/가나/라틴 판별', () => {
  assert.equal(scriptLang('어제 이미 보냈어요'), 'ko');
  assert.equal(scriptLang('昨天就已经发给您了。'), 'zh');
  assert.equal(scriptLang('昨日もう送りました'), 'ja');
  assert.equal(scriptLang('Hola, ¿qué tal?'), 'latin');
  assert.equal(scriptLang('123 ...'), null);
  assert.equal(scriptLang('KTX 표 두 장 주세요'), 'ko');
});

test('PCM 16bit 왕복 변환', () => {
  const x = Float32Array.from([0, 0.5, -0.5, 1, -1, 0.25]);
  const back = pcm16ToFloat(toBase64(floatToPcm16(x)));
  x.forEach((v, i) => assert.ok(Math.abs(v - back[i]) < 1e-3, `${i}: ${v} vs ${back[i]}`));
});

test('buildSetup: 번역 설정 위치·목소리·전사 옵션', () => {
  const g = buildSetup({ model: 'gemini-3.5-live-translate-preview', target: 'zh-CN', voice: 'Charon', placement: 'gen' }).setup;
  assert.equal(g.model, 'models/gemini-3.5-live-translate-preview');
  assert.deepEqual(g.generationConfig.translationConfig, { targetLanguageCode: 'zh-CN', echoTargetLanguage: false });
  assert.equal(g.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon');
  assert.deepEqual(g.inputAudioTranscription, {});
  assert.deepEqual(g.outputAudioTranscription, {});
  const t = buildSetup({ model: 'm', target: 'ko-KR', voice: null, placement: 'top' }).setup;
  assert.equal(t.generationConfig.translationConfig, undefined);
  assert.equal(t.translationConfig.targetLanguageCode, 'ko-KR');
  assert.equal(t.generationConfig.speechConfig, undefined);
});

/** Live API 서버 흉내: 정해진 설정 형식만 받아줌 */
function fakeWs({ accept }) {
  const sockets = [];
  class WS {
    constructor(url) {
      this.url = url; this.readyState = 0; this.sent = [];
      sockets.push(this);
      setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
    }
    send(d) {
      this.sent.push(JSON.parse(d));
      const m = this.sent.at(-1);
      if (m.setup) {
        setTimeout(() => {
          if (accept(m.setup)) this.onmessage?.({ data: new TextEncoder().encode(JSON.stringify({ setupComplete: {} })).buffer });
          else { this.readyState = 3; this.onclose?.({ code: 1007, reason: 'Invalid JSON payload received. Unknown name "translationConfig"' }); }
        }, 0);
      }
    }
    close() { this.readyState = 3; }
  }
  return { WS, sockets };
}

test('LiveSession: 설정 거부되면 다른 형식으로 재시도해서 연결', async () => {
  const { WS, sockets } = fakeWs({ accept: (s) => !!s.translationConfig && !s.generationConfig.speechConfig });
  const logs = [];
  const s = new LiveSession({ key: 'k', model: 'm', target: 'zh-CN', voice: 'Charon', log: (m) => logs.push(m), WebSocketImpl: WS, onIn() {}, onOut() {}, onAudio() {}, onTurnEnd() {}, onDead() {} });
  await s.connect();
  assert.equal(sockets.length, 4, '4번째 형식(top, 목소리 없음)에서 성공해야 함');
  assert.deepEqual(SETUP_VARIANTS[s.variant], { placement: 'top', voice: false });
  assert.match(sockets[0].url, /BidiGenerateContent\?key=k$/);
  assert.ok(logs.some((l) => /재시도/.test(l)));
});

test('LiveSession: 키 오류는 재시도 없이 실패', async () => {
  class WS {
    constructor() { setTimeout(() => this.onclose?.({ code: 1008, reason: 'API key not valid' }), 0); }
    send() {}
    close() {}
  }
  const s = new LiveSession({ key: 'bad', model: 'm', target: 'ko-KR', log() {}, WebSocketImpl: WS, onIn() {}, onOut() {}, onAudio() {}, onTurnEnd() {}, onDead() {} });
  await assert.rejects(s.connect(), /API key not valid/);
});

test('LiveSession: 서버 메시지 → 전사·번역·소리·턴 종료 콜백, 오디오는 100ms 단위로 보냄', async () => {
  const { WS, sockets } = fakeWs({ accept: () => true });
  const got = { in: '', out: '', audio: 0, rate: 0, end: 0 };
  const s = new LiveSession({
    key: 'k', model: 'm', target: 'zh-CN', log() {}, WebSocketImpl: WS,
    onIn: (t) => { got.in += t; }, onOut: (t) => { got.out += t; },
    onAudio: (f, r) => { got.audio += f.length; got.rate = r; }, onTurnEnd: () => { got.end++; }, onDead() {},
  });
  await s.connect();
  const ws = sockets[0];
  const audio = toBase64(floatToPcm16(new Float32Array(480)));
  ws.onmessage({ data: JSON.stringify({ serverContent: { inputTranscription: { text: '이거 ' } } }) });
  ws.onmessage({ data: JSON.stringify({ serverContent: { inputTranscription: { text: '얼마예요' }, outputTranscription: { text: '这个多少钱' }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: audio } }] } } }) });
  ws.onmessage({ data: JSON.stringify({ serverContent: { turnComplete: true } }) });
  assert.deepEqual(got, { in: '이거 얼마예요', out: '这个多少钱', audio: 480, rate: 24000, end: 1 });

  for (let i = 0; i < 5; i++) s.send(new Float32Array(683));
  const audioMsgs = ws.sent.filter((m) => m.realtimeInput);
  assert.equal(audioMsgs.length, 1, '683*3=2049 ≥ 1600 에서 한 번 전송');
  assert.equal(audioMsgs[0].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  assert.equal(atob(audioMsgs[0].realtimeInput.audio.data).length, 683 * 3 * 2);
});
