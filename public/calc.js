/**
 * Cálculos del Panel, idénticos a las fórmulas del Sheet.
 * Se usa en el navegador (window.FantasyCalc) y en los tests (require).
 *
 * Caja estimada de un rival = 100 M + vídeos (100k por día desde su alta, hoy incluido)
 *                             + ventas + recompensas − compras − cláusulas estimadas (manual).
 * Para el usuario se usa su caja real de la API (ya lleva descontadas sus cláusulas).
 * Liquidez = caja + valor de la plantilla ("si lo vendiera todo").
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FantasyCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Fecha yyyy-mm-dd en hora de Madrid. */
  function madridDay(d) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(d instanceof Date ? d : new Date(d));
  }

  function daysInclusive(fromDay, toDay) {
    const a = Date.UTC(+fromDay.slice(0, 4), +fromDay.slice(5, 7) - 1, +fromDay.slice(8, 10));
    const b = Date.UTC(+toDay.slice(0, 4), +toDay.slice(5, 7) - 1, +toDay.slice(8, 10));
    return Math.max(0, Math.round((b - a) / 864e5) + 1);
  }

  function liquidity(manager, rules, opts) {
    opts = opts || {};
    const today = opts.today || madridDay(new Date());
    const clauses = Number(opts.clauses) || 0;
    const days = manager.joined ? daysInclusive(madridDay(manager.joined), today) : 0;
    const videos = days * rules.dailyVideoBonus;
    const real = manager.realCash != null;
    const cash = real
      ? manager.realCash
      : rules.startingCash + videos + manager.sales + manager.rewards - manager.purchases - clauses;
    return {
      real, cash, videos, days, clauses: real ? 0 : clauses,
      squadValue: manager.squadValue,
      total: cash + manager.squadValue
    };
  }

  function squadChange(manager) {
    const diff = manager.squadValue - manager.squadValueYesterday;
    return { diff, pct: manager.squadValueYesterday ? diff / manager.squadValueYesterday : 0 };
  }

  /**
   * Predicción modesta de puntos para el próximo partido.
   * - Racha: media ponderada de las últimas 5 jornadas (la más reciente pesa 5, la más antigua 1),
   *   mezclada con la media de la temporada (65 % racha, 35 % media).
   * - Rival: forma del equipo rival (media de puntos de sus jugadores en esas 5 jornadas) frente a la media de la liga.
   *   Rival flojo sube hasta +20 %, rival fuerte baja hasta −20 %.
   * - Casa +8 %, fuera −7 %.
   * - Estado: lesionado o sancionado = 0; duda = la mitad.
   * - Si hay % de titularidad (futbolfantasy), escala entre 25 % y 100 % según esa probabilidad.
   */
  function teamForms(players) {
    const acc = {};
    let tot = 0, n = 0;
    (players || []).forEach(p => {
      if (!p.teamId || p.position === 'Entrenador') return;
      const pts = (p.last5 || []).filter(v => v != null);
      if (!pts.length) return;
      const avg = pts.reduce((t, v) => t + v, 0) / pts.length;
      const a = acc[p.teamId] = acc[p.teamId] || { t: 0, n: 0 };
      a.t += avg; a.n++; tot += avg; n++;
    });
    const forms = {};
    Object.keys(acc).forEach(k => { forms[k] = acc[k].t / acc[k].n; });
    return { forms, league: n ? tot / n : 0 };
  }

  function predict(p, ctx) {
    ctx = ctx || {};
    const pts = (p.last5 || []).map((v, i) => [v, i + 1]).filter(x => x[0] != null);
    if (!pts.length && !p.avg) return null;
    const wsum = pts.reduce((t, x) => t + x[1], 0);
    const form = wsum ? pts.reduce((t, x) => t + x[0] * x[1], 0) / wsum : null;
    let base = form == null ? Number(p.avg) : p.avg ? 0.65 * form + 0.35 * Number(p.avg) : form;
    const why = [];
    if (form != null) why.push('racha ' + form.toFixed(1).replace('.', ','));
    const next = ctx.next || null;
    let rival = 1, venue = 1;
    if (next) {
      const T = ctx.teams || { forms: {}, league: 0 };
      const f = T.forms[next.opp];
      if (f != null && T.league > 0) {
        rival = Math.max(0.8, Math.min(1.2, 1 + (T.league - f) / T.league * 0.5));
        if (rival >= 1.06) why.push('rival flojo'); else if (rival <= 0.94) why.push('rival fuerte'); else why.push('rival normal');
      }
      venue = next.home ? 1.08 : 0.93;
      why.push(next.home ? 'en casa' : 'fuera');
    }
    let status = 1;
    if (p.status === 'injured' || p.status === 'suspended') { status = 0; why.push(p.status === 'injured' ? 'lesionado' : 'sancionado'); }
    else if (p.status === 'doubtful') { status = 0.5; why.push('duda'); }
    let starter = 1;
    if (ctx.prob != null) { starter = 0.25 + 0.75 * Math.max(0, Math.min(100, ctx.prob)) / 100; why.push(ctx.prob + ' % titular'); }
    const raw = Math.max(0, base) * rival * venue * status * starter;
    return { points: Math.round(raw), raw, form, rival, venue, week: next ? next.week : null, oppShort: next ? (next.oppShort || next.oppName) : null, home: next ? !!next.home : null, why };
  }

  /** Variaciones de días consecutivos publicados; no interpolar si faltó un día. */
  function dailyValues(history) {
    const byDay = new Map();
    (Array.isArray(history) ? history : []).forEach(x => {
      const d = String(x.date || '').slice(0, 10), v = Number(x.value != null ? x.value : x.marketValue);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(v) && v > 0) byDay.set(d, v);
    });
    const list = [...byDay].sort(([a], [b]) => a.localeCompare(b));
    const dayNum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
    return list.map(([date, value], i) => ({ date, value,
      change: i && dayNum(date) - dayNum(list[i-1][0]) === 1 ? value - list[i-1][1] : null }));
  }

  /** Techo de puja basado solo en la trayectoria del jugador, nunca en compras de otros mánagers.
   * Proyecta 10 días con inercia amortiguada: media ponderada de los últimos 5 cambios
   * (más peso a los recientes) + aceleración entre dos últimos días y tres previos.
   * El ajuste de aceleración está acotado al 25% de la media por día y se amortigua
   * en el horizonte; cambios de -3%/+3% del valor actual por día como defensa contra picos.
   * Exige 1% de colchón sobre la oferta favorable +10% del valor proyectado.
   * Las salidas al valor y -10% se enseñan como riesgo: no hay beneficio garantizado.
   */
  function bidEstimate(history, currentValue, fetchedAt) {
    const value = Number(currentValue);
    const rows = dailyValues(history);
    if (!Number.isFinite(value) || value <= 0 || rows.length < 6) return null;
    const last = rows[rows.length - 1];
    if (fetchedAt && (dayNumFor(fetchedAt) - dayNumFor(last.date) > 1 || dayNumFor(last.date) > dayNumFor(fetchedAt))) return null;
    if (Math.abs(last.value - value) > Math.max(100000, value * .01)) return null;
    const changes = rows.slice(-5).map(x => x.change);
    if (changes.some(x => x == null)) return null;
    const weights = [1, 2, 3, 4, 5];
    const trend = changes.reduce((n, x, i) => n + x * weights[i], 0) / 15;
    const previous = (changes[0] + changes[1] + changes[2]) / 3;
    const recent = (changes[3] + changes[4]) / 2;
    const rawAcceleration = recent - previous;
    const accelCap = Math.max(value * .001, Math.abs(trend) * .25);
    const acceleration = Math.max(-accelCap, Math.min(accelCap, rawAcceleration));
    const dailyCap = value * .03;
    let forecast = value;
    for (let i = 0; i < 10; i++) {
      const momentum = trend * Math.pow(.85, i) + acceleration * Math.pow(.6, i);
      forecast += Math.max(-dailyCap, Math.min(dailyCap, momentum));
    }
    forecast = Math.max(0, forecast);
    const roundBid = n => Math.max(0, Math.floor(n / 100000) * 100000);
    const levels = { conservative: roundBid(forecast / 1.05), risky: roundBid(forecast * 1.05 / 1.03), optimistic: roundBid(forecast * 1.1 / 1.01) };
    const max = levels.optimistic;
    return { max, levels, forecast: Math.round(forecast), trend: Math.round(trend), acceleration: Math.round(rawAcceleration),
      horizon: 10, floorOffer: Math.round(forecast * .9), upsideOffer: Math.round(forecast * 1.1),
      floorProfit: Math.round(forecast * .9 - max), upsideProfit: Math.round(forecast * 1.1 - max),
      days: 5, latest: last.date };
  }
  /** Dos compras separadas. Prima heurística sobre el valor del jugador con ventaja,
   * nunca una compensación por la diferencia nominal de valores. Exige datos recientes
   * para ambos: 5 cambios diarios consecutivos y pujas calculables.
   */
  function exchangeEstimate(a, b, historyA, historyB, fetchedAt) {
    if (!a || !b || String(a.id) === String(b.id)) return null;
    const ba = bidEstimate(historyA, a.value, fetchedAt), bb = bidEstimate(historyB, b.value, fetchedAt);
    if (!ba || !bb) return null;
    const valid = p => Number.isFinite(Number(p.value)) && p.value > 0 &&
      Number.isFinite(Number(p.points)) && Number(p.points) >= 0;
    if (!valid(a) || !valid(b)) return null;
    // La proyección usa la misma tendencia y aceleración amortiguadas de la puja.
    // Comparar crecimiento previsto en euros, no solo porcentajes: un 2 % sobre
    // 155 M no equivale en euros al 2 % sobre 28 M.
    const gainA = ba.forecast - a.value, gainB = bb.forecast - b.value;
    const growthEdge = Math.max(-.15, Math.min(.15,
      (gainA - gainB) / Math.max(Math.abs(gainA), Math.abs(gainB), 1e6) * .15));
    const growthRateEdge = Math.max(-.15, Math.min(.15,
      (gainA / a.value - gainB / b.value) * .5));
    // El nivel del mercado amortigua un impulso puntual en un jugador barato,
    // pero nunca anula una previsión de subida claramente superior.
    const valueEdge = Math.max(-.15, Math.min(.15, Math.tanh(Math.log(a.value / b.value)) * .15));
    const edge = .75 * growthEdge + .20 * valueEdge + .05 * growthRateEdge;
    // Una diferencia menor al 2 % no justifica señalar a uno como más fuerte.
    const premiumPct = Math.min(.10, Math.max(0, (Math.abs(edge) - .02) * .7));
    const stronger = premiumPct < .001 ? null : edge > 0 ? 'a' : 'b';
    const base = stronger === 'a' ? a.value : stronger === 'b' ? b.value : 0;
    const premium = stronger ? Math.floor(base * premiumPct / 100000) * 100000 : 0;
    const winner = premium ? stronger : null;
    return { stronger: winner, premium, priceA: a.value + (winner === 'a' ? premium : 0),
      priceB: b.value + (winner === 'b' ? premium : 0), edge,
      signals: { trendA: ba.trend, trendB: bb.trend,
        bidA: ba.levels.optimistic, bidB: bb.levels.optimistic, gainA, gainB } };
  }

  function dayNumFor(date) { const d = String(date).slice(0,10); return Date.UTC(+d.slice(0,4),+d.slice(5,7)-1,+d.slice(8,10))/864e5; }

  return { madridDay, daysInclusive, liquidity, squadChange, teamForms, predict, dailyValues, bidEstimate, exchangeEstimate };
});

