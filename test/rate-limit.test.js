'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantasy-limit-'));
process.env.DATA_DIR = dir;
const { claim, settle } = require('../src/rate-limit');
test('persists cooldown between calls and separates accounts', async () => {
  const now = Date.now();
  const first = await claim('refresh:alice', 1800000, now);
  assert.equal(first.ok, true); assert.ok(first.token);
  assert.equal((await claim('refresh:alice', 1800000, now + 1000)).retryAfter, 1799);
  assert.equal((await claim('refresh:bob', 1800000, now + 1000)).ok, true);
  assert.equal((await claim('refresh:alice', 1800000, now + 1800001)).ok, true);
});

test('lease: failed refresh releases in 15s, success starts 30min at completion', async () => {
  const now = Date.now(), key = 'refresh:case-' + now;
  const first = await claim(key, 180000, now);
  assert.equal((await claim(key, 180000, now + 1000)).ok, false);
  assert.equal(await settle(key, first.token, 15000, now + 10000), true);
  assert.equal((await claim(key, 180000, now + 25000)).ok, true);
  const second = await claim(key, 180000, now + 26000);
  assert.equal(second.ok, false);
  assert.equal(await settle(key, first.token, 15000, now + 27000), false);
  const file = path.join(dir, 'limits', encodeURIComponent(key).replace(/%/g, '_') + '.json');
  const current = JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(current.until, now + 205000);
  assert.equal(await settle(key, current.token, 1800000, now + 40000), true);
  assert.equal((await claim(key, 180000, now + 40*1000 + 1799999)).ok, false);
  assert.equal((await claim(key, 180000, now + 40*1000 + 1800001)).ok, true);
});

