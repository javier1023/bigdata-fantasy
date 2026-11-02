'use strict';
/** Shared admission gate. Vercel Blob's conditional writes avoid the per-instance Map trap.
 * A rejected request never calls LaLiga. Locks expire if a function crashes.
 */
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const store = require('./store');
const PREFIX = 'fantasy/limits/';
const LOCAL = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const blobMode = () => store.useBlob();
const encode = key => encodeURIComponent(String(key)).replace(/%/g, '_');
const lockPath = key => PREFIX + encode(key) + '.json';
const filePath = key => path.join(LOCAL, 'limits', encode(key) + '.json');
const expired = (until, now) => !Number.isFinite(until) || until <= now;
async function claim(key, ms, now = Date.now()) {
  const token = crypto.randomUUID();
  if (!blobMode()) {
    const file = filePath(key); fs.mkdirSync(path.dirname(file), { recursive: true });
    for (let i = 0; i < 3; i++) {
      try { const fd = fs.openSync(file, 'wx'); fs.writeFileSync(fd, JSON.stringify({ until: now + ms, token })); fs.closeSync(fd); return { ok: true, token }; }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      let old; try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { old = {}; }
      if (!expired(Number(old.until), now)) return { ok: false, retryAfter: Math.ceil((old.until - now) / 1000) };
      // Local is a single server; rename avoids publishing a partially written record.
      const tmp = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ until: now + ms, token })); fs.renameSync(tmp, file); return { ok: true, token };
    }
  }
  const { get, put, BlobPreconditionFailedError } = require('@vercel/blob');
  const name = lockPath(key);
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await get(name, { access: 'private', useCache: false });
    let until = 0;
    if (current && current.statusCode === 200) {
      try { until = Number(JSON.parse(await new Response(current.stream).text()).until); } catch (e) { until = 0; }
      if (!expired(until, now)) return { ok: false, retryAfter: Math.ceil((until - now) / 1000) };
    }
    try {
      await put(name, JSON.stringify({ until: now + ms, token }), { access: 'private', addRandomSuffix: false,
        ...(current && current.statusCode === 200 ? { ifMatch: current.blob.etag } : { allowOverwrite: false }), contentType: 'application/json' });
      return { ok: true, token };
    } catch (e) {
      if (!(e instanceof BlobPreconditionFailedError) && !/already exists|precondition|409|412/i.test(String(e.message))) throw e;
    }
  }
  return { ok: false, retryAfter: 5 };
}
/** Finish only our own lease: an old invocation must never clear a newer reservation. */
async function settle(key, token, ms, now = Date.now()) {
  if (!token) return false;
  const next = JSON.stringify({ until: now + ms, token });
  if (!blobMode()) {
    const file = filePath(key);
    let old; try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return false; }
    if (old.token !== token) return false;
    const tmp = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(tmp, next); fs.renameSync(tmp, file);
    return true;
  }
  const { get, put, BlobPreconditionFailedError } = require('@vercel/blob');
  const name = lockPath(key), current = await get(name, { access: 'private', useCache: false });
  if (!current || current.statusCode !== 200) return false;
  const old = JSON.parse(await new Response(current.stream).text());
  if (old.token !== token) return false;
  try {
    await put(name, next, { access: 'private', addRandomSuffix: false, ifMatch: current.blob.etag, contentType: 'application/json' });
    return true;
  } catch (e) { if (e instanceof BlobPreconditionFailedError) return false; throw e; }
}
module.exports = { claim, settle };

