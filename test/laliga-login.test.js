'use strict';
const test = require('node:test');
const assert = require('node:assert');
const laliga = require('../src/laliga');

const page = `<script>var SETTINGS = {"api": "CombinedSigninAndSignup","csrf": "CSRF1","transId": "StateProperties=abc",
"hosts": {"tenant": "/laligadspprob2c.onmicrosoft.com/B2C_1A_5ULAIP_PARAMETRIZED_SignIn","policy": "B2C_1A_5ULAIP_PARAMETRIZED_SignIn"}}; "ID": "password_login"</script>`;
const res = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

function mock(selfAsserted) {
  const calls = [];
  global.fetch = async (url, opt = {}) => {
    url = String(url); calls.push({ url, opt });
    if (url.includes('/oauth2/v2.0/authorize')) return res(200, page, { 'set-cookie': 'x-ms-cpim-trans=T1; path=/' });
    if (url.includes('/SelfAsserted')) return res(200, selfAsserted);
    if (url.includes('/confirmed')) return res(302, '', { location: 'https://jwt.ms/?state=s&code=CODE123' });
    if (url.includes('/oauth2/v2.0/token')) return res(200, { id_token: 'a.eyJleHAiOjk5OTk5OTk5OTl9.c', refresh_token: 'r' });
    return res(404, 'no');
  };
  return calls;
}

test('login web: email y contraseña → código → token', async () => {
  const orig = global.fetch;
  try {
    const calls = mock({ status: '200' });
    const t = await laliga.login('a@b.com', 'secreta');
    assert.ok(t);
    const sa = calls.find(c => c.url.includes('/SelfAsserted'));
    assert.strictEqual(sa.opt.headers['X-CSRF-TOKEN'], 'CSRF1');
    assert.match(sa.opt.headers.Cookie, /x-ms-cpim-trans=T1/);
    assert.match(sa.opt.body, /password_login=secreta/);
    const tok = calls.find(c => c.url.includes('/token'));
    assert.match(String(tok.opt.body), /code=CODE123/);
    assert.match(String(tok.opt.body), /code_verifier=/);
  } finally { global.fetch = orig; }
});

test('login web: contraseña mala → LOGIN_FAILED; otro error → LOGIN_OTHER', async () => {
  const orig = global.fetch;
  try {
    mock({ status: '400', errorCode: 'AADB2C90053', message: 'MSG-0013' });
    await assert.rejects(laliga.login('a@b.com', 'x'), e => e.code === 'LOGIN_FAILED');
    mock({ status: '400', errorCode: 'AADB2C90157', message: 'Cuenta bloqueada' });
    await assert.rejects(laliga.login('a@b.com', 'x'), e => e.code === 'LOGIN_OTHER' && e.b2c === 'AADB2C90157');
  } finally { global.fetch = orig; }
});

