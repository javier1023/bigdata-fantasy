'use strict';
/**
 * Almacén de JSON por clave:
 *  - Vercel: Vercel Blob privado. El SDK se autentica solo con BLOB_READ_WRITE_TOKEN o, en stores nuevos,
 *    con BLOB_STORE_ID + el token OIDC que Vercel da a cada función.
 *  - Local / tests: archivos en DATA_DIR (por defecto data/).
 * Claves usadas: users/<uid>.json (perfil + credenciales cifradas), snap/<uid>.json (datos de su liga),
 * shared.json (datos comunes a todos: jugadores, calendario, titularidad).
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/fantasy' : path.join(__dirname, '..', 'data'));
const PREFIX = 'fantasy/';
const ACCESS = process.env.BLOB_ACCESS || 'private';
const memory = new Map();

const useBlob = () => !process.env.DATA_DIR && !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID || process.env.VERCEL);
const fileOf = key => path.join(DIR, key);

async function put(key, obj) {
  memory.set(key, obj);
  const body = JSON.stringify(obj);
  if (useBlob()) {
    const { put: blobPut } = require('@vercel/blob');
    await blobPut(PREFIX + key, body, { access: ACCESS, allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json' });
    return;
  }
  fs.mkdirSync(path.dirname(fileOf(key)), { recursive: true });
  fs.writeFileSync(fileOf(key), body);
}

async function get(key, { fresh } = {}) {
  if (!fresh && memory.has(key)) return memory.get(key);
  let obj = null;
  if (useBlob()) {
    try {
      const { get: blobGet } = require('@vercel/blob');
      const r = await blobGet(PREFIX + key, { access: ACCESS, useCache: false });
      if (r && r.statusCode === 200) obj = JSON.parse(await new Response(r.stream).text());
    } catch (e) {
      if (!/not.?found|404/i.test(String(e.message))) console.error('Blob get ' + key + ':', e.message);
    }
  } else {
    try { if (fs.existsSync(fileOf(key))) obj = JSON.parse(fs.readFileSync(fileOf(key), 'utf8')); } catch (e) { obj = null; }
  }
  if (obj) memory.set(key, obj); else memory.delete(key);
  return obj;
}

async function del(key) {
  memory.delete(key);
  if (useBlob()) {
    const { del: blobDel } = require('@vercel/blob');
    await blobDel(PREFIX + key).catch(e => console.error('Blob del ' + key + ':', e.message));
    return;
  }
  try { fs.unlinkSync(fileOf(key)); } catch (e) { /* no existía */ }
}

/** Claves bajo un prefijo (p. ej. 'users/'). */
async function list(prefix) {
  if (useBlob()) {
    const { list: blobList } = require('@vercel/blob');
    const out = [];
    let cursor;
    do {
      const r = await blobList({ prefix: PREFIX + prefix, cursor, limit: 1000 });
      r.blobs.forEach(b => out.push(b.pathname.slice(PREFIX.length)));
      cursor = r.hasMore ? r.cursor : null;
    } while (cursor);
    return out;
  }
  const d = fileOf(prefix);
  try { return fs.readdirSync(d).map(f => prefix + f); } catch (e) { return []; }
}

module.exports = { put, get, del, list, useBlob };

