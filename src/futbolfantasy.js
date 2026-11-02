'use strict';
/**
 * Probabilidad de titularidad de futbolfantasy.com (no está en la API oficial). Solo lectura.
 * 1) Página de "posibles alineaciones" -> enlaces a los 10 partidos de la jornada.
 * 2) Cada partido trae en el HTML, por jugador: data-probabilidad="NN%", data-onceFF="titular|suplente"
 *    y el enlace /jugadores/<slug>/ más el nombre corto (span.truncate-name).
 * 3) Se cruza con los jugadores de la API por nombre (nickname) dentro de los dos equipos del partido.
 * Si la web cambia o falla, devuelve error y la recarga conserva el dato anterior (no rompe la app).
 */
const BASE = 'https://www.futbolfantasy.com';
const LIST_URL = BASE + '/laliga/posibles-alineaciones';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchText(url, ms = 25000) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'es-ES,es;q=0.9' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('futbolfantasy ' + r.status + ' en ' + url.replace(BASE, ''));
  return r.text();
}

/** Enlaces de los partidos de la jornada (bloque principal de la página, no la barra lateral). */
function parseList(html) {
  const end = html.indexOf('</main>');
  const main = end > 0 ? html.slice(0, end) : html;
  const start = main.indexOf('mod proxjornada');
  const block = start >= 0 ? main.slice(start) : main;
  const urls = [];
  const re = /href="(?:https:)?\/\/www\.futbolfantasy\.com(\/partidos\/\d+-[a-z0-9-]+)"/g;
  let m;
  while ((m = re.exec(block))) { const u = BASE + m[1]; if (!urls.includes(u)) urls.push(u); }
  const wk = (html.match(/Jornada\s+(\d{1,2})/) || [])[1];
  return { week: wk ? Number(wk) : null, urls: urls.slice(0, 10) };
}

/** Jugadores de un partido: slug, nombre corto, % y titular/suplente. */
function parseMatch(html) {
  const re = /<div class="jugador_(\d+) [^"]*camiseta-wrapper"[^>]*?data-onceFF="(\w*)"/g;
  const starts = [];
  let m;
  while ((m = re.exec(html))) starts.push({ i: m.index, ffId: m[1], role: m[2].toLowerCase() });
  const out = [], seen = new Set();
  starts.forEach((s, k) => {
    const seg = html.slice(s.i, k + 1 < starts.length ? starts[k + 1].i : s.i + 40000);
    const p = seg.match(/data-probabilidad="(\d{1,3})\s*%"/);
    const slug = seg.match(/href="https?:\/\/www\.futbolfantasy\.com\/jugadores\/([a-z0-9-]+)\/[a-z]/);
    const name = seg.match(/class="truncate-name[^"]*">([^<]+)</);
    if (!p || seen.has(s.ffId)) return;
    seen.add(s.ffId);
    out.push({ ffId: s.ffId, role: s.role, prob: Number(p[1]), slug: slug ? slug[1] : '', short: name ? decode(name[1]).trim() : '' });
  });
  return out;
}

const decode = s => String(s).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&').replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í').replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ');
/** Tokens sin acentos ("Güler" -> ["guler"]) y, aparte, quitando las letras acentuadas ("Güler" -> ["gler"]):
 *  algunos slugs de futbolfantasy pierden la letra acentuada (arda-gler, lex-baena). */
const toks = s => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const toksDrop = s => String(s || '').toLowerCase().replace(/[^a-z0-9 .'-]+/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/** Puntuación de encaje de un nickname de la API con los tokens de futbolfantasy (0 = no encaja). */
function score(nick, ffTokens) {
  let best = 0;
  for (const nt of [toks(nick), toksDrop(nick)]) {
    if (!nt.length) continue;
    const used = new Set();
    let pts = 0, ok = true;
    for (const t of nt) {
      let hit = -1, w = 0;
      ffTokens.forEach((f, k) => {
        if (used.has(k) || hit >= 0) return;
        if (f === t) { hit = k; w = t.length; }
        else if (t.length === 1 && f[0] === t) { hit = k; w = 1; } // inicial: "O. Sancet"
      });
      if (hit < 0 && t.length === 1 && t !== nt[nt.length - 1] && nt.length > 1) continue; // inicial que no aparece: "Pathé I. Ciss", "R. Terrats"
      if (hit < 0) { ok = false; break; }
      used.add(hit); pts += w;
    }
    if (ok) best = Math.max(best, pts);
  }
  return best;
}

/** Alias a mano (slug de futbolfantasy -> nickname de la API) para nombres que no se parecen. Ampliable. */
const ALIAS = {
  'vinicius-junior': 'Vini Jr.', 'javier-hernandez': 'Javi Hernández', 'raul-de-tomas': 'RDT', 'jonny-castro': 'Jonny Otto',
  'alejandro-balde': 'Álex Balde', 'andrei-radu': 'Ionut Radu', 'abde-ezzalzouli': 'Ez Abde', 'aitor-fernandez': 'Aitor Fdez',
  'jon-gorrotxategi': 'Gorrotxa'
};

/** Cruza los jugadores de un partido con los de la API. Los dos equipos se deducen de los cruces sin ambigüedad. */
function matchPlayers(ffPlayers, apiPlayers) {
  // El nombre corto que muestra futbolfantasy ("Giuliano", "Prados") desempata frente al slug completo.
  const cands = f => {
    const alias = ALIAS[f.slug];
    if (alias) return apiPlayers.filter(p => String(p.nickname).trim() === alias).map(p => ({ p, s: 1000 }));
    const ft = [...new Set([...toks(f.slug.replace(/-\d+$/, '')), ...toks(f.short), ...toksDrop(f.short)])];
    const st = toks(f.short);
    return apiPlayers.map(p => {
      const s = score(p.nickname, ft);
      return { p, s: s && st.length && score(p.nickname, st) ? s + 100 : s };
    }).filter(x => x.s > 0);
  };
  const all = ffPlayers.map(f => ({ f, c: cands(f) }));
  const votes = {};
  all.forEach(({ c }) => { if (c.length === 1) votes[c[0].p.teamId] = (votes[c[0].p.teamId] || 0) + 1; });
  const teams = Object.entries(votes).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => String(x[0]));
  const out = {}, missed = [];
  let unmatched = 0;
  all.forEach(({ f, c }) => {
    const inTeam = c.filter(x => teams.includes(String(x.p.teamId))).sort((a, b) => b.s - a.s);
    if (!inTeam.length || (inTeam[1] && inTeam[1].s === inTeam[0].s)) { unmatched++; missed.push(f.short || f.slug); return; }
    const id = String(inTeam[0].p.id);
    if (out[id]) { out[id].dup = true; return; } // dos jugadores de futbolfantasy para el mismo de la API: no se fía de ninguno
    out[id] = { prob: f.prob, role: f.role, name: f.short || f.slug };
  });
  Object.keys(out).forEach(id => {
    if (out[id].dup) { unmatched += 2; missed.push(out[id].name); delete out[id]; } else delete out[id].name;
  });
  return { byId: out, teams, unmatched, missed };
}

/** Descarga y cruza la jornada entera. Devuelve { week, fetchedAt, probs: {playerId: {prob, role}}, matches, unmatched }. */
async function fetchProbabilities(apiPlayers) {
  const list = parseList(await fetchText(LIST_URL));
  if (!list.urls.length) throw new Error('futbolfantasy: no se encontraron partidos en la página de alineaciones');
  const players = apiPlayers.filter(p => p.playerStatus !== 'out_of_league' && p.teamId != null);
  const probs = {};
  let unmatched = 0, total = 0, ok = 0;
  const missed = [];
  const pages = [];
  for (let i = 0; i < list.urls.length; i += 4) { // de 4 en 4 para no cargar su web
    const chunk = await Promise.all(list.urls.slice(i, i + 4).map(u => fetchText(u).then(parseMatch).catch(() => null)));
    pages.push(...chunk);
  }
  pages.forEach(ff => {
    if (!ff || !ff.length) return;
    ok++; total += ff.length;
    const r = matchPlayers(ff, players);
    unmatched += r.unmatched;
    missed.push(...r.missed);
    Object.assign(probs, r.byId);
  });
  if (!Object.keys(probs).length) throw new Error('futbolfantasy: la página ha cambiado, no se pudo leer ninguna probabilidad');
  return { week: list.week, fetchedAt: new Date().toISOString(), probs, matches: ok, players: total, unmatched, missed };
}

module.exports = { fetchProbabilities, parseList, parseMatch, matchPlayers, score, LIST_URL };

