'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantasy-ai-'));
process.env.DATA_DIR = dir;
process.env.CREDS_KEY = 'clave-de-prueba-ia-0123456789abcdef';
process.env.CRON_SECRET = 'cron123';
delete process.env.BLOB_READ_WRITE_TOKEN;

// LaLiga simulada (mismo patrón que api.test.js): nadie sale a internet
const laliga = require('../src/laliga');
const ff = require('../src/futbolfantasy');
laliga.login = async email => 'tok-' + email;
laliga.leagues = async () => [{ id: 'L1', name: 'Liga de prueba', team: { id: 'T1', money: 5000000 } }];
laliga.fetchPublic = async () => ({ players: [{ id: 1, nickname: 'A', teamId: 9, positionId: 4, marketValue: 1000, weekPoints: [] }], teams: [], types: [], calendar: null });
laliga.fetchLeagueData = async (token, league) => ({ league, standing: [], activity: [], squads: [], fetchedAt: new Date().toISOString() });
laliga.marketValue = async () => [];
ff.fetchProbabilities = async () => ({ week: 8, fetchedAt: new Date().toISOString(), probs: {}, matches: 0, players: 0, unmatched: 0 });

// Gemini simulado: solo se interceptan las llamadas a Google; el resto va al fetch real
const realFetch = global.fetch;
let geminiBehavior = { mode: 'ok', text: 'Respuesta de prueba de la IA' };
let geminiCalls = 0;
global.fetch = async (url, opts) => {
  if (String(url).includes('generativelanguage.googleapis.com')) {
    geminiCalls++;
    if (geminiBehavior.mode === 'fail') return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
    if (geminiBehavior.mode === 'quota') return new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 });
    if (geminiBehavior.mode === 'empty') return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
    const body = JSON.parse(opts.body);
    assert.ok(body.systemInstruction.parts[0].text.includes('BigData Fantasy'));
    assert.ok(body.contents[0].parts[0].text.includes('PREGUNTA DEL USUARIO: '));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: geminiBehavior.text }] } }] }), { status: 200 });
  }
  return realFetch(url, opts);
};

const app = require('../src/app');
const server = app.listen(0);
const base = 'http://127.0.0.1:' + server.address().port;
const post = (p, body, cookie) => realFetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body || {}) });
const get = (p, cookie) => realFetch(base + p, { headers: cookie ? { cookie } : {} });

let seq = 0;
async function loginUser() {
  const r = await post('/api/auth/login', { email: 'ia' + (++seq) + '@x.es', password: 'buena' });
  assert.strictEqual(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
}

test.after(() => server.close());

test('cuota inicial, validación y respuesta con datos', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  const cookie = await loginUser();

  const q0 = await (await get('/api/ai/quota', cookie)).json();
  assert.strictEqual(q0.on, true);
  assert.strictEqual(q0.left, q0.limit);

  assert.strictEqual((await post('/api/ai/ask', { question: 'h' }, cookie)).status, 400);

  geminiBehavior = { mode: 'ok', text: 'Laporte está que se sale.' };
  const r = await post('/api/ai/ask', { question: '¿Cómo va mi equipo?' }, cookie);
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.answer, 'Laporte está que se sale.');
  assert.strictEqual(j.left, q0.limit - 1);

  const q1 = await (await get('/api/ai/quota', cookie)).json();
  assert.strictEqual(q1.used, 1);
});

test('fallo de Google no descuenta pregunta y cuota de Google da 503 claro', async () => {
  const cookie = await loginUser();
  geminiBehavior = { mode: 'fail' };
  const r = await post('/api/ai/ask', { question: '¿Y el mercado?' }, cookie);
  assert.strictEqual(r.status, 502);
  const q = await (await get('/api/ai/quota', cookie)).json();
  assert.strictEqual(q.used, 0); // no descontada

  await new Promise(res => setTimeout(res, 8100)); // puerta de 8 s entre preguntas
  geminiBehavior = { mode: 'quota' };
  const r2 = await post('/api/ai/ask', { question: '¿Y el mercado?' }, cookie);
  assert.strictEqual(r2.status, 503);
  const j2 = await r2.json();
  assert.strictEqual(j2.code, 'AI_GOOGLE_QUOTA');
});

test('tope diario: mensaje de mañana más y sin llamada a Google', async () => {
  process.env.AI_DAILY_LIMIT = '2';
  try {
    const cookie = await loginUser();
    geminiBehavior = { mode: 'ok', text: 'ok' };
    await new Promise(res => setTimeout(res, 8100)); // puerta de 8 s entre preguntas
    assert.strictEqual((await post('/api/ai/ask', { question: '¿pregunta uno?' }, cookie)).status, 200);
    await new Promise(res => setTimeout(res, 8100));
    assert.strictEqual((await post('/api/ai/ask', { question: '¿pregunta dos?' }, cookie)).status, 200);
    const before = geminiCalls;
    const r3 = await post('/api/ai/ask', { question: '¿pregunta tres?' }, cookie);
    assert.strictEqual(r3.status, 429);
    const j3 = await r3.json();
    assert.strictEqual(j3.code, 'AI_LIMIT');
    assert.match(j3.error, /Mañana más/);
    assert.strictEqual(j3.left, 0);
    assert.strictEqual(geminiCalls, before); // ni siquiera llama a Google
  } finally { delete process.env.AI_DAILY_LIMIT; }
});

test('sin API key la IA responde 503 AI_OFF', async () => {
  delete process.env.GEMINI_API_KEY;
  try {
    const cookie = await loginUser();
    const r = await post('/api/ai/ask', { question: '¿funciona?' }, cookie);
    assert.strictEqual(r.status, 503);
    assert.strictEqual((await r.json()).code, 'AI_OFF');
  } finally { process.env.GEMINI_API_KEY = 'test-key'; }
});

test('sin sesión no hay IA', async () => {
  assert.strictEqual((await post('/api/ai/ask', { question: 'hola' })).status, 401);
  assert.strictEqual((await get('/api/ai/quota')).status, 401);
});

