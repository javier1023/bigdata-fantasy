'use strict';
/**
 * "Habla con la IA": cada usuario pregunta cosas de SU liga y se le contesta con los datos
 * reales de su snapshot guardado (no se llama a LaLiga desde aquí).
 * - Modelo: Gemini por API key (nivel gratis). Config: GEMINI_API_KEY (obligatoria),
 *   GEMINI_MODEL (por defecto gemini-3.5-flash-lite, el del nivel gratis generoso) y
 *   AI_DAILY_LIMIT (preguntas por usuario y día, por defecto 10; el día es Europe/Madrid).
 * - La cuota vive en el almacén (Blob en Vercel): ai/quota/<uid>.json -> { day, n }.
 * - Solo se descuenta la pregunta si la IA contesta; si Google falla, la cuota no se mueve.
 */
const store = require('./store');
const { loadSnapshot } = require('./refresh');
const { dayOf } = require('./snapshot');

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const LIMIT = () => Math.max(1, parseInt(process.env.AI_DAILY_LIMIT || '10', 10) || 10);
const MAX_Q = 500;

const m1 = v => (Math.round(Number(v || 0) / 1e5) / 10).toLocaleString('es-ES') + 'M';
const pct = v => v == null ? '' : (v >= 0 ? '+' : '') + Math.round(v * 100) + '%';

/** Texto compacto con lo esencial de su liga (acotado para no fundir tokens). */
function context(snap) {
  const me = (snap.managers || []).find(m => m.isMe);
  const L = [];
  L.push(`Liga "${snap.league.name}" de LaLiga Fantasy, ${(snap.managers || []).length} mánagers. Datos guardados del ${new Date(snap.fetchedAt).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}.`);
  L.push('Reglas: todos empezaron con 100M de caja y ~14 jugadores del sorteo. La caja puede quedar en negativo. Clausulazo = comprar a un rival pagando su cláusula.');
  L.push('Clasificación: ' + (snap.managers || []).slice().sort((a, b) => a.position - b.position)
    .map(m => `${m.position}º ${m.name} ${m.points}pt (plantilla ${m1(m.squadValue)})`).join(', ') + '.');
  if (me) {
    L.push(`Tú eres ${me.name}: ${me.position}º con ${me.points}pt. Caja real: ${me.realCash != null ? m1(me.realCash) : 'desconocida'}. Valor de plantilla: ${m1(me.squadValue)}. Gastado: ${m1(me.purchases)}, ingresado: ${m1(me.sales)}, recompensas: ${m1(me.rewards)}.`);
    L.push('Tu plantilla (jugador, posición, equipo, valor actual, precio de compra y rentabilidad):');
    me.squad.forEach(p => L.push(`- ${p.player} (${p.position}, ${p.team}): ${m1(p.value)}; compra ${p.buyPrice != null ? m1(p.buyPrice) : '?'} (${pct(p.profitPct)})${p.clause != null ? '; cláusula ' + m1(p.clause) : ''}`));
    if (me.exPlayers && me.exPlayers.length) {
      L.push('Tus ventas recientes: ' + me.exPlayers.slice(0, 8).map(x => `${x.player} (compra ${m1(x.buyPrice)}, venta ${m1(x.sellPrice)}, ${x.profit >= 0 ? '+' : ''}${m1(x.profit)})`).join('; ') + '.');
    }
    const mine = (snap.activity || []).filter(a => a.manager === me.name || a.counterpart === me.name).slice(0, 12);
    if (mine.length) L.push('Tus últimos movimientos: ' + mine.map(a => `${a.date.slice(0, 10)} ${a.type}${a.player ? ' ' + a.player : ''}${a.amount != null ? ' ' + m1(a.amount) : ''}`).join('; ') + '.');
  }
  const free = (snap.players || []).filter(p => !p.owner).slice(0, 20);
  if (free.length) L.push('Los libres más caros del mercado ahora: ' + free.map(p => `${p.name} (${p.position}, ${p.team}) ${m1(p.value)} ${pct(p.changePct) + ' hoy'}`).join('; ') + '.');
  const rivals = (snap.managers || []).filter(m => !m.isMe);
  L.push('Plantillas de los rivales:');
  rivals.forEach(m => L.push(`- ${m.name} (${m.position}º): ` + m.squad.map(p => `${p.player} ${m1(p.value)}`).join(', ')));
  return L.join('\n');
}

const SYSTEM = [
  'Eres el asistente de BigData Fantasy, una web donde un grupo de amigos analiza su liga privada de LaLiga Fantasy (el fantasy oficial de LaLiga).',
  'Respondes SIEMPRE en español de España, cercano y breve (3-6 frases, sin listas enormes salvo que las pidan).',
  'Solo sabes lo que hay en los datos de la liga que te pasan debajo. Úsalos para contestar con números concretos cuando los haya.',
  'Si la respuesta no está en los datos, dilo claramente ("eso no lo veo en los datos") en vez de inventarlo. No inventes precios, operaciones ni puntos.',
  'Puedes opinar sobre fantasy con sentido común (a quién vender, pujas, riesgos), pero dejando claro cuándo es opinión y no un dato.',
  'No des consejos financieros ni hables de dinero real: es un juego entre amigos.',
  'Si te preguntan algo que no tiene que ver con la liga o el fantasy, recuerda con gracia que solo hablas de su liga.'
].join(' ');

async function askGemini(question, ctx) {
  const key = process.env.GEMINI_API_KEY;
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL() + ':generateContent?key=' + encodeURIComponent(key);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 25e3);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: 'DATOS DE SU LIGA:\n' + ctx + '\n\nPREGUNTA DEL USUARIO: ' + question }] }],
        generationConfig: { maxOutputTokens: 700, temperature: 0.4 }
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.error && j.error.message) || ('HTTP ' + r.status);
      const e = new Error(msg);
      e.quota = r.status === 429; // cuota gratis de Google agotada (todas las cuentas)
      throw e;
    }
    const text = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [])
      .map(p => p.text || '').join('').trim();
    if (!text) throw new Error('La IA devolvió una respuesta vacía');
    return text.slice(0, 2000);
  } finally { clearTimeout(t); }
}

/** Cuota del día para un usuario: { day, n } (día en horario de Madrid). */
async function quota(uid) {
  const day = dayOf(new Date());
  const q = (await store.get('ai/quota/' + uid + '.json', { fresh: true })) || { day, n: 0 };
  return q.day === day ? q : { day, n: 0 };
}
async function useOne(uid) {
  const q = await quota(uid);
  q.n += 1;
  await store.put('ai/quota/' + uid + '.json', q);
  return q;
}

module.exports = { context, askGemini, quota, useOne, LIMIT, MAX_Q, loadSnapshot };

