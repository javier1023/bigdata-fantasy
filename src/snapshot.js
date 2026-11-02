'use strict';
/**
 * Convierte los datos crudos de la API en el "snapshot" que consume el front.
 * Misma lógica que el Google Sheet:
 *  - Caja estimada de un rival = 100 M + 100k por día desde su alta (vídeos) + ventas + recompensas - compras
 *    - subidas de cláusula (estimación manual, se aplica en el front).
 *  - Tu caja es la real (la API solo la da para tu equipo).
 *  - Jugadores del sorteo inicial: su "precio de compra" es su valor de mercado el día que el mánager entró.
 */
const POS = { 1: 'Portero', 2: 'Defensa', 3: 'Centrocampista', 4: 'Delantero', 5: 'Entrenador' };
const REWARD_TYPES = new Set([6, 12, 20, 21, 22, 23, 24]);
const TZ = 'Europe/Madrid';

const dayOf = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));

/** Valor del día anterior: último valor publicado antes de hoy (si no hay histórico, el actual). */
function yesterdayValue(history, today, current) {
  let y = current;
  if (Array.isArray(history)) history.forEach(x => { if (String(x.date).slice(0, 10) < today) y = Number(x.marketValue); });
  return y;
}

/** Valor de mercado de un jugador en un día (último valor publicado ese día o antes). */
function valueOn(history, day) {
  if (!Array.isArray(history) || !history.length) return null;
  let v = history[0].marketValue;
  for (const x of history) if (String(x.date).slice(0, 10) <= day) v = x.marketValue;
  return Number(v);
}

function normalizeActivity(activity, managers, players, typeNames) {
  const name = id => id == null ? '' : (managers[String(id)] || ('ex-mánager ' + id));
  return activity.map(a => {
    const t = Number(a.activityTypeId);
    const u1 = name(a.user1Id), u2 = name(a.user2Id);
    let buyer = '', seller = '', category = 'Otro';
    if (t === 1) { buyer = u1; seller = u2; category = 'Mercado'; }
    else if (t === 2) { buyer = u2; seller = u1; category = 'Mercado'; }
    else if (t === 31) { buyer = u1; seller = 'LALIGA'; category = 'Mercado'; }
    else if (t === 33) { buyer = 'LALIGA'; seller = u1; category = 'Mercado'; }
    else if (t === 4) category = 'Blindaje';
    else if (REWARD_TYPES.has(t)) category = 'Recompensa';
    const pid = a.playerMasterId != null ? String(a.playerMasterId) : '';
    const p = pid ? players[pid] : null;
    return {
      id: String(a.id), date: a.createdAt, week: a.weekNumber ?? null, typeId: t, type: typeNames[t] || ('Tipo ' + t),
      manager: u1, counterpart: u2, buyer, seller, category,
      playerId: pid, player: pid ? (p ? p.nickname : 'jugador ' + pid) : '',
      amount: a.amount != null ? Number(a.amount) : null
    };
  }).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

/** IDs de jugadores del sorteo inicial de cada mánager (vendidos sin compra previa o todavía "iniciales"). */
function initialPlayers(rows, squads) {
  const has = {}, init = {}, join = {};
  const add = (m, id) => { (init[m] = init[m] || new Set()).add(id); };
  for (const r of rows) {
    if (r.typeId === 9 && !join[r.manager]) join[r.manager] = r.date;
    if (r.category !== 'Mercado' || !r.playerId) continue;
    if (r.seller && r.seller !== 'LALIGA') {
      if (!has[r.playerId + '|' + r.seller]) add(r.seller, r.playerId);
      delete has[r.playerId + '|' + r.seller];
    }
    if (r.buyer && r.buyer !== 'LALIGA') has[r.playerId + '|' + r.buyer] = true;
  }
  for (const t of squads) {
    const m = t.manager.managerName;
    for (const p of t.players || []) {
      const id = String(p.playerMaster.id);
      if (!has[id + '|' + m]) add(m, id);
    }
  }
  return { init, join };
}

/** IDs cuyo histórico de valor hace falta descargar: iniciales + plantillas actuales. */
function neededPlayerIds(raw) {
  const { managers, players, typeNames } = maps(raw);
  const rows = normalizeActivity(raw.activity, managers, players, typeNames);
  const { init } = initialPlayers(rows, raw.squads);
  const ids = new Set();
  Object.values(init).forEach(s => s.forEach(id => ids.add(id)));
  raw.squads.forEach(t => (t.players || []).forEach(p => ids.add(String(p.playerMaster.id))));
  return [...ids];
}

function maps(raw) {
  const managers = {};
  raw.standing.forEach(s => { managers[String(s.team.manager.id)] = s.team.manager.managerName; });
  const players = {};
  raw.players.forEach(p => { players[String(p.id)] = p; });
  const teams = {};
  raw.teams.forEach(t => { teams[String(t.id)] = { name: t.name, short: t.shortName, badge: t.badgeColor }; });
  const typeNames = {};
  raw.types.forEach(t => { typeNames[Number(t.id)] = String(t.internalDescription || '').replace('Operación de mercado - ', ''); });
  return { managers, players, teams, typeNames };
}

/** Partidos de la jornada con nombre y escudo de cada equipo. */
function buildFixtures(cal, teams) {
  if (!cal || !Array.isArray(cal.matches)) return null;
  const team = id => { const t = teams[String(id)]; return { id: String(id), name: t ? t.name : 'Equipo ' + id, short: t ? t.short : '', badge: t ? t.badge : null }; };
  const mapMatches = list => (list || []).map(m => ({
    id: String(m.id), date: m.matchDate || m.date, state: Number(m.matchState),
    home: team(m.localId), away: team(m.visitorId),
    homeScore: m.localScore, awayScore: m.visitorScore
  })).sort((a, b) => (a.date < b.date ? -1 : 1));
  // Próximos 5 partidos (sin jugar) de cada equipo
  const next = {};
  (cal.upcoming || [{ week: cal.week, matches: cal.matches }]).forEach(w => (w.matches || []).forEach(m => {
    if (Number(m.matchState) === 7) return;
    const date = m.matchDate || m.date;
    [[m.localId, m.visitorId, true], [m.visitorId, m.localId, false]].forEach(([me, opp, home]) => {
      const o = team(opp);
      (next[String(me)] = next[String(me)] || []).push({ week: w.week, date, home, opp: o.id, oppName: o.name, oppShort: o.short, oppBadge: o.badge });
    });
  }));
  Object.keys(next).forEach(k => { next[k] = next[k].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 5); });
  return {
    week: cal.week, opens: cal.opens || null, closes: cal.closes || null, next,
    matches: mapMatches(cal.matches),
    // Jornada mostrada + siguientes (para el selector de jornada)
    weeks: (cal.upcoming || []).filter(w => w.week >= cal.week && (w.matches || []).length).map(w => ({ week: w.week, matches: mapMatches(w.matches) }))
  };
}

function build(raw, histories) {
  const { managers, players, teams, typeNames } = maps(raw);
  const rows = normalizeActivity(raw.activity, managers, players, typeNames);
  const { init, join } = initialPlayers(rows, raw.squads);
  const firstDate = rows.length ? rows[0].date : raw.fetchedAt;
  const today = dayOf(raw.fetchedAt);
  // Valor de ayer: del histórico si se descargó; si no, del mapa común precalculado (raw.yesterday)
  const yest = (id, value) => histories[id] ? yesterdayValue(histories[id], today, value)
    : (raw.yesterday && raw.yesterday[id] != null ? Number(raw.yesterday[id]) : value);

  // Valor inicial de cada jugador del sorteo, al día de alta del mánager
  const initValue = {};
  for (const m of Object.values(managers)) {
    const d = dayOf(join[m] || firstDate);
    initValue[m] = {};
    (init[m] || new Set()).forEach(id => { initValue[m][id] = valueOn(histories[id], d) || 0; });
  }

  // Última compra de cada jugador por cada mánager
  const lastBuy = {};
  for (const r of rows) {
    if (r.category === 'Mercado' && r.buyer && r.buyer !== 'LALIGA' && r.playerId) lastBuy[r.playerId + '|' + r.buyer] = { date: r.date, price: r.amount || 0 };
  }

  // Ex-jugadores: cada venta cierra la posición abierta (compra o inicial)
  const exPlayers = {};
  const open = {};
  const initLeft = {};
  Object.entries(initValue).forEach(([m, o]) => { initLeft[m] = { ...o }; });
  for (const r of rows) {
    if (r.category !== 'Mercado' || !r.playerId) continue;
    if (r.seller && r.seller !== 'LALIGA') {
      const k = r.playerId + '|' + r.seller;
      let o = open[k];
      if (!o && initLeft[r.seller] && initLeft[r.seller][r.playerId] != null) {
        o = { date: join[r.seller] || firstDate, price: initLeft[r.seller][r.playerId], origin: 'Inicial' };
      }
      if (o) {
        const profit = (r.amount || 0) - o.price;
        (exPlayers[r.seller] = exPlayers[r.seller] || []).push({
          playerId: r.playerId, player: r.player, origin: o.origin, buyDate: o.date, buyPrice: o.price,
          sellDate: r.date, sellPrice: r.amount || 0, profit, profitPct: o.price ? profit / o.price : null,
          soldTo: r.buyer
        });
      }
      delete open[k];
      if (initLeft[r.seller]) delete initLeft[r.seller][r.playerId];
    }
    if (r.buyer && r.buyer !== 'LALIGA') open[r.playerId + '|' + r.buyer] = { date: r.date, price: r.amount || 0, origin: 'Compra' };
  }

  const ownTeamId = raw.league.team ? String(raw.league.team.id) : null;
  const ownCash = raw.league.team && raw.league.team.money != null ? Number(raw.league.team.money) : null;
  const owner = {};

  const managerList = raw.standing.map(s => {
    const m = s.team.manager.managerName;
    const squad = raw.squads.find(t => String(t.id) === String(s.team.id)) || { players: [] };
    const squadRows = (squad.players || []).map(p => {
      const pm = p.playerMaster || {};
      const id = String(pm.id);
      owner[id] = m;
      const buy = lastBuy[id + '|' + m];
      const isInit = !buy;
      const buyPrice = buy ? buy.price : (initValue[m][id] ?? null);
      const value = Number(pm.marketValue || 0);
      const yesterday = yest(id, value);
      const team = pm.team ? (teams[String(pm.team.id)] || { name: pm.team.name, badge: pm.team.badgeColor }) : null;
      return {
        playerId: id, player: pm.nickname || pm.name || '', position: POS[pm.positionId] || '',
        team: team ? team.name : '', badge: team ? team.badge : null,
        image: pm.images && pm.images.transparent ? pm.images.transparent['256x256'] : null,
        origin: isInit ? 'Inicial' : 'Compra', buyDate: buy ? buy.date : (join[m] || firstDate), buyPrice,
        value, yesterday, profit: buyPrice != null ? value - buyPrice : null,
        profitPct: buyPrice ? (value - buyPrice) / buyPrice : null,
        clause: p.buyoutClause != null ? Number(p.buyoutClause) : null,
        clauseLockedUntil: p.buyoutClauseLockedEndTime || null
      };
    }).sort((a, b) => b.value - a.value);

    const mine = r => r.manager === m;
    const sum = f => rows.filter(f).reduce((t, r) => t + (r.amount || 0), 0);
    const ex = (exPlayers[m] || []).sort((a, b) => (a.sellDate < b.sellDate ? 1 : -1));
    return {
      id: String(s.team.manager.id), name: m, teamId: String(s.team.id), position: s.position, points: s.points,
      avatar: s.team.manager.avatar || null,
      joined: join[m] || firstDate,
      isMe: ownTeamId === String(s.team.id),
      realCash: ownTeamId === String(s.team.id) ? ownCash : null,
      purchases: sum(r => r.category === 'Mercado' && r.buyer === m),
      sales: sum(r => r.category === 'Mercado' && r.seller === m),
      rewards: sum(r => r.category === 'Recompensa' && mine(r)),
      initialSquadValue: Object.values(initValue[m]).reduce((t, v) => t + v, 0),
      squadValue: squadRows.reduce((t, r) => t + r.value, 0),
      squadValueYesterday: squadRows.reduce((t, r) => t + r.yesterday, 0),
      squad: squadRows,
      exPlayers: ex,
      exProfit: ex.reduce((t, r) => t + r.profit, 0)
    };
  });

  // Últimas 5 jornadas disputadas (según los puntos por jornada de todos los jugadores)
  let lastWeek = 0;
  Object.values(players).forEach(p => (p.weekPoints || []).forEach(w => { if (Number(w.weekNumber) > lastWeek) lastWeek = Number(w.weekNumber); }));
  const weeks = [];
  for (let w = Math.max(1, lastWeek - 4); w <= lastWeek; w++) weeks.push(w);

  const catalog = Object.values(players).map(p => {
    const t = teams[String(p.teamId)];
    const id = String(p.id);
    const value = Number(p.marketValue || 0);
    const yesterday = yest(id, value);
    return {
      id: String(p.id), name: p.nickname, team: t ? t.name : '', badge: t ? t.badge : null,
      position: POS[p.positionId] || '', value, yesterday, change: value - yesterday,
      changePct: yesterday ? (value - yesterday) / yesterday : 0,
      image: p.image || null, bid: raw.bids && raw.bids[id] || null, points: Number(p.points || 0),
      avg: Number(p.averagePoints || 0), owner: owner[id] || null,
      teamId: p.teamId != null ? String(p.teamId) : null, status: p.playerStatus || 'ok',
      last5: weeks.map(w => { const x = (p.weekPoints || []).find(k => Number(k.weekNumber) === w); return x ? Number(x.points) : null; })
    };
  }).sort((a, b) => b.value - a.value);

  // Anuncios vigentes de la liga, no todo el catálogo sin dueño. Fallos de la API se distinguen de un mercado vacío.
  const marketEntries = Array.isArray(raw.market) ? raw.market : raw.market && Array.isArray(raw.market.elements) ? raw.market.elements : null;
  const market = marketEntries && marketEntries.filter(x => x && x.discr === 'marketPlayerLeague' && x.playerMaster && x.playerMaster.id != null &&
    Number.isFinite(Number(x.salePrice)) && Number(x.salePrice) >= 0 && x.expirationDate && !Number.isNaN(Date.parse(x.expirationDate)) && Date.parse(x.expirationDate) > Date.parse(raw.fetchedAt))
    .map(x => ({ id: String(x.id), playerId: String(x.playerMaster.id), salePrice: Number(x.salePrice), expires: x.expirationDate,
      bids: Number(x.numberOfBids) || 0 })).sort((a, b) => Date.parse(a.expires) - Date.parse(b.expires));

  // Resumen semanal (plan básico): se calcula con TODOS los movimientos antes del recorte freemium,
  // pero solo expone agregados (nº de movimientos por mánager, el fichaje más caro y los tuyos).
  const weekAgo = new Date(new Date(raw.fetchedAt).getTime() - 7 * 864e5);
  const weekAgoDay = dayOf(weekAgo);
  const weekRows = rows.filter(r => new Date(r.date) >= weekAgo && r.category === 'Mercado' && r.playerId);
  const meName = (managerList.find(m => m.isMe) || {}).name || null;
  const top = weekRows.filter(r => r.buyer && r.buyer !== 'LALIGA' && r.amount).sort((a, b) => b.amount - a.amount)[0] || null;
  const weekly = {
    week: lastWeek || null, from: weekAgoDay, to: today,
    managers: managerList.map(m => {
      const before = m.squad.reduce((t, p) => { const h = histories[p.playerId]; const v = h ? valueOn(h, weekAgoDay) : null; return t + (v != null && !Number.isNaN(v) ? v : p.value); }, 0);
      return {
        name: m.name, isMe: m.isMe, position: m.position, points: m.points, squadValue: m.squadValue,
        valueWeekAgo: before, change: m.squadValue - before,
        moves: weekRows.filter(r => r.buyer === m.name || r.seller === m.name).length
      };
    }),
    topSigning: top ? { playerId: top.playerId, player: top.player, buyer: top.buyer, seller: top.seller, amount: top.amount, date: top.date } : null,
    myMoves: meName ? weekRows.filter(r => r.buyer === meName || r.seller === meName).map(r => ({
      playerId: r.playerId, player: r.player, date: r.date, amount: r.amount,
      kind: r.buyer === meName ? 'buy' : 'sell', counterpart: r.buyer === meName ? r.seller : r.buyer
    })) : [],
    totalMoves: weekRows.length
  };

  return {
    league: { id: String(raw.league.id), name: raw.league.name },
    weekly, market, marketError: marketEntries ? null : (raw.marketError || 'Mercado no disponible'), bidFetchedAt: raw.bidFetchedAt || null,
    fetchedAt: raw.fetchedAt,
    rules: { startingCash: 100000000, dailyVideoBonus: 100000 },
    weeks,
    fixtures: buildFixtures(raw.calendar, teams),
    managers: managerList,
    activity: rows.slice().reverse(),
    players: catalog
  };
}

module.exports = { build, buildFixtures, neededPlayerIds, yesterdayValue, valueOn, dayOf, initialPlayers, normalizeActivity };

