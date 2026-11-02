'use strict';
/**
 * Cifrado de credenciales y firma de sesiones.
 * Clave maestra: CREDS_KEY (recomendado: 32+ caracteres aleatorios). Si no existe, se deriva del primer secreto
 * disponible (CRON_SECRET, APP_PASSWORD, LALIGA_PASSWORD) para que la app funcione sin configurar nada; si esa
 * clave cambia, las credenciales guardadas dejan de poder leerse y cada usuario tiene que volver a entrar.
 * - Credenciales: AES-256-GCM (cifrado autenticado), IV aleatorio por valor.
 * - Sesión: cookie firmada con HMAC-SHA256 (no lleva datos sensibles: id de usuario, versión y caducidad).
 * - Id de usuario: HMAC del email en minúsculas (no se guarda el email en claro como nombre de archivo).
 */
const crypto = require('crypto');

function master() {
  const src = process.env.CREDS_KEY || process.env.CRON_SECRET || process.env.APP_PASSWORD || process.env.LALIGA_PASSWORD;
  if (!src) throw Object.assign(new Error('Falta configurar CREDS_KEY en el servidor'), { code: 'NO_KEY' });
  return src;
}
const keySource = () => process.env.CREDS_KEY ? 'CREDS_KEY' : process.env.CRON_SECRET ? 'CRON_SECRET' : process.env.APP_PASSWORD ? 'APP_PASSWORD' : process.env.LALIGA_PASSWORD ? 'LALIGA_PASSWORD' : null;
const subkey = info => Buffer.from(crypto.hkdfSync('sha256', master(), 'fantasy-app', info, 32));

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', subkey('creds-v1'), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

function decrypt(blob) {
  const [v, iv, tag, data] = String(blob || '').split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Credencial cifrada no válida');
  const d = crypto.createDecipheriv('aes-256-gcm', subkey('creds-v1'), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

const userId = email => crypto.createHmac('sha256', subkey('uid-v1')).update(String(email).trim().toLowerCase()).digest('hex').slice(0, 32);

const hmac = s => crypto.createHmac('sha256', subkey('session-v1')).update(s).digest('base64url');
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + hmac(body);
}
function verifySession(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = hmac(body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && p.e > Date.now() ? p : null;
  } catch (e) { return null; }
}

module.exports = { encrypt, decrypt, userId, signSession, verifySession, keySource };

