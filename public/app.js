/* BigData Fantasy · interfaz. Sin frameworks: todo el estado vive aquí. */
(function () {
  'use strict';
  const C = window.FantasyCalc;
  const $ = s => document.querySelector(s);
  const LS = { key: 'fantasy.appKey', manager: 'fantasy.manager', clauses: 'fantasy.clauses', snap: 'fantasy.snapshot' };
  let snap = null;

  // ---------- formato ----------
  const nf = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
  const eur = v => nf.format(Math.round(v || 0)) + ' €';
  const mill = v => (v / 1e6).toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' M';
  const signed = (v, f) => (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v));
  const bidCell = (v, value) => Number.isFinite(v) ? v < value ? 'No rentable' : mill(v) : '—';
  const bidLevels = p => `<div class="bid-strip" aria-label="Puja estimada"><span><small>Prudente</small><b>${bidCell(p.bid && p.bid.conservative, p.value)}</b></span><span><small>Arriesgada</small><b>${bidCell(p.bid && p.bid.risky, p.value)}</b></span><span><small>Optimista</small><b>${bidCell(p.bid && p.bid.optimistic, p.value)}</b></span></div>`;
  const pct = p => signed(p * 100, x => x.toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' %');
  const cls = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  const day = d => d ? new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Madrid' }) : '—';
  const hour = d => new Date(d).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
  const tbd = d => Number(new Date(d).toLocaleString('es-ES', { hour: 'numeric', hour12: false, timeZone: 'Europe/Madrid' })) < 4; // LaLiga pone de madrugada los partidos sin horario
  const wday = d => new Date(d).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Madrid' });
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (msg, ms) => { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms || 3000); };

  // ---------- protección de cláusula y jornadas ----------
  const DAY_MS = 864e5;
  const lockLeft = until => until ? new Date(until) - Date.now() : 0;
  function leftText(ms) {
    const d = Math.floor(ms / DAY_MS), h = Math.floor(ms % DAY_MS / 36e5), m = Math.max(1, Math.floor(ms % 36e5 / 6e4));
    return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
  }
  /** Etiqueta del candado: cuenta atrás; en naranja si acaba en menos de 24 h; "Sin protección" si ya acabó. */
  function lockPill(until, showFree) {
    const ms = lockLeft(until);
    // showFree: 'rival' → "🔓 Libre" (se puede clausular ya); true → "🔓 Sin protección" (propios)
    if (ms <= 0) return showFree === 'rival' ? '<span class="pill open">🔓 Libre</span>' : showFree ? '<span class="pill free">🔓 Sin protección</span>' : '';
    return `<span class="pill${ms < DAY_MS ? ' soon' : ''}" title="Hasta ${new Date(until).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}">🔒 ${leftText(ms)}</span>`;
  }
  /** Botón "Añadir alerta" (solo si la protección acaba en menos de 24 h). Abre el diálogo #alert. */
  function calButtons(until, player, manager, mine) {
    const ms = lockLeft(until);
    if (ms <= 0 || ms >= DAY_MS) return '';
    return `<div class="cal"><button type="button" class="cal-btn" data-alert="${esc(JSON.stringify({ until, player, manager, mine: !!mine }))}">⏰ Añadir alerta</button></div>`;
  }
  let alertCtx = null;
  function openAlert(ctx) {
    alertCtx = ctx;
    const end = new Date(ctx.until);
    $('#al-title').textContent = ctx.player + (ctx.mine ? '' : ' · ' + ctx.manager);
    $('#al-sub').textContent = 'La protección acaba ' + wday(end) + ' a las ' + hour(end);
    $('#al-text').value = ctx.mine ? `Blindar a ${ctx.player}` : `Clausular a ${ctx.player} (${ctx.manager})`;
    $('#al-min').value = localStorage.getItem('fantasy.alertMin') || '5';
    syncGoogle();
    document.querySelectorAll('.only-ios').forEach(x => x.classList.toggle('hidden', !IOS));
    document.querySelectorAll('.no-ios').forEach(x => x.classList.toggle('hidden', IOS));
    $('#al-ics').textContent = IOS ? '📅 Añadir al calendario' : '📅 Descargar evento con aviso (.ics)';
    $('#alert').classList.remove('hidden');
  }
  const closeAlert = () => $('#alert').classList.add('hidden');
  /** Calendario del iPhone (y Outlook): .ics con alarma real (VALARM) a los minutos elegidos. */
  function alertIcs() {
    const m = $('#al-min').value, t = $('#al-text').value.trim() || 'Fin de protección';
    localStorage.setItem('fantasy.alertMin', m);
    const d = `Se acaba la protección de cláusula de ${alertCtx.player} (${alertCtx.manager}) a las ${hour(alertCtx.until)}.`;
    location.href = '/api/ics?t=' + encodeURIComponent(t) + '&at=' + encodeURIComponent(new Date(alertCtx.until).toISOString()) + '&m=' + m + '&d=' + encodeURIComponent(d);
    closeAlert();
  }
  /** Enlace a Google Calendar (solo fuera del iPhone). No deja fijar el recordatorio, así que el evento empieza a la hora de la alerta.
   *  En iPhone calendar.google.com es un enlace universal: abre la app de Google Calendar, que ignora el evento precargado,
   *  y deja una pestaña en blanco. Por eso en iOS solo se ofrece el .ics (hoja nativa, con aviso y a elegir calendario, también Google). */
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function googleUrl() {
    if (!alertCtx) return '#';
    const m = Number($('#al-min').value), t = $('#al-text').value.trim() || 'Fin de protección';
    const end = new Date(alertCtx.until), start = new Date(end.getTime() - m * 6e4);
    const g = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const d = `Se acaba la protección de cláusula de ${alertCtx.player} (${alertCtx.manager}) a las ${hour(end)}.`;
    return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(t) + '&dates=' + g(m ? start : end) + '/' + g(m ? end : new Date(end.getTime() + 5 * 6e4)) + '&details=' + encodeURIComponent(d);
  }
  const syncGoogle = () => { $('#al-google').href = googleUrl(); };

  const playerById = id => snap.players.find(x => String(x.id) === String(id));
  function ptsClass(v) { return v == null ? 'na' : v < 0 ? 'bad' : v < 3 ? 'low' : v < 6 ? 'mid' : v < 10 ? 'good' : 'top'; }
  /** 5 cuadrados con los puntos de las últimas 5 jornadas. */
  function last5(id, labels) {
    const p = playerById(id);
    if (!p || !p.last5 || !snap.weeks) return '';
    return `<div class="last5">${p.last5.map((v, i) => `<span class="sq ${ptsClass(v)}" title="Jornada ${snap.weeks[i]}">${labels ? `<small>J${snap.weeks[i]}</small>` : ''}${v == null ? '–' : v}</span>`).join('')}</div>`;
  }

  // ---------- API y sesión ----------
  function isStandalone() { try { return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches; } catch (e) { return false; } }
  function showLogin(msg, social) {
    snap = null;
    try { localStorage.removeItem(LS.snap); } catch (e) { /* nada */ }
    $('#login').classList.remove('hidden'); document.body.classList.add('locked');
    if (!welcomeDone() && !isStandalone() && !social && !getFlow()) { showWelcome(1); return; }
    openSocial(false);
    if (msg) scErr(msg);
  }
  const hideLogin = () => { $('#login').classList.add('hidden'); document.body.classList.remove('locked'); $('#social-card').classList.add('hidden'); };

  // ---------- acceso directo en LaLiga (Google / Apple / Facebook / email) ----------
  const SOCIAL_FLOW = 'ff_social_flow';
  let socialUrlAt = 0, socialRenew = false;
  function showCard() {
    $('#welcome-card').classList.add('hidden');
    $('#social-card').classList.remove('hidden');
    $('#login').scrollTop = 0;
  }

  // ---------- bienvenida de la beta (solo la primera vez en este móvil) ----------
  const WELCOME = 'ff_welcome_done', CONTACT = 'ff_contact_pending';
  const welcomeDone = () => { try { return !!localStorage.getItem(WELCOME); } catch (e) { return true; } };
  let welcomeIn = false; // true = ya tiene sesión (usuarios de antes de la bienvenida): al acabar vuelve a la app
  function openWelcomeLoggedIn() {
    welcomeIn = true;
    $('#login').classList.remove('hidden'); document.body.classList.add('locked');
    $('#wl-login-h').textContent = 'Usas tu cuenta de LaLiga Fantasy';
    const migrated = !!(snap && snap.me && snap.me.social);
    $('#wl-login-txt').textContent = migrated ? 'Ya entraste directamente en LaLiga Fantasy. Guardamos cifrado su permiso para leer tu liga: plantilla, mercado, rivales y puntos.' : 'Entraste antes con email y contraseña de LaLiga Fantasy. Siguen guardados cifrados para actualizar tu liga hasta que vuelvas a entrar con el nuevo método.';
    $('#wl-social-li').classList.add('hidden');
    $('#wl-access-li').textContent = migrated ? 'Tu permiso de lectura se guarda cifrado; la contraseña no pasa por esta web.' : 'Tu contraseña antigua sigue cifrada para la recarga nocturna. Puedes borrar la cuenta o volver a entrar con el nuevo método.';
    $('#wl-done').textContent = 'Entendido, a la app';
    showWelcome(1);
  }
  function finishWelcome() {
    try { localStorage.setItem(WELCOME, '1'); } catch (e) { /* nada */ }
    if (welcomeIn) {
      welcomeIn = false;
      api('/api/me/welcome', { method: 'POST' }).catch(() => {});
      hideLogin();
      return;
    }
    openSocial(false);
  }
  /** Tras cargar la app con sesión: si en el servidor no consta la bienvenida, se sincroniza (ya vista en este móvil) o se enseña una vez. */
  function checkWelcome() {
    if (!snap || !snap.me || snap.me.welcomeSeen || !$('#login').classList.contains('hidden')) return;
    if (welcomeDone()) { api('/api/me/welcome', { method: 'POST' }).then(() => { snap.me.welcomeSeen = true; }).catch(() => {}); return; }
    openWelcomeLoggedIn();
  }
  function showWelcome(n) {
    $('#social-card').classList.add('hidden');
    $('#welcome-card').classList.remove('hidden');
    document.querySelectorAll('#welcome-card .wl-step').forEach(x => x.classList.toggle('hidden', x.dataset.step !== String(n)));
    document.querySelectorAll('#welcome-card .wl-dots i').forEach((d, i) => d.classList.toggle('on', i === n - 1));
    $('#login').scrollTop = 0;
  }
  $('#welcome-card').addEventListener('click', e => { const b = e.target.closest('[data-next]'); if (b) showWelcome(+b.dataset.next); });
  $('#wl-save').onclick = () => {
    const v = $('#wl-email').value.trim().toLowerCase(), err = $('#wl-err');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { err.textContent = 'Ese email no parece válido. Revísalo o toca "Prefiero no dejarlo".'; err.classList.remove('hidden'); return; }
    err.classList.add('hidden');
    if (welcomeIn) api('/api/me/contact', { method: 'POST', body: JSON.stringify({ email: v }) }).catch(() => {});
    else {
      try { localStorage.setItem(CONTACT, v); } catch (e) { /* nada */ }
      api('/api/contact', { method: 'POST', body: JSON.stringify({ email: v }) }).catch(() => {}); // se guarda ya, aunque luego no llegue a entrar
    }
    showWelcome(3);
  };
  // Paso 4: guía para añadirla a la pantalla de inicio (no se enseña si ya está abierta como app instalada)
  const isAndroid = /Android/i.test(navigator.userAgent);
  $('#wl-ios').classList.toggle('hidden', isAndroid);
  $('#wl-android').classList.toggle('hidden', !isAndroid);
  if (isStandalone()) $('.wl-dot4').classList.add('hidden');
  $('#wl-done').onclick = () => { if (isStandalone()) finishWelcome(); else showWelcome(4); };
  $('#wl-a2hs-done').onclick = finishWelcome;
  $('#wl-a2hs-later').onclick = finishWelcome;
  $('#wl-close').onclick = finishWelcome;
  /** Tras entrar, manda al servidor el email de contacto que dejó en la bienvenida (si lo dejó). */
  async function sendContact() {
    let v = null; try { v = localStorage.getItem(CONTACT); } catch (e) { return; }
    if (!v) return;
    try { await api('/api/me/contact', { method: 'POST', body: JSON.stringify({ email: v }) }); localStorage.removeItem(CONTACT); } catch (e) { /* se reintenta en el próximo login */ }
  }
  const getFlow = () => { try { const f = JSON.parse(localStorage.getItem(SOCIAL_FLOW) || 'null'); return f && Date.now() - f.at < 20 * 60e3 ? f : null; } catch (e) { return null; } };
  const setFlow = f => { try { if (f) localStorage.setItem(SOCIAL_FLOW, JSON.stringify(f)); else localStorage.removeItem(SOCIAL_FLOW); } catch (e) { /* nada */ } };
  async function prepareSocial() {
    const a = $('#sc-open');
    a.classList.add('wait'); a.textContent = 'Preparando…';
    try {
      const r = await api('/api/auth/social/start', { method: 'POST' });
      a.href = r.url; socialUrlAt = Date.now();
      setFlow({ at: Date.now(), renew: socialRenew, url: r.url });
      a.textContent = 'Abrir login de LaLiga ↗';
    } catch (e) { a.textContent = 'Reintentar'; a.href = '#'; socialUrlAt = 0; scErr(e.message); }
    finally { a.classList.remove('wait'); }
  }
  const scErr = m => { const e = $('#sc-err'); if (m) { e.textContent = m; e.classList.remove('hidden'); } else e.classList.add('hidden'); };
  function openSocial(renew) {
    socialRenew = !!renew;
    $('#login').classList.remove('hidden'); document.body.classList.add('locked');
    showCard(); scErr('');
    $('#sc-title').textContent = renew ? 'Renovar el acceso (90 días)' : 'Entrar con LaLiga Fantasy';
    $('#sc-back').classList.toggle('hidden', !renew);
    // Si la web se recargó a mitad (típico al volver desde Safari), se reutiliza el enlace del intento en curso:
    // pedir uno nuevo invalidaría el código que el usuario trae copiado.
    const f = getFlow();
    if (f && f.url && !socialUrlAt) { $('#sc-open').href = f.url; socialUrlAt = f.at; }
    if (!socialUrlAt || Date.now() - socialUrlAt > 15 * 60e3) prepareSocial();
  }
  $('#sc-back').onclick = () => { if (socialRenew && snap) { setFlow(null); hideLogin(); } };
  $('#sc-open').onclick = ev => {
    if (!socialUrlAt || Date.now() - socialUrlAt > 18 * 60e3) { ev.preventDefault(); prepareSocial(); scErr('El enlace había caducado. Ya está listo otra vez: vuelve a tocar "Abrir login de LaLiga".'); return; }
  };
  const looksPasted = t => /[?&#]code=|[?&#]error=/.test(t);
  $('#sc-url').oninput = () => { const t = $('#sc-url').value.trim(); $('#sc-url').classList.toggle('ok', looksPasted(t)); if (looksPasted(t)) scErr(''); };
  $('#sc-paste').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      $('#sc-url').value = t.trim(); $('#sc-url').oninput();
      if (looksPasted(t)) $('#sc-go').click();
      else scErr(/^https?:\/\//i.test(t.trim()) ? 'Lo que tienes copiado no es la dirección de jwt.ms. Vuelve a esa página y cópiala con Compartir → Copiar.' : 'Eso que tienes copiado es el contenido de la página, no su dirección. Vuelve a jwt.ms y copia la dirección de la barra de arriba (empieza por https://jwt.ms/?code=): botón Compartir → Copiar.');
    } catch (e) {
      $('#sc-url').focus();
      scErr('Tu navegador no deja pegar con el botón. Mantén el dedo en el recuadro de abajo y elige "Pegar".');
    }
  };
  $('#sc-go').onclick = async () => {
    const url = $('#sc-url').value.trim();
    if (!url) { scErr('Primero pega la dirección de jwt.ms en el recuadro.'); $('#sc-url').focus(); return; }
    if (!/^https?:\/\//i.test(url)) { scErr('Eso que has pegado es el contenido de la página, no su dirección. Vuelve a jwt.ms y copia la dirección de la barra de arriba (empieza por https://jwt.ms/?code=): botón Compartir → Copiar.'); return; }
    const btn = $('#sc-go'); btn.disabled = true; btn.textContent = 'Entrando y cargando tu liga…'; scErr('');
    try {
      const r = await api('/api/auth/social/finish', { method: 'POST', body: JSON.stringify({ url }) });
      $('#sc-url').value = ''; $('#sc-url').classList.remove('ok'); socialUrlAt = 0; setFlow(null);
      const wasRenew = socialRenew;
      if (!wasRenew) localStorage.removeItem(LS.manager);
      hideLogin();
      sendContact();
      if (r.warning) toast(r.warning, 7000); else if (wasRenew) toast('Acceso renovado: 90 días más.', 5000);
      await loadData();
      if (r.pickLeague && snap) { openAccount(); toast('Tienes ' + r.leagues.length + ' ligas privadas. Elige cuál quieres ver en "Liga".', 7000); }
    } catch (e) {
      socialUrlAt = 0; prepareSocial(); // el código ya no vale: prepara un intento nuevo
      scErr(e.message);
    } finally { btn.disabled = false; btn.textContent = 'Entrar'; }
  };
  /** Aviso de caducidad del acceso con red social (el servidor marca warn cuando quedan 7 días o menos). */
  function renderRenew() {
    const so = snap && snap.me && snap.me.social;
    const box = $('#renew');
    if (!so || !so.warn) { box.classList.add('hidden'); return; }
    const d = so.daysLeft;
    $('#renew-txt').textContent = 'Tu acceso con Google, Apple o Facebook caduca ' + (d <= 0 ? 'hoy' : d === 1 ? 'mañana' : 'en ' + d + ' días') + ' (LaLiga lo limita a 90). Renuévalo: es 1 minuto.';
    box.classList.remove('hidden');
  }
  $('#renew-btn').onclick = () => openSocial(true);

  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers);
    const r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts, { headers }));
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && !path.startsWith('/api/auth/')) {
      showLogin(j.code === 'RELOGIN' ? j.error : '', j.social);
      throw Object.assign(new Error(j.error || 'Inicia sesión'), { login: true });
    }
    if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
    return j;
  }

  async function loadData() {
    const cached = localStorage.getItem(LS.snap);
    if (cached && !snap) { try { snap = JSON.parse(cached); render(); } catch (e) { /* ignorar */ } }
    try {
      snap = await api('/api/data');
      const fl = getFlow();
      if (fl && fl.renew) { if ($('#social-card').classList.contains('hidden')) openSocial(true); } else hideLogin();
      try { localStorage.setItem(LS.snap, JSON.stringify(snap)); } catch (e) { /* sin espacio: da igual */ }
      render();
      const m = location.hash.match(/^#p=(\d+)/); if (m) showPlayer(m[1]); else if (location.hash === '#futbolistas') document.querySelector('.tab[data-view=search]').click(); else { const v = { '#proteccion': 'locks', '#hoy': 'today', '#mercado': 'moves', '#jornada': 'week', '#resumen': 'summary', '#vigilar': 'watch', '#ia': 'ai' }[location.hash]; if (v) document.querySelector('.tab[data-view=' + v + ']').click(); }
      adoptServerWatch(); ensurePush();
      checkWelcome();
      // La recarga manual siempre tiene prioridad. El cron nocturno actualiza sin abrir la app.
      // No lanzar un POST silencioso al abrir, que consume el turno y tapa los fallos.
    } catch (e) {
      if (e.login) return;
      toast(snap ? 'Sin conexión: mostrando la última copia' : e.message, 5000);
      if (!snap) $('#updated').textContent = e.message;
    }
  }

  async function doRefresh(silent) {
    const b = $('#refresh');
    if (b.disabled) return;
    b.classList.add('spin'); b.disabled = true;
    if (silent !== true) toast('Actualizando desde LaLiga… (tarda unos segundos)', 20000);
    try {
      await api('/api/refresh', { method: 'POST' });
      await loadData();
      if (silent !== true) toast('Datos actualizados');
    } catch (e) { if (!e.login && silent !== true) toast(e.message, 6000); }
    finally { b.classList.remove('spin'); b.disabled = false; }
  }

  // ---------- plan (freemium) ----------
  const isLocked = k => !!(snap && snap.plan && (snap.plan.locked || []).includes(k));
  /** Plan básico: de las protecciones de toda la liga que acaban en menos de 24 h solo se ve una (la más próxima).
   *  El servidor ya recorta las de rivales; aquí se tapan también las propias y las que han cruzado las 24 h desde la última carga. */
  const soonHiddenSet = () => {
    const hid = new Set();
    if (!isLocked('locks')) return hid;
    const vis = [];
    snap.managers.forEach(m => (m.squad || []).forEach(p => {
      if (p.lockHidden || p.lockSoonHidden) { hid.add(p); return; }
      const l = lockLeft(p.clauseLockedUntil); if (l > 0 && l < DAY_MS) vis.push({ p, l });
    }));
    vis.sort((a, b) => a.l - b.l).slice(1).forEach(x => hid.add(x.p));
    return hid;
  };
  const lockBox = (title, text, fake) => `<div class="locked"><div class="locked-fake" aria-hidden="true">${fake}</div>
      <div class="locked-cta"><div class="lk"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div><b>${esc(title)}</b><span>${esc(text)}</span><button type="button" class="unlock">Desbloquear con Premium</button></div></div>`;
  const blurVal = t => `<span class="blurv unlock" title="Premium"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg><i>${t}</i></span>`;
  const premiumPill = () => `<span class="pill unlock prem"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg> Protección · Premium</span>`;
  // Versión de Google Play (TWA): no se vende nada dentro (Google obliga a usar su sistema de pago)
  if (new URLSearchParams(location.search).get('src') === 'twa' || document.referrer.startsWith('android-app://')) { try { localStorage.setItem('fantasy.twa', '1'); } catch (e) { /* ignorar */ } }
  const inTWA = () => localStorage.getItem('fantasy.twa') === '1';
  const canBuy = () => !!(snap && snap.billing && snap.billing.enabled) && !inTWA();
  function openPass() {
    const B = snap.billing;
    $('#ps-price').textContent = B.priceText;
    $('#ps-terms').textContent = B.terms;
    $('#ps-mode').textContent = B.mode === 'test' ? 'Modo pruebas: usa la tarjeta 4242 4242 4242 4242, no se cobra nada.' : 'Pago seguro con Stripe. Nunca vemos tu tarjeta.';
    $('#ps-consent').checked = false; $('#ps-buy').disabled = true; $('#ps-buy').textContent = 'Comprar pase · ' + B.priceText;
    $('#pass').classList.remove('hidden');
  }
  $('#ps-consent').onchange = e => { $('#ps-buy').disabled = !e.target.checked; };
  $('#ps-cancel').onclick = () => $('#pass').classList.add('hidden');
  $('#pass').onclick = e => { if (e.target.id === 'pass') $('#pass').classList.add('hidden'); };
  $('#ps-buy').onclick = async () => {
    const b = $('#ps-buy'); b.disabled = true; b.textContent = 'Abriendo el pago…';
    try { const r = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ consent: true }) }); location.href = r.url; }
    catch (e) { toast(e.message, 6000); b.disabled = false; b.textContent = 'Comprar pase · ' + snap.billing.priceText; }
  };
  // Vuelta desde Stripe
  (async () => {
    const q = new URLSearchParams(location.search).get('pago');
    if (!q) return;
    history.replaceState(null, '', location.pathname + location.hash);
    if (q === 'cancelado') return toast('Pago cancelado. No se ha cobrado nada.', 5000);
    try {
      const r = await api('/api/billing/confirm?session_id=' + encodeURIComponent(q));
      toast(r.active ? '¡Pase activado! Ya tienes Premium.' : 'Pago recibido. Se activará en unos segundos.', 6000);
      await loadData();
    } catch (e) { if (!e.login) toast(e.message, 6000); }
  })();
  document.addEventListener('click', e => {
    if (!e.target.closest('.unlock')) return;
    if (canBuy()) openPass(); else toast(inTWA() ? 'Función Premium.' : 'Premium llegará pronto. De momento la app está en pruebas.', 5000);
  });

  // ---------- mi cuenta ----------
  function openAccount() {
    if (!snap) return;
    $('#ac-email').textContent = (snap.me && snap.me.email) || '';
    const ls = snap.leagues || [];
    $('#ac-league').disabled = ls.length < 2;
    const hl = snap.hiddenLeagues || [];
    $('#ac-league-hint').textContent = (ls.length < 2 ? 'Tienes 1 liga privada. ¿Has creado o entrado en otra? Búscala aquí abajo.' : 'Tienes ' + ls.length + ' ligas privadas.')
      + (hl.length ? ' Ocultas por ser globales: ' + hl.map(l => l.name).join(', ') + '.' : '');
    $('#ac-league').innerHTML = ls.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
    $('#ac-league').value = snap.leagueId || '';
    const P = snap.plan || {};
    $('#ac-plan').textContent = P.plan === 'premium' ? (P.beta ? 'Plan completo gratis durante la beta' : P.tester ? 'Plan completo (tester)' : P.owner ? 'Administrador · plan completo' + (P.pass ? ' · pase pagado hasta el ' + new Date(P.pass.until).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' }) + (P.pass.test ? ' (pago de prueba)' : '') : '') : P.pass ? 'Pase de temporada activo hasta el ' + new Date(P.pass.until).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' }) + (P.pass.test ? ' (pago de prueba)' : '') : 'Plan completo') : (P.owner ? 'Administrador · viendo el plan básico' : 'Plan básico');
    document.querySelectorAll('#ac-beta [data-beta]').forEach(b => b.classList.toggle('on', b.dataset.beta === (P.betaOpen ? 'on' : 'off')));
    $('#ac-beta-hint').textContent = P.betaOpen ? 'Todos los usuarios tienen el plan completo gratis. Los candados y la compra no se ven. Tú puedes ver el plan básico con "Ver la app como".' : 'Beta cerrada: cada usuario ve su plan (básico, tester o pase pagado).';
    const Bi = snap.billing || {};
    const bst = Bi.state || (Bi.switchOn ? 'on' : 'off');
    document.querySelectorAll('#ac-billing [data-billing]').forEach(b => b.classList.toggle('on', b.dataset.billing === bst));
    $('#ac-billing-hint').textContent = !Bi.configured ? 'Falta la clave de Stripe en Vercel (STRIPE_SECRET_KEY). Aunque la enciendas, no se venderá nada.' : (Bi.mode === 'test' ? 'Clave de PRUEBAS: los pagos no cobran de verdad. ' : 'Clave REAL: se cobra de verdad. ') + (bst === 'on' ? 'Todos los usuarios de plan básico ven el botón de compra.' : bst === 'owner' ? 'Solo tú ves el botón de compra (ponte en "Ver la app como: Plan básico" y toca un candado). Nadie más lo ve.' : 'Nadie ve el botón de compra.');
    $('#ac-admin').classList.toggle('hidden', !P.owner);
    const so = snap.me && snap.me.social;
    $('#ac-social').classList.toggle('hidden', !so);
    if (so) {
      $('#ac-social').innerHTML = 'Entras directamente en LaLiga · acceso válido hasta el ' + esc(new Date(so.expiresAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', timeZone: 'Europe/Madrid' })) + ' (' + so.daysLeft + ' días)<button type="button" id="ac-renew" class="link inline">Renovar ya</button>';
      $('#ac-renew').onclick = () => { closeAccount(); openSocial(true); };
    }
    if (P.owner) { loadTesters(); loadUsers(); loadFailures(); loadFeedback(); }
    document.querySelectorAll('#ac-admin [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === (P.preview ? 'free' : 'premium')));
    $('#acct').classList.remove('hidden');
  }
  const closeAccount = () => $('#acct').classList.add('hidden');
  const drawTesters = l => { $('#ac-testers').innerHTML = l.length ? l.map(e => `<div class="trow"><span>${esc(e)}</span><button type="button" data-rm="${esc(e)}" aria-label="Quitar">Quitar</button></div>`).join('') : '<div class="muted small">Ninguno</div>'; };
  const ago = iso => {
    if (!iso) return '—';
    const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 6e4));
    if (m < 60) return m <= 1 ? 'ahora' : 'hace ' + m + ' min';
    const h = Math.round(m / 60); if (h < 24) return 'hace ' + h + ' h';
    const d = Math.round(h / 24); return d === 1 ? 'ayer' : 'hace ' + d + ' días';
  };
  async function loadUsers() {
    try {
      const r = await api('/api/admin/users');
      $('#ac-users-title').textContent = 'Usuarios registrados · ' + r.count;
      $('#ac-users').innerHTML = r.users.length ? r.users.map(u => `<div class="urow"><div><b>${esc(u.email)}</b><span class="utag${u.role === 'básico' ? '' : ' on'}">${esc(u.role)}</span>${u.needsRelogin ? '<span class="utag warn">debe volver a entrar</span>' : ''}</div>
        ${u.contact ? `<div class="small">📬 <a href="mailto:${esc(u.contact)}">${esc(u.contact)}</a></div>` : ''}<div class="muted small">Activo ${esc(ago(u.lastSeenAt))} · último login ${esc(ago(u.lastLoginAt))} · alta ${u.createdAt ? esc(new Date(u.createdAt).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' })) : '—'}</div></div>`).join('') : '<div class="muted small">Ninguno</div>';
      const pc = r.pendingContacts || [];
      $('#ac-users').insertAdjacentHTML('beforeend', `<div class="muted small ac-sub">Emails de la bienvenida sin cuenta · ${pc.length}</div>` + (pc.length ? pc.map(c => `<div class="urow"><div>📬 <a href="mailto:${esc(c.email)}">${esc(c.email)}</a><span class="utag">sin entrar</span></div><div class="muted small">Lo dejó ${esc(ago(c.at))}</div></div>`).join('') : '<div class="muted small">Ninguno</div>'));
    } catch (e) { $('#ac-users').innerHTML = `<div class="muted small">${esc(e.message)}</div>`; }
  }
  const FAIL_TXT = { noleagues: 'entró, pero la cuenta no tiene ligas (¿cuenta de Facebook/Google/Apple?)', onlyglobal: 'entró, pero solo tiene ligas globales', password: 'LaLiga rechaza email o contraseña', account: 'LaLiga bloquea la cuenta', leagues: 'no se leyeron sus ligas', laliga: 'LaLiga no respondía' };
  async function loadFeedback() {
    try {
      const r = await api('/api/admin/feedback');
      $('#ac-fb-title').textContent = 'Feedback recibido · ' + r.count;
      $('#ac-fb').innerHTML = r.feedback.length ? r.feedback.map(f => `<div class="urow"><b>${esc(f.email)}</b>${f.contact ? `<a class="small" href="mailto:${esc(f.contact)}?subject=${encodeURIComponent('Re: tu feedback de BigData Fantasy')}">📬 ${esc(f.contact)}</a>` : ''}<div class="fbmsg">${esc(f.text)}</div><div class="muted small">${esc(ago(f.at))}</div></div>`).join('') : '<div class="muted small">Nada todavía</div>';
    } catch (e) { $('#ac-fb').innerHTML = `<div class="muted small">${esc(e.message)}</div>`; }
  }
  $('#fb-send').onclick = async () => {
    const t = $('#fb-text'), b = $('#fb-send'), v = t.value.trim();
    if (!v) { toast('Escribe algo antes de enviar'); t.focus(); return; }
    b.disabled = true; b.textContent = 'Enviando…';
    try { await api('/api/feedback', { method: 'POST', body: JSON.stringify({ text: v }) }); t.value = ''; toast('¡Recibido! Gracias por echar una mano 🙌', 4000); }
    catch (e) { if (!e.login) toast(e.message, 5000); }
    finally { b.disabled = false; b.textContent = 'Enviar feedback'; }
  };
  async function loadFailures() {
    try {
      const l = (await api('/api/admin/login-failures')).failures;
      $('#ac-fails-title').textContent = 'Logins fallidos (7 días) · ' + l.length;
      $('#ac-fails').innerHTML = l.length ? l.map(f => `<div class="urow"><b>${esc(f.email)}</b><span class="utag${f.kind === 'password' ? ' warn' : ''}">${esc(FAIL_TXT[f.kind] || f.kind)}</span>${f.b2c && f.kind !== 'password' ? `<span class="utag">${esc(f.b2c)}</span>` : ''}<div class="muted small">${esc(ago(f.at))}</div></div>`).join('') : '<div class="muted small">Ninguno</div>';
    } catch (e) { $('#ac-fails').innerHTML = `<div class="muted small">${esc(e.message)}</div>`; }
  }
  async function loadTesters() { try { drawTesters((await api('/api/testers')).emails); } catch (e) { if (!e.login) toast(e.message, 5000); } }
  $('#ac-tester-form').onsubmit = async e => {
    e.preventDefault(); const v = $('#ac-tester').value.trim(); if (!v) return;
    try { drawTesters((await api('/api/testers', { method: 'POST', body: JSON.stringify({ email: v }) })).emails); $('#ac-tester').value = ''; toast('Tester añadido'); }
    catch (err) { if (!err.login) toast(err.message, 5000); }
  };
  $('#ac-testers').onclick = async e => {
    const b = e.target.closest('[data-rm]'); if (!b || !confirm('¿Quitar a ' + b.dataset.rm + ' de testers?')) return;
    try { drawTesters((await api('/api/testers', { method: 'POST', body: JSON.stringify({ email: b.dataset.rm, remove: true }) })).emails); }
    catch (err) { if (!err.login) toast(err.message, 5000); }
  };
  $('#ac-billing').onclick = async e => {
    const b = e.target.closest('[data-billing]'); if (!b) return;
    const state = b.dataset.billing;
    if (state === 'on' && !confirm('¿Encender la venta del pase para TODOS? Los usuarios de plan básico verán el botón de compra.')) return;
    try { snap.billing = await api('/api/admin/billing', { method: 'POST', body: JSON.stringify({ state }) }); openAccount(); toast(state === 'on' ? 'Venta del pase encendida para todos' : state === 'owner' ? 'Venta en modo prueba: solo la ves tú' : 'Venta del pase apagada'); }
    catch (err) { toast(err.message, 5000); }
  };
  $('#ac-beta').onclick = async e => {
    const b = e.target.closest('[data-beta]'); if (!b) return;
    const on = b.dataset.beta === 'on';
    if (!on && !confirm('¿Cerrar la beta? Los usuarios sin pase ni tester pasarán al plan básico.')) return;
    try { await api('/api/admin/beta', { method: 'POST', body: JSON.stringify({ on }) }); await loadData(); openAccount(); toast(on ? 'Beta abierta: plan completo para todos' : 'Beta cerrada'); }
    catch (err) { toast(err.message, 5000); }
  };
  $('#ac-admin').onclick = async e => {
    const b = e.target.closest('[data-mode]'); if (!b) return;
    try { await api('/api/plan/preview', { method: 'POST', body: JSON.stringify({ mode: b.dataset.mode }) }); closeAccount(); await loadData(); toast(b.dataset.mode === 'free' ? 'Viendo la app como plan básico' : 'Plan completo'); }
    catch (err) { if (!err.login) toast(err.message, 5000); }
  };
  $('#account').onclick = openAccount;
  $('#ac-cancel').onclick = closeAccount;
  $('#acct').onclick = e => { if (e.target.id === 'acct') closeAccount(); };
  $('#ac-logout').onclick = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    closeAccount(); localStorage.removeItem(LS.manager); showLogin();
  };
  $('#ac-delete').onclick = async () => {
    if (!confirm('¿Borrar tu cuenta de esta app? Se eliminan tu acceso cifrado y los datos de tu liga. Tu cuenta de LaLiga Fantasy no se toca.')) return;
    try { await api('/api/auth/delete', { method: 'POST' }); closeAccount(); localStorage.removeItem(LS.manager); showLogin('Cuenta borrada.'); }
    catch (e) { if (!e.login) toast(e.message, 5000); }
  };
  $('#ac-league-scan').onclick = async () => {
    const before = (snap.leagues || []).length;
    closeAccount(); await doRefresh();
    const n = (snap.leagues || []).length;
    openAccount();
    toast(n > before ? 'Encontrada' + (n - before > 1 ? 's ' + (n - before) + ' ligas nuevas' : ' 1 liga nueva') + '. Elígela en "Liga".' : 'LaLiga devuelve ' + n + (n === 1 ? ' liga privada' : ' ligas privadas') + ' para tu cuenta.', 7000);
  };
  $('#ac-league').onchange = async e => {
    closeAccount(); toast('Cargando la liga…', 20000);
    try { await api('/api/league', { method: 'POST', body: JSON.stringify({ leagueId: e.target.value }) }); localStorage.removeItem(LS.manager); await loadData(); toast('Liga cambiada'); }
    catch (err) { if (!err.login) toast(err.message, 6000); }
  };

  // ---------- estado local ----------
  const clauses = () => { try { return JSON.parse(localStorage.getItem(LS.clauses)) || {}; } catch (e) { return {}; } };
  const currentManager = () => snap.managers.find(m => m.id === $('#manager').value) || snap.managers[0];

  // ---------- render ----------
  function render() {
    if (!snap) return;
    renderRenew();
    $('#league').textContent = snap.league.name;
    $('#dr-league').textContent = snap.league.name;
    $('#dr-user').textContent = (snap.me && snap.me.email) || '';
    $('#updated').textContent = 'Actualizado ' + new Date(snap.fetchedAt).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
    const sel = $('#manager');
    const saved = sel.value || localStorage.getItem(LS.manager) || (snap.managers.find(m => m.isMe) || {}).id;
    const ordered = snap.managers.slice().sort((a, b) => (b.isMe - a.isMe) || a.name.localeCompare(b.name));
    sel.innerHTML = ordered.map(m => `<option value="${esc(m.id)}">${esc(m.name)}${m.isMe ? ' (tú)' : ''}</option>`).join('');
    if (saved && snap.managers.some(m => m.id === saved)) sel.value = saved;
    renderClauses();
    renderManager();
    const vis = id => !$('#view-' + id).classList.contains('hidden');
    if (vis('locks')) renderLocks();
    if (vis('moves')) renderMoves();
    if (vis('compare')) compareRender();
    if (vis('today')) renderToday();
    if (vis('week')) renderWeek();
    if (vis('summary')) renderSummary();
    if (vis('watch')) renderWatch();
    checkWatch();
    const wt = document.querySelector('.tab[data-view=watch]');
    if (wt) { let pro = wt.querySelector('.dr-pro'); if (isLocked('watch') && !pro) wt.insertAdjacentHTML('beforeend', '<em class="dr-pro">PRO</em>'); else if (!isLocked('watch') && pro) pro.remove(); }
  }

  function renderManager() {
    const m = currentManager();
    renderWatchCta();
    const ch = C.squadChange(m);
    $('#card-value').innerHTML = `
      <h2>Valor de plantilla</h2>
      <div class="big">${eur(m.squadValue)}</div>
      <span class="delta ${cls(ch.diff)}">${signed(ch.diff, eur)} · ${pct(ch.pct)}</span>
      <p class="muted small" style="margin-top:6px">vs. ayer (${eur(m.squadValueYesterday)})</p>`;

    if (m.liquidityLocked) {
      $('#card-liq').innerHTML = `<h2>Liquidez total</h2>` + lockBox('Liquidez y caja de los rivales', 'Con Premium ves la liquidez total y la caja estimada de cada mánager.',
        `<div class="big">123.456.789 €</div><div class="rows"><div class="row"><span>Caja (est.)</span><b>12.345.678 €</b></div><div class="row"><span>Valor de la plantilla</span><b>${eur(m.squadValue)}</b></div></div>`);
    } else {
    const l = C.liquidity(m, snap.rules, { clauses: clauses()[m.name] });
    $('#card-liq').innerHTML = `
      <h2>Liquidez total</h2>
      <div class="big">${eur(l.total)}</div>
      <p class="muted small" style="margin-top:6px">${l.real ? 'Caja real + valor de la plantilla' : 'Estimada: 100 M + vídeos de 100k diarios desde su alta − cláusulas estimadas'}</p>
      <div class="rows">
        <div class="row"><span>Caja${l.real ? '' : ' (est.)'}</span><b>${eur(l.cash)}</b></div>
        <div class="row"><span>Valor de la plantilla</span><b>${eur(l.squadValue)}</b></div>
        ${l.real ? '' : `<div class="row"><span>Vídeos (${l.days} días)</span><b class="pos">+${eur(l.videos)}</b></div>
        <div class="row"><span>Cláusulas subidas (est.)</span><b class="neg">${l.clauses ? '−' + eur(l.clauses) : '0 €'}</b></div>`}
      </div>`;
    }

    const cur = m.squad.reduce((t, p) => t + p.profit, 0);
    const total = cur + m.exProfit;
    $('#card-summary').innerHTML = `
      <h2>Resumen</h2>
      <div class="rows" style="border:0;margin:0;padding:0">
        <div class="row"><span>Puntos</span><b>${nf.format(m.points || 0)}</b></div>
        <div class="row"><span>Jugadores en plantilla</span><b>${m.squad.length}</b></div>
        ${m.profitLocked ? `<div class="row"><span>Rentabilidad plantilla actual</span>${blurVal('+12.345.678 €')}</div>
        <div class="row"><span>Rentabilidad ex-jugadores</span>${blurVal('+1.234.567 €')}</div>
        <div class="row"><span>Rentabilidad total del mánager</span>${blurVal('+13.580.245 €')}</div>` : `<div class="row"><span>Rentabilidad plantilla actual</span><b class="${cls(cur)}">${signed(cur, eur)}</b></div>
        <div class="row"><span>Rentabilidad ex-jugadores</span><b class="${cls(m.exProfit)}">${signed(m.exProfit, eur)}</b></div>
        <div class="row"><span>Rentabilidad total</span><b class="${cls(total)}">${signed(total, eur)}</b></div>`}
        <div class="row"><span>En la liga desde</span><b>${day(m.joined)}</b></div>
      </div>`;

    $('#squad').innerHTML = m.squad.length ? m.squad.slice().sort((a, b) => b.value - a.value).map(p => {
      const d = p.value - p.yesterday;
      const soon = !m.isMe && lockLeft(p.clauseLockedUntil) > 0 && lockLeft(p.clauseLockedUntil) < DAY_MS;
      return `<div class="item${soon ? ' target' : ''}" data-player="${esc(p.playerId)}">
        <img class="face" loading="lazy" src="${esc(p.image || '')}" alt="">
        <div class="main">
          <div class="name">${esc(p.player)}</div>
          <div class="sub">${p.badge ? `<img class="badge" src="${esc(p.badge)}" alt="">` : ''}${esc(p.position || '')}</div>
          <div class="sub">${esc(p.origin)}${m.profitLocked ? '' : ' ' + mill(p.buyPrice)}${p.buyDate ? ' · ' + day(p.buyDate) : ''}</div>
          <div class="sub wrap">Cláusula ${eur(p.clause)} ${p.lockHidden ? premiumPill() : lockPill(p.clauseLockedUntil, m.isMe ? false : 'rival')}</div>
          ${calButtons(p.clauseLockedUntil, p.player, m.name, m.isMe)}
          ${last5(p.playerId)}
        </div>
        <div class="right">
          <div class="v">${mill(p.value)}</div>
          <div class="p ${cls(d)}">hoy ${signed(d, mill)} · ${pct(p.yesterday ? d / p.yesterday : 0)}</div>
          ${m.profitLocked ? `<div class="sub total" style="white-space:normal;max-width:118px;margin-left:auto;text-align:right;line-height:1.25">Rentabilidad total del mánager<br>${blurVal('+1,2 M')}</div>` : `<div class="sub total ${cls(p.profit)}">total ${signed(p.profit, mill)} · ${pct(p.profitPct || 0)}</div>`}
        </div>
      </div>`;
    }).join('') : '<div class="empty">Sin jugadores</div>';

    const exRow = p => `
      <div class="item" data-player="${esc(p.playerId)}">
        <div class="main">
          <div class="name">${esc(p.player)}</div>
          <div class="sub wrap">${esc(p.origin)} ${mill(p.buyPrice)} (${day(p.buyDate)}) → venta ${mill(p.sellPrice)} (${day(p.sellDate)})${p.soldTo ? ' a ' + esc(p.soldTo) : ''}</div>
        </div>
        <div class="right">
          <div class="p ${cls(p.profit)}">${signed(p.profit, mill)}</div>
          <div class="sub">${pct(p.profitPct || 0)}</div>
        </div>
      </div>`;
    const exFake = n => Array.from({ length: Math.min(n, 3) }, (_, i) => `<div class="item"><div class="main"><div class="name">Jugador ${i + 1}</div><div class="sub">Compra 1,2 M → venta 2,3 M</div></div><div class="right"><div class="p pos">+1,1 M</div></div></div>`).join('');
    $('#ex').innerHTML = m.profitLocked && (m.exPlayers.length || m.exHidden)
      ? m.exPlayers.map(exRow).join('')
        + (m.exHidden ? lockBox(`${m.exHidden === 1 ? '1 venta más' : m.exHidden + ' ventas más'}`, 'Con Premium ves todo su histórico de ventas: a qué precio compró y vendió cada jugador y cuánto ganó.', exFake(m.exHidden)) : '')
        + `<div class="row" style="border-top:1px solid var(--line);padding-top:8px"><span>Total ex-jugadores</span>${blurVal('+1.234.567 €')}</div>`
      : m.exPlayers.length ? m.exPlayers.map(exRow).join('') + `<div class="row" style="border-top:1px solid var(--line);padding-top:8px"><span>Total ex-jugadores</span><b class="${cls(m.exProfit)}">${signed(m.exProfit, eur)}</b></div>`
      : '<div class="empty">Todavía no ha vendido a nadie</div>';
  }

  /** Cláusulas estimadas del mánager elegido, junto al selector. Javier usa su caja real (ya las descuenta). */
  function renderClauses() {
    const m = currentManager();
    const real = m.realCash != null;
    const v = clauses()[m.name];
    $('#clause').classList.toggle('hidden', real || !!m.liquidityLocked);
    document.querySelector('.clause-box').classList.toggle('hidden', !!m.liquidityLocked);
    $('#clause-real').classList.toggle('hidden', !real);
    if (document.activeElement !== $('#clause')) $('#clause').value = v ? nf.format(v) : '';
  }

  // ---------- comparador de intercambio ----------
  const comparePick = { a: null, b: null };
  let compareSerial = 0;
  function compareChoices(side, query) {
    const box = $('#compare-' + side + '-results');
    const norm = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const q = norm(query.trim());
    if (!snap || !q) { box.innerHTML = ''; return; }
    const other = comparePick[side === 'a' ? 'b' : 'a'];
    const found = snap.players.filter(p => String(p.id) !== other && norm(p.name).includes(q)).slice(0, 8);
    box.innerHTML = found.map(p => `<button type="button" data-compare-pick="${side}" data-id="${esc(p.id)}" role="option">${esc(p.name)} <small>${esc(p.team)} · ${mill(p.value)}</small></button>`).join('') || '<div class="empty">Ningún jugador con ese nombre</div>';
  }
  function compareCell(x, extra) { return `<div class="compare-v">${x}${extra ? `<small>${extra}</small>` : ''}</div>`; }
  function compareRow(label, left, right) { return `<div class="compare-row">${left}<span class="compare-label">${label}</span>${right}</div>`; }
  function compareRender() {
    const box = $('#compare-output');
    if (!snap) return;
    const a = snap.players.find(p => String(p.id) === comparePick.a), b = snap.players.find(p => String(p.id) === comparePick.b);
    if (!a || !b) { box.innerHTML = '<div class="empty">Elige dos jugadores para compararlos.</div>'; return; }
    if (a.id === b.id) { box.innerHTML = '<div class="empty">Elige dos jugadores distintos.</div>'; return; }
    const serial = ++compareSerial;
    box.innerHTML = '<article class="card"><h2>Intercambio estimado</h2><p class="muted small">Cargando el histórico reciente de los dos jugadores…</p></article>';
    // El servidor limita a una petición de histórico por usuario cada 2 s cuando no está cacheado.
    // Espaciar las dos consultas evita que una respuesta 429 suprima la prima sin motivo.
    (async () => {
      const ha = await api('/api/player/' + encodeURIComponent(a.id) + '/history').catch(() => null);
      if (serial !== compareSerial) return;
      await new Promise(resolve => setTimeout(resolve, 2200));
      if (serial !== compareSerial) return;
      const hb = await api('/api/player/' + encodeURIComponent(b.id) + '/history').catch(() => null);
      return [ha, hb];
    })().then(histories => {
      if (!histories) return;
      const [ha, hb] = histories;
      if (serial !== compareSerial || comparePick.a !== String(a.id) || comparePick.b !== String(b.id)) return;
      const estimate = C.exchangeEstimate(a,b,ha,hb,snap.fetchedAt);
      const prices = estimate ? `<div class="compare-row"><div class="compare-v">${mill(a.value)}<small>valor de ${esc(a.name)}</small></div><span class="compare-label">Tu amigo te paga</span>${compareCell(mill(estimate.priceA), estimate.stronger === 'a' ? '+' + mill(estimate.premium) + ' de prima' : 'sin prima')}</div>
        <div class="compare-row"><div class="compare-v">${mill(b.value)}<small>valor de ${esc(b.name)}</small></div><span class="compare-label">Tú pagas</span>${compareCell(mill(estimate.priceB), estimate.stronger === 'b' ? '+' + mill(estimate.premium) + ' de prima' : 'sin prima')}</div>
        <p class="compare-verdict">${estimate.premium ? `Prima orientativa: ${mill(estimate.premium)} sobre el valor de ${esc(estimate.stronger === 'a' ? a.name : b.name)}.` : 'Fuerza parecida: los dos al valor, sin prima estimada.'}</p>` : `<p class="muted small">Sin histórico diario reciente y consecutivo de ambos, no podemos estimar una prima. Como punto de partida, ${esc(a.name)} al valor de ${mill(a.value)} y ${esc(b.name)} al valor de ${mill(b.value)}.</p>`;
      const recent = h => C.dailyValues(h).slice(-5);
      const histA = recent(ha), histB = recent(hb);
      const validBars = rows => rows.length === 5 && rows.every(r => Number.isFinite(r.change));
      const scale = Math.max(1, ...histA.concat(histB).map(r => Math.abs(r.change || 0)));
      const bars = rows => !validBars(rows) ? '<span class="muted small">Sin datos</span>' :
        '<div class="compare-bars" role="img" aria-label="Últimos 5 cambios diarios, de antiguo a reciente: ' + esc(rows.map(r => (r.change >= 0 ? '+' : '−') + eur(Math.abs(r.change))).join(', ')) + '">' +
        rows.map(r => '<span class="compare-bar ' + (r.change > 0 ? 'up' : r.change < 0 ? 'down' : 'flat') + '" style="height:' + Math.round(5 + Math.abs(r.change) / scale * 25) + 'px" title="' + esc(day(r.date) + ': ' + signed(r.change, eur)) + '"></span>').join('') + '</div>';
      const pace = (p,k) => estimate ? `${signed(estimate.signals[k], eur)}/día` : 'Sin datos';
      const games = p => (snap.fixtures && snap.fixtures.next && snap.fixtures.next[p.teamId] || []).slice(0, 3);
      const game = x => '<div class="compare-game ' + (x.home ? 'home' : 'away') + '"><small>J' + esc(x.week) + ' · ' + (x.home ? 'Casa' : 'Fuera') + '</small><b>' + esc(x.oppShort || x.oppName || 'Rival') + '</b><small>' + (x.date ? esc(day(x.date)) + (tbd(x.date) ? '' : ' · ' + esc(hour(x.date))) : 'Hora pendiente') + '</small></div>';
      const next = p => { const list = games(p), n = snap.fixtures && snap.fixtures.nextHidden && snap.fixtures.nextHidden[p.teamId] || 0;
        return '<div class="compare-games">' + (list.length ? list.map(game).join('') : '<span class="muted small">Sin calendario</span>') + (n && list.length < 3 ? '<div class="compare-game locked-game"><small>Jornadas siguientes</small><b>🔒 Premium</b><small>' + Math.min(n, 3 - list.length) + ' partido(s)</small></div>' : '') + '</div>'; };

      box.innerHTML = `<article class="card compare-card"><h2>Intercambio estimado</h2><p class="muted small">Cada uno compra el jugador del otro. Ningún precio baja del valor actual.</p>${prices}
        <p class="muted small compare-disclaimer">${estimate ? 'Modelo orientativo: proyectamos el valor a 10 días con tendencia y aceleración amortiguadas, como en la puja rentable. Lo que más pesa es la subida prevista en euros (75 %). El valor actual matiza el nivel del jugador (20 %) y el crecimiento porcentual pesa un 5 %. Los puntos pasados no deciden la prima. El valor no es dinero a compensar en el trueque. Si la diferencia es pequeña, prima 0. Si no, la prima va solo sobre el jugador con ventaja, redondeada a 100.000 € y con tope del 10 % de su valor. Es una previsión, no una subida garantizada.' : 'No inventamos prima cuando faltan datos; puedes seguir comparando las cifras disponibles.'}</p></article>
        <article class="card compare-card"><h2>Precio y tendencia</h2>${compareRow('Valor actual',compareCell(mill(a.value)),compareCell(mill(b.value)))}${compareRow('Hoy',compareCell(signed(a.change || 0, mill)),compareCell(signed(b.change || 0, mill)))}${compareRow('5 días',bars(histA),bars(histB))}${compareRow('Ritmo / día',compareCell(pace(a,'trendA')),compareCell(pace(b,'trendB')))}</article>
        <article class="card compare-card"><h2>Rendimiento</h2>${compareRow('Total puntos',compareCell(nf.format(a.points || 0)),compareCell(nf.format(b.points || 0)))}${compareRow('Puntos / M',compareCell(ppm(a) < 0 ? 'Sin datos' : ppm(a).toLocaleString('es-ES',{maximumFractionDigits:1})),compareCell(ppm(b) < 0 ? 'Sin datos' : ppm(b).toLocaleString('es-ES',{maximumFractionDigits:1})))}</article>
        <article class="card compare-card"><h2>Próximos partidos</h2><div class="compare-row compare-fixtures">${next(a)}<span class="compare-label">Hasta 3 por jugador</span>${next(b)}</div></article>
        <p class="muted small">Precios orientativos: el valor y la tendencia pueden cambiar.</p>`;
    });
  }
  ['a','b'].forEach(side => {
    const input = $('#compare-' + side + '-search');
    input.oninput = () => { comparePick[side] = null; ++compareSerial; compareChoices(side,input.value); compareRender(); };
    input.onfocus = () => compareChoices(side,input.value);
  });
  $('#view-compare').onclick = e => {
    const choice = e.target.closest('[data-compare-pick]'); if (!choice) return;
    const side = choice.dataset.comparePick, p = snap.players.find(x => String(x.id) === choice.dataset.id);
    if (!p) return;
    comparePick[side] = String(p.id);
    $('#compare-' + side + '-search').value = p.name;
    $('#compare-' + side + '-results').innerHTML = '';
    compareRender();
  };

  // ---------- buscador ----------
  const SORTS = {
    change: (a, b) => b.change - a.change,
    value: (a, b) => b.value - a.value,
    name: (a, b) => a.name.localeCompare(b.name, 'es'),
    points: (a, b) => b.points - a.points,
    bargain: (a, b) => ppm(b) - ppm(a),
    pred: (a, b) => ((predFor(b) || { raw: -1 }).raw - (predFor(a) || { raw: -1 }).raw)
  };
  // Gangas: puntos por millón de valor. Mínimo 15 puntos y 1 M de valor para no premiar a quien jugó un partido bueno
  // ni a los de 0,5 M que casi no juegan; sin entrenadores (no son fichables como jugadores de campo).
  const ppm = p => (p.points >= 15 && p.value >= 1e6 && p.position !== 'Entrenador' && p.status !== 'out_of_league') ? p.points / (p.value / 1e6) : -1;
  function bidBlock(p, history) {
    const b = C.bidEstimate(history, p.value, snap.fetchedAt);
    if (!b) return `<article class="card bid-card"><h2>Puja máxima rentable</h2><p class="muted small">No hay suficientes valores diarios recientes y consecutivos para calcular una puja con criterio. El precio actual, por sí solo, no basta.</p></article>`;
    const a = b.acceleration > 50000 ? 'acelera' : b.acceleration < -50000 ? 'se frena' : 'se mantiene';
    const levelInfo = [
      ['conservative','Conservador','Venta al valor previsto · margen 5 %'],
      ['risky','Arriesgado','Oferta +5 % · margen 3 %'],
      ['optimistic','Optimista','Oferta +10 % · margen 1 %']
    ];
    const viable = key => b.levels[key] >= p.value;
    const selected = ['optimistic','risky','conservative'].find(viable);
    const choices = levelInfo.map(([key,label,detail]) => `<button type="button" class="bid-level ${key === selected ? 'on' : ''}" data-bid-level="${key}" aria-pressed="${key === selected}" ${viable(key) ? '' : 'disabled'}><span class="bid-name">${label}</span><b>${bidCell(b.levels[key], p.value)}</b><small>${viable(key) ? detail : 'La puja mínima es su valor actual'}</small></button>`).join('');
    const risks = key => {
      const bid = b.levels[key];
      return `<div class="row"><span>Oferta −10 %</span><b class="${cls(b.floorOffer - bid)}">${signed(b.floorOffer - bid, eur)}</b></div>
      <div class="row"><span>Oferta al valor previsto</span><b class="${cls(b.forecast - bid)}">${signed(b.forecast - bid, eur)}</b></div>
      <div class="row"><span>Oferta +10 %</span><b class="${cls(b.upsideOffer - bid)}">${signed(b.upsideOffer - bid, eur)}</b></div>`;
    };
    // Change scenarios without re-fetching the same market history.
    setTimeout(() => {
      const box = $('#bid-estimate');
      if (!box) return;
      box.querySelectorAll('[data-bid-level]').forEach(button => button.onclick = () => {
        const key = button.dataset.bidLevel;
        box.querySelectorAll('[data-bid-level]').forEach(other => { other.classList.toggle('on', other === button); other.setAttribute('aria-pressed', String(other === button)); });
        box.querySelector('.bid-risks').innerHTML = risks(key);
        box.querySelector('.bid-risk-label').textContent = `Si pujas ${eur(b.levels[key])}, diferencia al vender según la oferta de LaLiga:`;
        box.querySelector('.bid-warning').textContent = key === 'optimistic' ? 'El optimista solo deja beneficio si aciertas la subida y llega la mejor oferta. Puedes perder mucho dinero.' : 'La subida prevista y la oferta no están garantizadas: también puedes perder dinero.';
      });
    }, 0);
    return `<article class="card bid-card"><h2>Puja máxima estimada</h2>
      <div class="bid-levels">${choices}</div>
      <p class="muted small">Sus últimos 5 cambios dan ${signed(b.trend, eur)} al día; la subida ${a}. Proyectamos ${eur(b.forecast)} en 10 días con esa inercia amortiguada. Cada nivel supone una oferta y un margen distintos; ninguno garantiza ganar.</p>
      <p class="muted small bid-risk-label">${selected ? `Si pujas ${eur(b.levels[selected])}, diferencia al vender según la oferta de LaLiga:` : 'No hay puja rentable: la mínima es su valor actual.'}</p>
      <div class="rows bid-risks">${selected ? risks(selected) : ''}</div>
      <p class="muted small bid-warning">${selected === 'optimistic' ? 'El optimista solo deja beneficio si aciertas la subida y llega la mejor oferta. Puedes perder mucho dinero.' : selected ? 'La subida prevista y la oferta no están garantizadas: también puedes perder dinero.' : 'Si el jugador sigue bajando, incluso la puja mínima podría darte pérdidas.'}</p>
      <p class="muted small">Las ofertas de LaLiga pueden ir de −10 % a +10 % sobre el valor futuro. Son hipótesis, no una fórmula oficial de LaLiga. No usamos compras de otros mánagers.</p>
      ${p.owner ? '<p class="muted small">Ya tiene dueño: estas cifras son una referencia, no su cláusula.</p>' : ''}</article>`;
  }
  function playerPortrait(p) {
    const initials = String(p.name || '?').split(/\s+/).map(x => x[0]).join('').slice(0,2).toUpperCase();
    const url = String(p.image || '').startsWith('https://') || String(p.image || '').startsWith('data:image/') ? p.image : '';
    return `<span class="player-portrait">${url ? `<img src="${esc(url)}" alt="" onerror="this.style.display='none'">` : ''}<span>${esc(initials)}</span></span>`;
  }
  function dailyDetail(history) {
    const rows = C.dailyValues(history).filter(x => x.change != null).slice(-15).reverse();
    if (!rows.length) return '<div class="empty">No hay suficientes días consecutivos en el histórico.</div>';
    return `<div class="daily-history">${rows.map(x => `<div class="row"><span>${day(x.date)}</span><b class="${cls(x.change)}">${signed(x.change, eur)}</b></div>`).join('')}</div>
      <p class="muted small">Cada cifra compara el valor publicado ese día con el anterior. Si falta algún día, no lo inventamos.</p>`;
  }
  function historyTabs(history) {
    const box = $('#chart');
    box.innerHTML = `<h2>Valor de mercado</h2><div class="seg history-tabs"><button type="button" data-history="chart" class="on" aria-pressed="true">Gráfica</button><button type="button" data-history="daily" aria-pressed="false">Día a día</button></div>
      <div id="history-view">${chart(history)}</div>`;
    box.querySelectorAll('[data-history]').forEach(button => button.onclick = () => {
      const daily = button.dataset.history === 'daily';
      box.querySelectorAll('[data-history]').forEach(b => { b.classList.toggle('on', b === button); b.setAttribute('aria-pressed', String(b === button)); });
      box.querySelector('#history-view').innerHTML = daily ? dailyDetail(history) : chart(history);
    });
  }
  const STATUS = { injured: '🚑 Lesionado', doubtful: '❓ Duda', suspended: '🟥 Sancionado' };
  const statusPill = st => STATUS[st] ? `<span class="pill st-${esc(st)}">${STATUS[st]}</span>` : '';
  let filterSnap = null;
  function fillPlayerFilters() {
    if (!snap || filterSnap === snap) return;
    filterSnap = snap;
    const options = (id, values, label) => {
      const el = $(id), old = el.value;
      el.innerHTML = `<option value="">${label}</option>` + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
      el.value = values.includes(old) ? old : '';
    };
    options('#pf-team', [...new Set(snap.players.map(p => p.team).filter(Boolean))].sort((a,b) => a.localeCompare(b,'es')), 'Todos los equipos');
    options('#pf-owner', [...new Set(snap.managers.map(m => m.name))].sort((a,b) => a.localeCompare(b,'es')), 'Todos los mánagers');
    options('#pf-position', [...new Set(snap.players.map(p => p.position).filter(Boolean))].sort((a,b) => a.localeCompare(b,'es')), 'Todas las posiciones');
  }
  function search(q) {
    const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const n = norm(q.trim());
    $('#player').classList.add('hidden');
    $('#results').classList.remove('hidden');
    $('#sort-wrap').classList.remove('hidden');
    $('#player-filters').classList.remove('hidden');
    $('#filter-count').classList.remove('hidden');
    if (!snap) return;
    fillPlayerFilters();
    const sort = $('#sort').value, team = $('#pf-team').value, owner = $('#pf-owner').value,
      position = $('#pf-position').value, price = $('#pf-price').value, form = $('#pf-form').value, afford = $('#pf-afford').value;
    const cash = (snap.managers.find(m => m.isMe) || {}).realCash;
    const marketMin = new Map((snap.market || []).map(m => [m.playerId, m.salePrice]));
    const neededCash = p => Math.max(p.value, (p.bid && p.bid.conservative) || 0, marketMin.get(String(p.id)) || 0);
    let all = snap.players.filter(p => (!n || norm(p.name).includes(n) || norm(p.team).includes(n)) &&
      (!team || p.team === team) && (!owner || p.owner === owner) && (!position || p.position === position) &&
      (!afford || (!p.owner && (afford !== 'affordable' || (cash != null && neededCash(p) <= cash)))) &&
      (!price || (price === 'low' ? p.value <= 5e6 : price === 'mid' ? p.value > 5e6 && p.value <= 20e6 : p.value > 20e6)) &&
      (!form || (form === 'rising' ? p.change > 0 : form === 'falling' ? p.change < 0 : form === 'available' ? !p.owner : !!STATUS[p.status])));
    all = all.slice().sort(SORTS[sort] || SORTS.change);
    if (sort === 'bargain') all = all.filter(p => ppm(p) > 0);
    $('#filter-count').textContent = `${all.length} futbolistas${all.length > 100 ? ' · se muestran los primeros 100' : ''}` + (afford === 'affordable' && cash == null ? ' · Tu caja no está disponible' : '');
    const LIMIT = 100, list = all.slice(0, LIMIT);
    $('#results').innerHTML = list.length ? list.map(p => `
      <div class="item" data-player="${esc(p.id)}">
        ${p.image ? `<img class="face" loading="lazy" src="${esc(p.image)}" alt="">` : ''}
        <div class="main">
          <div class="name">${esc(p.name)}</div>
          <div class="sub">${p.badge ? `<img class="badge" src="${esc(p.badge)}" alt="">` : ''}${esc(p.team)} · ${esc(p.position)}</div>
          <div class="sub">${p.owner ? '<b>' + esc(p.owner) + '</b>' : 'sin dueño'} · ${p.points || 0} pts${sort === 'bargain' ? ` · <b class="pos">${ppm(p).toLocaleString('es-ES', { maximumFractionDigits: 1 })} pts/M</b>` : ''}${sort === 'pred' && predFor(p) ? ` · <b class="pred-v">${predTxt(predFor(p))}${predFor(p).week ? ' J' + predFor(p).week : ''}</b>` : ''} ${statusPill(p.status)}</div>
          ${last5(p.id)}
          ${bidLevels(p)}
        </div>
        <div class="right"><div class="p ${cls(p.change)}">${signed(p.change || 0, mill)}</div><div class="sub ${cls(p.change)}">${pct(p.changePct || 0)}</div><div class="v">${mill(p.value)}</div></div>
      </div>`).join('') : '<div class="empty">Ninguno con estos filtros</div>';
  }

  // Pantalla desde la que se abrió el detalle del jugador (y su scroll), para que "Volver" lleve ahí
  let playerFrom = null;
  async function showPlayer(id) {
    const p = snap.players.find(x => String(x.id) === String(id)) || { id, name: 'Jugador ' + id };
    const cur = document.querySelector('.tab.active');
    const view = cur ? cur.dataset.view : 'panel';
    // Si ya estaba en un detalle (jugador desde jugador), se conserva el origen de antes
    const from = view === 'search' && !$('#player').classList.contains('hidden') && playerFrom ? playerFrom : { view, y: window.scrollY };
    document.querySelector('.tab[data-view=search]').click(); // (esto borra playerFrom: se vuelve a poner justo debajo)
    playerFrom = from;
    syncBar(from.view); // la barra sigue marcando la pantalla de la que vienes
    $('#results').classList.add('hidden');
    $('#sort-wrap').classList.add('hidden');
    $('#player-filters').classList.add('hidden'); $('#filter-count').classList.add('hidden');
    const box = $('#player');
    box.classList.remove('hidden'); box.dataset.playerId = String(id);
    const tx = snap.activity.filter(a => String(a.playerId) === String(id) && a.amount);
    const ch = p.change || 0;
    box.innerHTML = `<button class="back">← Volver</button>
      <div class="today">
        <span class="muted small">Desde ayer</span>
        <div class="big ${cls(ch)}">${signed(ch, eur)}</div>
        <span class="delta ${cls(ch)}">${pct(p.changePct || 0)}</span>
        ${p.yesterday != null ? `<span class="muted small"> ayer ${eur(p.yesterday)}</span>` : ''}
      </div>
      <div class="player-head">${playerPortrait(p)}<div><h2>${esc(p.team || '')} · ${esc(p.position || '')}</h2><div class="big">${esc(p.name)}</div></div></div>
      <p class="muted">${p.value ? eur(p.value) : ''}${p.owner ? ' · de ' + esc(p.owner) : ' · sin dueño'} · ${p.points || 0} pts${p.avg ? ' (' + Number(p.avg).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' de media)' : ''}</p>
      ${ownedLock(id)}
      ${predBlock(p)}
      <div id="bid-estimate"><p class="muted small">Calculando con los valores diarios…</p></div>
      <h2 style="margin-top:12px">Últimas 5 jornadas</h2>
      ${last5(id, true)}
      ${next5(p)}
      <div id="chart"><p class="muted small">Cargando histórico…</p></div>
      <h2 style="margin-top:14px">Movimientos en la liga</h2>
      ${snap.plan && (snap.plan.locked || []).includes('playerTx') ? (() => {
        const n = tx.length + ((snap.txHidden || {})[id] || 0);
        const fake = `<table class="tx" style="min-height:210px">${Array.from({ length: Math.max(2, Math.min(n, 4)) }, (_, i) => `<tr><td>1${i}/9 · Fichaje<br><span class="muted small">Mánager → Mánager</span></td><td>12.345.678 €</td></tr>`).join('')}</table>`;
        return lockBox(n ? (n === 1 ? '1 movimiento' : n + ' movimientos') + ' de este jugador' : 'Movimientos de este jugador', 'Con Premium ves todos los fichajes, ventas y cláusulas de este jugador en tu liga: quién lo compró, a quién y por cuánto.', fake);
      })() : tx.length ? `<table class="tx">${tx.map(a => `<tr><td>${day(a.date)} · ${esc(a.type)}<br><span class="muted small">${esc(a.seller || '')} → ${esc(a.buyer || '')}</span></td><td>${eur(a.amount)}</td></tr>`).join('')}</table>` : '<div class="empty">Sin movimientos</div>'}`;
    box.querySelector('.back').onclick = () => {
      history.replaceState(null, '', location.pathname);
      const from = playerFrom || { view: 'search', y: 0 }; playerFrom = null;
      search($('#q').value); // la pestaña Futbolistas vuelve a su lista
      if (from.view !== 'search') document.querySelector('.tab[data-view=' + from.view + ']').click();
      requestAnimationFrame(() => window.scrollTo(0, from.y || 0));
    };
    window.scrollTo(0, 0);
    try {
      const h = await api('/api/player/' + encodeURIComponent(id) + '/history');
      if (!box.isConnected || box.dataset.playerId !== String(id)) return;
      historyTabs(h); $('#bid-estimate').innerHTML = bidBlock(p, h);
    } catch (e) { if (box.isConnected && box.dataset.playerId === String(id)) { $('#chart').innerHTML = `<p class="muted small">${esc(e.message)}</p>`; $('#bid-estimate').innerHTML = bidBlock(p, []); } }
  }

  /** Próximos 5 partidos del equipo del jugador: fondo verde claro en casa, rojo claro fuera. */
  function next5(p) {
    const list = snap.fixtures && snap.fixtures.next && p.teamId ? snap.fixtures.next[p.teamId] : null;
    if (!list || !list.length) return '';
    // Los partidos sin fecha cerrada vienen de madrugada (01:00-02:00): ahí no enseñamos la hora
    const when = d => { const h = Number(new Date(d).toLocaleString('es-ES', { hour: 'numeric', hour12: false, timeZone: 'Europe/Madrid' })); return day(d) + (h >= 4 ? ' · ' + hour(d) : ''); };
    return `<h2 style="margin-top:14px">Próximos partidos</h2>
      <div class="next5">${list.map(x => `<div class="nx ${x.home ? 'home' : 'away'}">
        <span class="wk">J${x.week}</span>
        ${x.oppBadge ? `<img src="${esc(x.oppBadge)}" alt="">` : ''}
        <b>${esc(x.oppShort || x.oppName)}</b>
        <span class="ha">${x.home ? 'Casa' : 'Fuera'}</span>
        <span class="dt">${when(x.date)}</span>
      </div>`).join('')}</div>${(() => {
        const n = (snap.fixtures.nextHidden && snap.fixtures.nextHidden[p.teamId]) || 0;
        if (!n) return '';
        const fake = `<div class="next5" style="min-height:200px;align-content:start">${Array.from({ length: n }, (_, i) => `<div class="nx ${i % 2 ? 'away' : 'home'}"><span class="wk">J${list[0].week + i + 1}</span><b>RIV</b><span class="ha">${i % 2 ? 'Fuera' : 'Casa'}</span><span class="dt">sáb · 21:00</span></div>`).join('')}</div>`;
        return lockBox(`${n === 1 ? 'La siguiente jornada' : 'Las ' + n + ' jornadas siguientes'}`, 'Con Premium ves contra quién juega en las próximas jornadas, si es en casa o fuera y a qué hora.', fake);
      })()}`;
  }

  function ownedLock(id) {
    for (const m of snap.managers) {
      const r = m.squad.find(x => String(x.playerId) === String(id));
      if (r) return `<p class="muted small">Cláusula ${eur(r.clause)} ${lockPill(r.clauseLockedUntil, m.isMe ? true : 'rival')}</p>`;
    }
    return '';
  }

  // ---------- protección: toda la liga ----------
  function renderLocks() {
    if (!snap) return;
    const hideMine = $('#lock-mine').checked;
    const rows = [], hidSet = soonHiddenSet();
    snap.managers.forEach(m => { if (hideMine && m.isMe) return; m.squad.forEach(p => rows.push({ p, m, hid: hidSet.has(p), left: hidSet.has(p) ? DAY_MS - 1 : lockLeft(p.clauseLockedUntil) })); });
    const locked = rows.filter(r => r.left > 0).sort((a, b) => a.left - b.left);
    const open = rows.filter(r => r.left <= 0).sort((a, b) => a.p.clause - b.p.clause);
    const item = r => r.hid ? `
      <div class="item target hidlock unlock">
        <img class="face" loading="lazy" src="${esc(r.p.image || '')}" alt="">
        <div class="main"><div class="name blurt">${esc(r.p.player)}</div><div class="sub"><b>${esc(r.m.name)}</b></div><div class="sub wrap">${premiumPill()}</div></div>
        <div class="right"><div class="sub">Cláusula</div><div class="v blurt">${mill(r.p.clause)}</div></div>
      </div>` : `
      <div class="item${!r.m.isMe && r.left > 0 && r.left < DAY_MS ? ' target' : ''}" data-player="${esc(r.p.playerId)}">
        <img class="face" loading="lazy" src="${esc(r.p.image || '')}" alt="">
        <div class="main">
          <div class="name">${esc(r.p.player)}</div>
          <div class="sub"><b>${esc(r.m.name)}</b>${r.m.isMe ? ' (tú)' : ''} · ${esc(r.p.position || '')}</div>
          <div class="sub wrap">${lockPill(r.p.clauseLockedUntil, r.m.isMe ? true : 'rival')}</div>
          ${calButtons(r.p.clauseLockedUntil, r.p.player, r.m.name, r.m.isMe)}
        </div>
        <div class="right">
          <div class="sub">Cláusula</div>
          <div class="v">${mill(r.p.clause)}</div>
          <div class="sub">valor ${mill(r.p.value)}</div>
        </div>
      </div>`;
    const soon = locked.filter(r => r.left < DAY_MS).length;
    $('#locks').innerHTML = `
      <article class="card">
        <h2>Protegidos · ${locked.length}${soon ? ` · <span class="soon-txt">${soon} acaban en menos de 24 h</span>` : ''}</h2>
        <div class="list">${locked.map(item).join('') || '<div class="empty">Ninguno</div>'}</div>
      </article>
      <article class="card">
        <h2>Sin protección · ${open.length}</h2>
        <p class="muted small" style="margin-bottom:6px">Ordenados por cláusula, de menor a mayor.</p>
        <div class="list">${open.map(item).join('') || '<div class="empty">Ninguno</div>'}</div>
      </article>`;
  }

  // ---------- movimientos (mercado) ----------
  const MOVE = {
    buy: r => r.typeId === 31,
    sell: r => r.typeId === 33,
    trade: r => r.category === 'Mercado' && r.buyer && r.seller && r.buyer !== 'LALIGA' && r.seller !== 'LALIGA',
    lock: r => r.category === 'Blindaje'
  };
  const isMove = r => MOVE.buy(r) || MOVE.sell(r) || MOVE.trade(r) || MOVE.lock(r);
  function moveRow(r) {
    let icon, text, cl = '';
    if (MOVE.buy(r)) { icon = '+'; cl = ' buy'; text = `<b>${esc(r.buyer)}</b> ficha del mercado`; }
    else if (MOVE.sell(r)) { icon = '−'; cl = ' sell'; text = `<b>${esc(r.seller)}</b> vende a LALIGA`; }
    else if (MOVE.lock(r)) { icon = 'B'; cl = ' lock'; text = `<b>${esc(r.manager)}</b> blinda`; }
    else { icon = '⇄'; text = `<b>${esc(r.buyer)}</b> compra a <b>${esc(r.seller)}</b>`; cl = ' trade'; }
    return `<div class="item move${cl}" data-player="${esc(r.playerId)}">
      <div class="ico">${icon}</div>
      <div class="main">
        <div class="name">${esc(r.player)}</div>
        <div class="sub wrap">${text}</div>
        <div class="sub">${day(r.date)} · ${hour(r.date)}</div>
      </div>
      <div class="right">${r.amount ? `<div class="v">${mill(r.amount)}</div>` : ''}</div>
    </div>`;
  }
  function renderMarketNow() {
    const box = $('#market-current'), updated = $('#market-updated');
    updated.textContent = 'Al actualizar tu liga · ' + new Date(snap.fetchedAt).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }) + ' · ' + (snap.league && snap.league.name || 'esta liga');
    if (snap.marketLocked) { box.innerHTML = lockBox('Mercado en directo', 'Con Premium ves los jugadores anunciados en esta liga con sus tres pujas estimadas.', '<div class="empty">Jugador · salida y tres pujas</div>'); return; }
    if (!Array.isArray(snap.market)) { box.innerHTML = '<div class="empty">No hemos podido leer el mercado de esta liga. Actualiza para probar de nuevo.</div>'; return; }
    box.innerHTML = snap.market.length ? snap.market.map(m => {
      const p = playerById(m.playerId);
      if (!p) return '';
      return `<div class="item market-item" data-player="${esc(p.id)}">
        ${p.image ? `<img class="face" loading="lazy" src="${esc(p.image)}" alt="">` : ''}
        <div class="main"><div class="name">${esc(p.name)}</div>
          <div class="sub">${esc(p.position)} · ${esc(p.team)} · ${p.owner ? esc(p.owner) : 'sin dueño'}</div>
          <div class="sub">Salida ${mill(m.salePrice)} · Valor ${mill(p.value)} · termina ${day(m.expires)} ${hour(m.expires)}</div>
          ${p.bid && m.salePrice > p.bid.optimistic ? '<div class="sub neg">Salida por encima de la puja optimista: no nos sale rentable</div>' : ''}
          ${bidLevels(p)}</div></div>`;
    }).join('') || '<div class="empty">No podemos mostrar los anuncios de esta liga.</div>' : '<div class="empty">No hay jugadores en el mercado ahora mismo.</div>';
  }
  function renderMoves() {
    if (!snap) return;
    renderMarketNow();
    const kind = $('#mv-kind').value, who = $('#mv-who').value;
    const whoOpts = ['<option value="">Todos los mánagers</option>'].concat(snap.managers.slice().sort((a, b) => a.name.localeCompare(b.name)).map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`)).join('');
    if ($('#mv-who').dataset.n !== String(snap.managers.length)) { $('#mv-who').innerHTML = whoOpts; $('#mv-who').value = who; $('#mv-who').dataset.n = snap.managers.length; }
    const rows = snap.activity.filter(r => isMove(r) && (!kind || MOVE[kind](r)) && (!who || [r.buyer, r.seller, r.manager].includes(who)));
    const LIMIT = 150;
    $('#moves').innerHTML = rows.length ? rows.slice(0, LIMIT).map(moveRow).join('') + (rows.length > LIMIT ? `<div class="empty">Mostrando ${LIMIT} de ${rows.length}</div>` : '') : '<div class="empty">Sin movimientos</div>';
    if (isLocked('market')) $('#moves').innerHTML = `<div class="muted small" style="padding:4px 2px 10px">Últimas 24 h</div>` + (rows.length ? rows.map(moveRow).join('') : '<div class="empty">Sin movimientos en las últimas 24 h</div>')
      + lockBox('Mercado completo', `Con Premium ves todo el historial de fichajes, ventas y blindajes${snap.activityHidden ? ' (' + nf.format(snap.activityHidden) + ' movimientos más)' : ''} y lo filtras por mánager.`,
        Array.from({ length: 3 }, () => `<div class="item move"><div class="ico">⇄</div><div class="main"><div class="name">Jugador</div><div class="sub">Mánager compra a mánager</div></div><div class="right"><div class="v">12,3 M</div></div></div>`).join(''));
  }

  // ---------- hoy (resumen) ----------
  function renderToday() {
    if (!snap) return;
    const since = new Date(snap.fetchedAt).getTime() - DAY_MS;
    const recent = snap.activity.filter(r => isMove(r) && new Date(r.date).getTime() >= since);
    const soon = [], hidSet = soonHiddenSet(), basic = isLocked('locks');
    // En básico la lista es de toda la liga (también las tuyas) y solo se ve una; en completo, solo rivales
    snap.managers.forEach(m => { if (!m.isMe || basic) m.squad.forEach(p => { if (hidSet.has(p)) return; const l = lockLeft(p.clauseLockedUntil); if (l > 0 && l < DAY_MS) soon.push({ p, m, l }); }); });
    const hid = hidSet.size;
    soon.sort((a, b) => a.l - b.l);
    const live = snap.players.filter(p => p.status !== 'out_of_league');
    const up = live.slice().sort((a, b) => b.change - a.change).slice(0, 5).filter(p => p.change > 0);
    const down = live.slice().sort((a, b) => a.change - b.change).slice(0, 5).filter(p => p.change < 0);
    const me = snap.managers.find(m => m.isMe);
    const mySquadDelta = me ? me.squad.reduce((t, p) => t + (p.value - p.yesterday), 0) : 0;
    const bajas = me ? me.squad.map(p => ({ p, c: playerById(p.playerId) })).filter(x => x.c && STATUS[x.c.status]) : [];
    const mini = p => `<div class="item" data-player="${esc(p.id)}">
        ${p.image ? `<img class="face" loading="lazy" src="${esc(p.image)}" alt="">` : ''}
        <div class="main"><div class="name">${esc(p.name)}</div><div class="sub">${p.owner ? '<b>' + esc(p.owner) + '</b>' : 'sin dueño'} · ${esc(p.team)}</div></div>
        <div class="right"><div class="p ${cls(p.change)}">${signed(p.change, mill)}</div><div class="sub ${cls(p.change)}">${pct(p.changePct || 0)}</div></div>
      </div>`;
    $('#today').innerHTML = `
      ${me ? `<article class="card"><h2>Tu plantilla desde ayer</h2><div class="big ${cls(mySquadDelta)}">${signed(mySquadDelta, eur)}</div></article>` : ''}
      <article class="card">
        <h2>Protecciones que acaban en 24 h · ${soon.length + hid}</h2>
        <div class="list">${soon.map(x => `<div class="item target" data-player="${esc(x.p.playerId)}">
          <img class="face" loading="lazy" src="${esc(x.p.image || '')}" alt="">
          <div class="main"><div class="name">${esc(x.p.player)}</div><div class="sub wrap"><b>${esc(x.m.name)}</b> ${lockPill(x.p.clauseLockedUntil)}</div>${calButtons(x.p.clauseLockedUntil, x.p.player, x.m.name, false)}</div>
          <div class="right"><div class="sub">Cláusula</div><div class="v">${x.p.clause != null ? mill(x.p.clause) : "—"}</div><div class="price-compare">Valor <b>${mill(x.p.value)}</b></div></div>
        </div>`).join('') || (hid ? '' : '<div class="empty">Ninguna</div>')}</div>
        ${hid ? lockBox(`${hid} protecci${hid === 1 ? 'ón más' : 'ones más'}`, 'Con Premium ves todas las protecciones de la liga que acaban en las próximas 24 h.', Array.from({ length: Math.min(hid, 3) }, () => `<div class="item"><div class="main"><div class="name">Jugador</div><div class="sub">Mánager · 5 h 20 min</div></div><div class="right"><div class="v">12,3 M</div></div></div>`).join('')) : ''}
      </article>
      <article class="card">
        <h2>Movimientos últimas 24 h · ${recent.length}</h2>
        <div class="list">${recent.map(moveRow).join('') || '<div class="empty">Nada nuevo</div>'}</div>
      </article>
      ${bajas.length ? `<article class="card"><h2>Bajas en tu plantilla</h2><div class="list">${bajas.map(x => `<div class="item" data-player="${esc(x.p.playerId)}"><img class="face" loading="lazy" src="${esc(x.p.image || '')}" alt=""><div class="main"><div class="name">${esc(x.p.player)}</div><div class="sub">${statusPill(x.c.status)}</div></div></div>`).join('')}</div></article>` : ''}
      <article class="card"><h2>Mayores subidas</h2><div class="list">${up.map(mini).join('') || '<div class="empty">—</div>'}</div></article>
      <article class="card"><h2>Mayores bajadas</h2><div class="list">${down.map(mini).join('') || '<div class="empty">—</div>'}</div></article>`;
  }

  // ---------- jornada (calendario) ----------
  function renderWeek() {
    if (!snap) return;
    const F = snap.fixtures;
    const wks = F && F.weeks && F.weeks.length ? F.weeks : (F ? [{ week: F.week, matches: F.matches }] : []);
    let wkSel = Number(localStorage.getItem('fantasy.week')) || 0;
    if (!wks.some(w => w.week === wkSel)) wkSel = wks.length ? wks[0].week : 0;
    const cw = wks.find(w => w.week === wkSel);
    const f = F && cw ? { week: cw.week, matches: cw.matches, opens: cw.week === F.week ? F.opens : null } : F;
    const wkLocked = isLocked('weeks') && F && F.weeksHidden;
    if (wkLocked) $('#week-pick').innerHTML = `<button type="button" class="wk-btn on">J${wks[0] ? wks[0].week : ''}<small>actual</small></button>` + Array.from({ length: F.weeksHidden }, (_, i) => `<button type="button" class="wk-btn unlock lockd"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg> J${(wks[0] ? wks[0].week : 0) + i + 1}</button>`).join('');
    else $('#week-pick').innerHTML = wks.length > 1 ? wks.map((w, i) => `<button type="button" class="wk-btn${w.week === wkSel ? ' on' : ''}" data-week="${w.week}">J${w.week}${i === 0 ? '<small>actual</small>' : ''}</button>`).join('') : '';
    if (!f || !f.matches.length) { $('#week').innerHTML = '<div class="empty">Sin calendario todavía. Pulsa ⟳ para descargarlo.</div>'; return; }
    const wm = $('#week-manager');
    wm.innerHTML = $('#manager').innerHTML; // mismas opciones y mismo estado que el selector del Panel
    wm.value = $('#manager').value;
    const m = currentManager() || snap.managers.find(x => x.isMe);
    const byTeam = {};
    (m ? m.squad : []).forEach(sp => { const c = playerById(sp.playerId); const t = c && c.teamId; if (t) (byTeam[t] = byTeam[t] || []).push({ sp, c }); });
    const badge = t => t.badge ? `<img class="badge" src="${esc(t.badge)}" alt="">` : '';
    const score = x => x.state === 7 || x.homeScore != null ? `<b>${x.homeScore ?? ''} - ${x.awayScore ?? ''}</b>` : `<span class="muted">${Number(new Date(x.date).toLocaleString('es-ES', { hour: 'numeric', hour12: false, timeZone: 'Europe/Madrid' })) >= 4 ? hour(x.date) : 'vs'}</span>`; // de madrugada = hora sin confirmar
    const homeOf = {}; f.matches.forEach(x => { homeOf[x.home.id] = true; homeOf[x.away.id] = false; });
    // % de titularidad (futbolfantasy.com): solo para la jornada que ellos publican
    const TT = snap.titularidad && snap.titularidad.probs && (snap.titularidad.week || F.week) === f.week ? snap.titularidad : null;
    const probPill = id => { const t = TT && TT.probs[id]; if (!t) return ''; const k = t.prob >= 70 ? 'hi' : t.prob >= 40 ? 'mid' : 'lo'; return `<span class="prob ${k}" title="Probabilidad de titular (futbolfantasy)">${t.prob}%</span>`; };
    const chip = ({ sp, c }) => `<span class="chip ${homeOf[c.teamId] ? 'home' : 'away'}" title="${homeOf[c.teamId] ? 'En casa' : 'Fuera'}" data-player="${esc(sp.playerId)}">${sp.image ? `<img src="${esc(sp.image)}" alt="">` : ''}${esc(sp.player)}${STATUS[c.status] ? ' ' + STATUS[c.status].split(' ')[0] : ''}${probPill(sp.playerId)}</span>`;
    const mine = [], rest = [];
    f.matches.forEach(x => { const ps = (byTeam[x.home.id] || []).concat(byTeam[x.away.id] || []); (ps.length ? mine : rest).push({ x, ps }); });
    const playing = new Set(f.matches.flatMap(x => [x.home.id, x.away.id]));
    const idle = (m ? m.squad : []).map(sp => ({ sp, c: playerById(sp.playerId) })).filter(o => o.c && !playing.has(o.c.teamId));
    const match = ({ x, ps }) => `<div class="match">
        <div class="mrow"><span class="when">${tbd(x.date) ? 'Pendiente' : wday(x.date)}</span><span class="teams">${badge(x.home)}${esc(x.home.short || x.home.name)} ${score(x)} ${esc(x.away.short || x.away.name)}${badge(x.away)}</span></div>
        ${ps.length ? `<div class="chips">${ps.map(chip).join('')}</div>` : ''}
      </div>`;
    $('#week').innerHTML = `
      <article class="card">
        <h2>Jornada ${f.week}${f.opens ? ` · desde ${wday(f.opens)}` : f.matches.length ? (f.matches.every(x => tbd(x.date)) ? ` · fin de semana del ${day(f.matches[0].date)} (sin horarios)` : ` · desde ${wday(f.matches.find(x => !tbd(x.date)).date)}`) : ''}</h2>
        <p class="muted small" style="margin-bottom:8px">${mine.reduce((t, o) => t + o.ps.length, 0)} de ${(m ? m.squad.length : 0)} jugadores tienen partido.</p>
        <p class="legend"><span class="chip home">En casa</span><span class="chip away">Fuera</span>${TT ? `<span class="prob-legend"><span class="prob hi">%</span> titular según <a href="${esc(TT.source || 'https://www.futbolfantasy.com/laliga/posibles-alineaciones')}" target="_blank" rel="noopener">futbolfantasy</a> · ${esc(new Date(TT.fetchedAt).toLocaleString('es-ES', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }))}${TT.error ? ' (no se pudo actualizar)' : ''}</span>` : ''}</p>
        ${mine.map(match).join('') || '<div class="empty">Ningún jugador juega esta jornada</div>'}
        ${idle.length ? `<p class="muted small" style="margin-top:8px">Sin partido: ${idle.map(o => esc(o.sp.player)).join(', ')}</p>` : ''}
      </article>
      <article class="card"><h2>Resto de partidos</h2>${rest.map(match).join('') || '<div class="empty">—</div>'}</article>`;
  }

  function chart(h) {
    if (!h.length) return '<p class="muted small">Sin histórico</p>';
    const W = 600, H = 180, P = 6;
    const vs = h.map(x => x.value), min = Math.min(...vs), max = Math.max(...vs);
    const x = i => P + (i / Math.max(1, h.length - 1)) * (W - 2 * P);
    const y = v => H - P - ((v - min) / ((max - min) || 1)) * (H - 2 * P);
    const pts = h.map((d, i) => `${x(i).toFixed(1)},${y(d.value).toFixed(1)}`);
    const up = vs[vs.length - 1] >= vs[0], color = up ? 'var(--green)' : 'var(--red)';
    const first = h[0], last = h[h.length - 1];
    const d7 = h.length > 7 ? last.value - h[h.length - 8].value : null;
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <path class="area" fill="${color}" d="M${pts[0]} L${pts.join(' L')} L${x(h.length - 1)},${H - P} L${x(0)},${H - P} Z"/>
        <path class="line" stroke="${color}" d="M${pts.join(' L')}"/>
      </svg>
      <div class="axis"><span>${day(first.date)}</span><span>${day(last.date)}</span></div>
      <div class="rows">
        <div class="row"><span>Desde ${day(first.date)}</span><b class="${cls(last.value - first.value)}">${signed(last.value - first.value, mill)}</b></div>
        ${d7 != null ? `<div class="row"><span>Últimos 7 días</span><b class="${cls(d7)}">${signed(d7, mill)}</b></div>` : ''}
        <div class="row"><span>Máximo / mínimo</span><b>${mill(max)} / ${mill(min)}</b></div>
      </div>`;
  }

  // ---------- predicción de puntos (plan básico) ----------
  let predMemo = null;
  function predFor(p) {
    if (!snap || !p) return null;
    if (!predMemo || predMemo.snap !== snap) predMemo = { snap, teams: C.teamForms(snap.players), map: {} };
    const k = String(p.id);
    if (k in predMemo.map) return predMemo.map[k];
    const list = snap.fixtures && snap.fixtures.next && p.teamId ? snap.fixtures.next[p.teamId] : null;
    const next = list && list.length ? list[0] : null;
    const TT = snap.titularidad && snap.titularidad.probs && next && snap.titularidad.week === next.week ? snap.titularidad.probs : null;
    const prob = TT && TT[k] ? TT[k].prob : null;
    return (predMemo.map[k] = C.predict(p, { teams: predMemo.teams, next, prob }));
  }
  const predTxt = r => r ? `≈ ${r.points} pt${r.points === 1 ? '' : 's'}` : '—';
  function predBlock(p) {
    const r = predFor(p);
    if (!r) return '';
    return `<div class="pred-card">
      <div><span class="muted small">Predicción${r.week ? ' J' + r.week : ''}${r.oppShort ? ' · ' + (r.home ? 'vs ' : 'en ') + esc(r.oppShort) : ''}</span>
      <div class="big">${predTxt(r)}</div></div>
      <div class="pred-why">${r.why.map(w => `<span class="pill">${esc(w)}</span>`).join('')}</div>
      <p class="muted small">Estimación orientativa: racha de las últimas 5 jornadas, media de la temporada, fuerza del rival, casa/fuera y estado del jugador.</p>
    </div>`;
  }

  // ---------- resumen semanal (plan básico) ----------
  const ord = n => n + 'º';
  function summaryText() {
    const W = snap.weekly; if (!W) return '';
    const me = W.managers.find(m => m.isMe);
    const lastIdx = (snap.weeks || []).length - 1;
    const mine = me ? (snap.managers.find(m => m.isMe) || { squad: [] }).squad.map(s => ({ s, c: playerById(s.playerId) })).filter(x => x.c && x.c.last5 && x.c.last5[lastIdx] != null) : [];
    const best = mine.sort((a, b) => b.c.last5[lastIdx] - a.c.last5[lastIdx])[0];
    const riser = W.managers.slice().sort((a, b) => b.change - a.change)[0];
    const L = [`⚽ BigData Fantasy · Mi semana${W.week ? ' (J' + W.week + ')' : ''} en ${snap.league.name}`];
    if (me) L.push(`🏆 ${ord(me.position)} de ${W.managers.length} · ${me.points} pts`, `📈 Plantilla: ${mill(me.squadValue)} (${signed(me.change, mill)} en 7 días)`);
    if (best) L.push(`🔝 Mi mejor de la J${snap.weeks[lastIdx]}: ${best.c.name} ${best.c.last5[lastIdx]} pts`);
    if (W.topSigning) L.push(`💸 Fichaje de la semana: ${W.topSigning.player} por ${mill(W.topSigning.amount)} (${W.topSigning.buyer})`);
    if (riser && riser.change > 0) L.push(`🔥 Mayor subida de la liga: ${riser.name} ${signed(riser.change, mill)}`);
    L.push('', location.origin);
    return L.join('\n');
  }
  async function shareSummary() {
    const text = summaryText();
    if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
  }
  function renderSummary() {
    if (!snap) return;
    const W = snap.weekly;
    if (!W) { $('#summary').innerHTML = '<article class="card"><div class="empty">El resumen aparecerá con la próxima actualización de datos (toca ⟳).</div></article>'; return; }
    const me = W.managers.find(m => m.isMe);
    const meFull = snap.managers.find(m => m.isMe);
    const lastIdx = (snap.weeks || []).length - 1, lastWk = snap.weeks ? snap.weeks[lastIdx] : null;
    const mine = meFull ? meFull.squad.map(s => ({ s, c: playerById(s.playerId) })).filter(x => x.c) : [];
    const played = mine.filter(x => x.c.last5 && x.c.last5[lastIdx] != null).sort((a, b) => b.c.last5[lastIdx] - a.c.last5[lastIdx]);
    const ranking = W.managers.slice().sort((a, b) => b.change - a.change);
    const preds = mine.map(x => ({ ...x, r: predFor(x.c) })).filter(x => x.r).sort((a, b) => b.r.raw - a.r.raw);
    const nextWk = preds.find(x => x.r.week) ? preds.find(x => x.r.week).r.week : null;
    const face = img => `<img class="face" loading="lazy" src="${esc(img || '')}" alt="">`;
    const sq = v => `<span class="ptsq ${ptsClass(v)}">${v}</span>`;
    const moveTxt = m => m.kind === 'buy' ? `Fichas${m.counterpart && m.counterpart !== 'LALIGA' ? ' a ' + esc(m.counterpart) : ' del mercado'}` : `Vendes${m.counterpart && m.counterpart !== 'LALIGA' ? ' a ' + esc(m.counterpart) : ' a LALIGA'}`;
    $('#summary').innerHTML = `
      <article class="card hero">
        <span class="muted small">Del ${day(W.from + 'T12:00:00')} al ${day(W.to + 'T12:00:00')}${W.week ? ' · J' + W.week + ' jugada' : ''}</span>
        ${me ? `<div class="hero-row"><div><div class="big">${ord(me.position)}<small> de ${W.managers.length}</small></div><span class="muted small">${me.points} pts en total</span></div>
          <div class="right"><div class="p ${cls(me.change)}">${signed(me.change, mill)}</div><span class="muted small">plantilla en 7 días</span></div></div>` : ''}
        <button type="button" id="sum-share" class="share-btn"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 12v8h14v-8"/></svg> Compartir por WhatsApp</button>
      </article>
      ${played.length ? `<article class="card"><h2>Tus mejores de la J${lastWk}</h2><div class="list">${played.slice(0, 3).map(x => `<div class="item" data-player="${esc(x.c.id)}">${face(x.c.image)}<div class="main"><div class="name">${esc(x.c.name)}</div><div class="sub">${esc(x.c.team)} · ${esc(x.c.position)}</div></div><div class="right">${sq(x.c.last5[lastIdx])}</div></div>`).join('')}
        ${played.length > 3 ? `<div class="item" data-player="${esc(played[played.length - 1].c.id)}">${face(played[played.length - 1].c.image)}<div class="main"><div class="name">${esc(played[played.length - 1].c.name)}</div><div class="sub">El que menos</div></div><div class="right">${sq(played[played.length - 1].c.last5[lastIdx])}</div></div>` : ''}</div></article>` : ''}
      <article class="card"><h2>Tus movimientos · ${W.myMoves.length}</h2><div class="list">${W.myMoves.map(m => `<div class="item move ${m.kind}" data-player="${esc(m.playerId)}"><div class="ico">${m.kind === 'buy' ? '+' : '−'}</div><div class="main"><div class="name">${esc(m.player)}</div><div class="sub">${moveTxt(m)} · ${day(m.date)}</div></div><div class="right">${m.amount ? `<div class="v">${mill(m.amount)}</div>` : ''}</div></div>`).join('') || '<div class="empty">Esta semana no has tocado el mercado</div>'}</div></article>
      ${W.topSigning ? `<article class="card"><h2>Fichaje de la semana</h2><div class="item" data-player="${esc(W.topSigning.playerId)}">${face((playerById(W.topSigning.playerId) || {}).image)}<div class="main"><div class="name">${esc(W.topSigning.player)}</div><div class="sub"><b>${esc(W.topSigning.buyer)}</b> ${W.topSigning.seller && W.topSigning.seller !== 'LALIGA' ? 'se lo compra a <b>' + esc(W.topSigning.seller) + '</b>' : 'lo ficha del mercado'}</div></div><div class="right"><div class="v">${mill(W.topSigning.amount)}</div></div></div></article>` : ''}
      <article class="card"><h2>La liga en 7 días</h2><div class="list">${ranking.map((m, i) => `<div class="rank${m.isMe ? ' me' : ''}"><span class="rk">${i + 1}</span><div class="main"><div class="name">${esc(m.name)}${m.isMe ? ' <span class="pill">tú</span>' : ''}</div><div class="sub">${m.moves} movimiento${m.moves === 1 ? '' : 's'} · ${ord(m.position)} en la liga</div></div><div class="right"><div class="p ${cls(m.change)}">${signed(m.change, mill)}</div><div class="sub">${mill(m.squadValue)}</div></div></div>`).join('')}</div>
        <p class="muted small" style="margin-top:8px">Cambio de valor de la plantilla actual de cada mánager en los últimos 7 días.</p></article>
      ${preds.length ? `<article class="card"><h2>Predicción de tu plantilla${nextWk ? ' · J' + nextWk : ''}</h2><div class="list">${preds.map(x => `<div class="item" data-player="${esc(x.c.id)}">${face(x.c.image)}<div class="main"><div class="name">${esc(x.c.name)}</div><div class="sub">${x.r.oppShort ? (x.r.home ? 'vs ' : 'en ') + esc(x.r.oppShort) + ' · ' : ''}${esc(x.r.why.filter(w => !/^racha|casa|fuera/.test(w)).join(' · ') || x.c.position)}</div></div><div class="right"><div class="v pred-v">${predTxt(x.r)}</div></div></div>`).join('')}</div>
        <p class="muted small" style="margin-top:8px">Orientativa: racha, media, rival y casa/fuera.</p></article>` : ''}`;
    $('#sum-share').onclick = shareSummary;
  }

  // ---------- vigilar rivales (Premium) ----------
  const WLS = { list: 'fantasy.watch', seen: 'fantasy.watchSeen', notified: 'fantasy.watchNotified' };
  const jget = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } };
  const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignorar */ } };
  const watched = () => jget(WLS.list, []).filter(n => snap && snap.managers.some(m => m.name === n && !m.isMe));
  const involves = (r, n) => [r.buyer, r.seller, r.manager].includes(n);
  const latestOf = n => { const r = snap.activity.find(a => isMove(a) && involves(a, n)); return r ? r.date : snap.fetchedAt; };
  function toggleWatch(name) {
    if (isLocked('watch')) return;
    let l = jget(WLS.list, []);
    const seen = jget(WLS.seen, {});
    if (l.includes(name)) { l = l.filter(x => x !== name); delete seen[name]; toast('Ya no vigilas a ' + name); }
    else { l.push(name); seen[name] = latestOf(name); toast('Vigilando a ' + name + '. Te avisaré de sus movimientos.'); }
    jset(WLS.list, l); jset(WLS.seen, seen);
    syncWatch(l);
    renderWatchCta(); checkWatch();
    if (!$('#view-watch').classList.contains('hidden')) renderWatch();
  }
  // La lista de vigilados también se guarda en el servidor: así llegan las push con la app cerrada
  function syncWatch(l) { api('/api/watch', { method: 'POST', body: JSON.stringify({ names: l }) }).then(() => { if (snap && snap.me) snap.me.watch = l; }).catch(() => {}); }
  function adoptServerWatch() {
    if (!snap || !snap.me) return;
    const local = jget(WLS.list, []);
    if (!Array.isArray(snap.me.watch)) { if (local.length) syncWatch(local); return; }
    if (JSON.stringify(snap.me.watch) === JSON.stringify(local)) return;
    const seen = jget(WLS.seen, {});
    snap.me.watch.forEach(n => { if (!seen[n]) seen[n] = latestOf(n); });
    Object.keys(seen).forEach(n => { if (!snap.me.watch.includes(n)) delete seen[n]; });
    jset(WLS.list, snap.me.watch.slice()); jset(WLS.seen, seen);
    renderWatchCta(); checkWatch();
  }
  const PUSH_LS = 'fantasy.pushEndpoint';
  const pushCapable = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const b64u = s => { const b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
  const sameKey = (buf, key) => { if (!buf) return false; const a = new Uint8Array(buf), b = b64u(key); return a.length === b.length && a.every((x, i) => x === b[i]); };
  /** Suscribe este móvil a las push (si tiene permiso y plan Premium). welcome: manda un aviso de prueba. */
  async function ensurePush(welcome) {
    if (!pushCapable() || Notification.permission !== 'granted' || !snap || isLocked('watch')) return false;
    try {
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api('/api/push/key');
      const last = jget(PUSH_LS, {});
      let sub = await reg.pushManager.getSubscription();
      const key = sub && sub.options && sub.options.applicationServerKey;
      if (sub && (key ? !sameKey(key, publicKey) : (last.k && last.k !== publicKey))) { await sub.unsubscribe().catch(() => {}); sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(publicKey) });
      // Se vuelve a enviar si es nueva, si el servidor no tiene ninguna o una vez por semana
      if (welcome || last.e !== sub.endpoint || !(snap.me && snap.me.push) || Date.now() - (last.t || 0) > 7 * 864e5) {
        const r = await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON(), watch: jget(WLS.list, []), welcome: !!welcome }) });
        jset(PUSH_LS, { e: sub.endpoint, k: publicKey, t: Date.now() });
        if (snap.me) snap.me.push = r.devices;
      }
      return true;
    } catch (e) { console.warn('push', e); return false; }
  }
  const pushOn = () => pushCapable() && Notification.permission === 'granted' && !!jget(PUSH_LS, {}).e;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function watchLine(r, n) {
    const p = esc(r.player), a = r.amount ? ' por ' + mill(r.amount) : '';
    if (MOVE.lock(r)) return `${esc(n)} blinda a ${p}`;
    if (MOVE.buy(r)) return `${esc(n)} ficha a ${p} del mercado${a}`;
    if (MOVE.sell(r)) return `${esc(n)} vende a ${p} a LALIGA${a}`;
    return r.buyer === n ? `${esc(n)} le compra ${p} a ${esc(r.seller)}${a}` : `${esc(n)} le vende ${p} a ${esc(r.buyer)}${a}`;
  }
  function newWatchMoves() {
    if (!snap || isLocked('watch')) return [];
    const seen = jget(WLS.seen, {}), out = [];
    watched().forEach(n => snap.activity.forEach(r => { if (isMove(r) && involves(r, n) && (!seen[n] || r.date > seen[n])) out.push({ r, n }); }));
    return out.sort((a, b) => (a.r.date < b.r.date ? 1 : -1));
  }
  function markWatchSeen() {
    const seen = jget(WLS.seen, {});
    watched().forEach(n => { seen[n] = latestOf(n); });
    jset(WLS.seen, seen);
  }
  function checkWatch() {
    const news = newWatchMoves();
    const b = $('#watch-alert');
    $('#menu-btn').classList.toggle('has-dot', news.length > 0);
    $('#more-btn').classList.toggle('has-dot', news.length > 0);
    $('#watch-badge').classList.toggle('hidden', !news.length);
    $('#watch-badge').textContent = news.length || '';
    if (!news.length) { b.classList.add('hidden'); return; }
    const f = news[0];
    b.innerHTML = `<span class="wa-eye">👀</span><span class="wa-txt"><b>${watchLine(f.r, f.n)}</b>${news.length > 1 ? `<span class="muted small"> y ${news.length - 1} movimiento${news.length > 2 ? 's' : ''} más de tus vigilados</span>` : ''}</span><span class="wa-go">Ver</span>`;
    b.classList.remove('hidden');
    // Notificación del sistema (si la ha activado): una por movimiento, como mucho 3 por carga
    if ('Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker && !pushOn()) {
      const done = jget(WLS.notified, []);
      const fresh = news.filter(x => !done.includes(x.r.id)).slice(0, 3);
      if (fresh.length) navigator.serviceWorker.ready.then(reg => fresh.forEach(x => reg.showNotification('👀 ' + x.n, { body: watchLine(x.r, x.n).replace(/&amp;/g, '&'), tag: 'watch-' + x.r.id, icon: '/icon-192.png' }))).catch(() => {});
      jset(WLS.notified, done.concat(fresh.map(x => x.r.id)).slice(-300));
    }
  }
  function renderWatchCta() {
    const box = $('#watch-cta'); if (!box || !snap) return;
    const m = currentManager();
    if (!m || m.isMe) { box.innerHTML = ''; return; }
    const on = watched().includes(m.name);
    box.innerHTML = isLocked('watch')
      ? `<button type="button" class="watch-btn unlock"><span>👀 Vigilar a ${esc(m.name)}</span><span class="pill prem">Premium</span></button>`
      : `<button type="button" class="watch-btn${on ? ' on' : ''}" data-watch="${esc(m.name)}"><span>${on ? '✓ Vigilando a ' : '👀 Vigilar a '}${esc(m.name)}</span><span class="muted small">${on ? 'Tocar para dejar de vigilar' : 'Aviso de sus fichajes'}</span></button>`;
  }
  function renderWatch() {
    if (!snap) return;
    const rivals = snap.managers.filter(m => !m.isMe).sort((a, b) => a.name.localeCompare(b.name));
    if (isLocked('watch')) {
      const fake = `<div class="wcard"><div class="wtop"><b>Mánager</b><span class="muted small">3º · 98 pts</span></div><div class="wstats"><div><span class="muted small">Liquidez</span><b>152,3 M</b></div><div><span class="muted small">7 días</span><b>4 mov.</b></div></div></div>`
        + Array.from({ length: 3 }, (_, i) => `<div class="item move ${['buy', 'trade', 'sell'][i]}"><div class="ico">${['+', '⇄', '−'][i]}</div><div class="main"><div class="name">Jugador</div><div class="sub">Mánager ficha del mercado · hace 2 h</div></div><div class="right"><div class="v">2${i},5 M</div></div></div>`).join('');
      $('#watch').innerHTML = `<article class="card">
        <h2>Vigila a tus rivales</h2>
        <p class="muted" style="margin-bottom:12px">Elige a quién seguir y entérate de cada fichaje, venta y blindaje suyo: aviso nada más abrir la app y, si quieres, notificación en el móvil.</p>
        <div class="wchips">${rivals.map(m => `<button type="button" class="wchip unlock">${esc(m.name)}</button>`).join('')}</div>
        ${lockBox('Vigilar rivales es Premium', 'Sigue a los mánagers que te interesan, con su liquidez estimada, sus movimientos de la semana y un aviso en cuanto fichen o vendan.', fake)}
      </article>`;
      return;
    }
    const W = watched();
    const news = new Set(newWatchMoves().map(x => x.r.id));
    const perm = 'Notification' in window ? Notification.permission : 'none';
    const showNotifyBtn = !pushOn() && perm !== 'granted';
    const since = new Date(snap.fetchedAt).getTime() - 7 * DAY_MS;
    $('#watch').innerHTML = `<article class="card">
        <h2>A quién vigilas</h2>
        <div class="wchips">${rivals.map(m => `<button type="button" class="wchip${W.includes(m.name) ? ' on' : ''}" data-watch="${esc(m.name)}">${W.includes(m.name) ? '✓ ' : ''}${esc(m.name)}</button>`).join('')}</div>
        ${showNotifyBtn ? '<button type="button" id="watch-notify" class="share-btn ghost">🔔 Activar notificaciones en este móvil</button><div id="notify-guide" class="notify-guide hidden"></div>' : ''}
        <p class="muted small" style="margin-top:10px">${pushOn() ? '🔔 Notificaciones activadas en este móvil: te llegan aunque tengas la app cerrada. ' : 'Te avisamos al abrir la app si alguno de tus vigilados se ha movido. '}Los datos se actualizan cada noche y cada vez que tú o alguien de tu liga abre la app.</p>
      </article>
      ${W.length ? W.map(n => {
        const m = snap.managers.find(x => x.name === n);
        const liq = C.liquidity(m, snap.rules, { clauses: (clauses()[m.name] || 0) });
        const moves = snap.activity.filter(r => isMove(r) && involves(r, n));
        const wk = moves.filter(r => new Date(r.date).getTime() >= since).length;
        return `<article class="card"><div class="wtop"><b>${esc(n)}</b><span class="muted small">${ord(m.position)} · ${m.points} pts</span></div>
          <div class="wstats"><div><span class="muted small">Liquidez${liq.real ? '' : ' (est.)'}</span><b>${mill(liq.total)}</b></div><div><span class="muted small">Plantilla</span><b>${mill(m.squadValue)}</b></div><div><span class="muted small">7 días</span><b>${wk} mov.</b></div></div>
          <div class="list">${moves.slice(0, 6).map(r => moveRow(r).replace('<div class="item move', `<div class="item move${news.has(r.id) ? ' is-new' : ''}`)).join('') || '<div class="empty">Sin movimientos</div>'}</div></article>`;
      }).join('') : '<article class="card"><div class="empty">Toca un nombre para empezar a vigilarlo.</div></article>'}`;
    const nb = $('#watch-notify');
    if (nb) nb.onclick = async () => {
      const g = $('#notify-guide');
      const guide = (title, steps) => { g.innerHTML = `<b>${title}</b><ol>${steps.map(x => `<li>${x}</li>`).join('')}</ol>`; g.classList.remove('hidden'); };
      if (isIOS && !standalone) return guide('En iPhone, primero instala la app (30 segundos):', [
        'Toca el botón <b>Compartir</b> de Safari (el cuadrado con la flecha hacia arriba, abajo en la pantalla).',
        'Baja y elige <b>Añadir a pantalla de inicio</b> → <b>Añadir</b>.',
        'Cierra Safari y abre <b>BigData Fantasy</b> desde el icono nuevo de tu pantalla de inicio.',
        'Vuelve a <b>Vigilar rivales</b> y toca otra vez <b>Activar notificaciones</b>. El iPhone te pedirá permiso: toca <b>Permitir</b>.'
      ]);
      if (perm === 'denied') return guide('Las notificaciones están bloqueadas para esta app. Para activarlas:', isIOS
        ? ['Abre <b>Ajustes</b> del iPhone → <b>Notificaciones</b>.', 'Busca <b>BigData Fantasy</b> y activa <b>Permitir notificaciones</b>.', 'Vuelve aquí y toca otra vez el botón.']
        : ['Toca el candado junto a la dirección de la web → <b>Notificaciones</b> → <b>Permitir</b>.', 'Vuelve aquí y toca otra vez el botón.']);
      if (!pushCapable()) return guide('Este navegador no admite notificaciones push.', isIOS ? ['Necesitas iOS 16.4 o posterior: Ajustes → General → Actualización de software.'] : ['Prueba con Chrome, Edge, Firefox o Safari actualizados.']);
      try {
        const r = await Notification.requestPermission();
        if (r !== 'granted') toast('El navegador no las ha permitido', 5000);
        else toast((await ensurePush(true)) ? 'Notificaciones activadas: te llegará un aviso de prueba' : 'Permiso dado, pero este navegador no admite notificaciones push', 6000);
      } catch (e) { toast('Este navegador no permite notificaciones. En iPhone, añade la web a la pantalla de inicio.', 6000); }
      renderWatch();
    };
    markWatchSeen(); checkWatch();
  }
  document.addEventListener('click', e => { const w = e.target.closest('[data-watch]'); if (w) toggleWatch(w.dataset.watch); });
  $('#watch-alert').onclick = () => document.querySelector('.tab[data-view=watch]').click();

  // ---------- Habla con la IA ----------
  const aiState = { msgs: [], left: null, limit: null, busy: false, ready: false };
  function aiBubble(role, text) {
    const d = document.createElement('div');
    d.className = 'ai-msg ' + role;
    d.textContent = text;
    $('#ai-chat').appendChild(d);
    $('#ai-chat').scrollTop = $('#ai-chat').scrollHeight;
    return d;
  }
  function aiQuota() {
    const el = $('#ai-quota');
    if (aiState.left == null) { el.textContent = ''; return; }
    el.textContent = aiState.left > 0 ? 'Te quedan ' + aiState.left + ' preguntas hoy' : 'Sin preguntas hasta mañana';
  }
  async function renderAI() {
    if (aiState.ready) return;
    aiState.ready = true;
    try {
      const q = await api('/api/ai/quota');
      aiState.left = q.left; aiState.limit = q.limit; aiQuota();
      if (!q.on) aiBubble('bot', 'La IA aún está calentando en el banquillo: falta activarla. Avisa al administrador.');
      else if (q.left <= 0) aiBubble('bot', 'Hoy ya no quedan preguntas 😅 Mañana más. El Panel y el Mercado siguen ahí para lo urgente.');
      else aiBubble('bot', 'Aquí estoy. Pregúntame lo que quieras de tu liga: tu equipo, el mercado, una puja, un rival… Respondo con los datos que ya tiene la app (los de tu última recarga).');
    } catch (e) {
      aiState.ready = false;
      if (!e.login) aiBubble('bot', e.message);
    }
  }
  async function askAI(ev) {
    ev.preventDefault();
    const inp = $('#ai-input');
    const q = inp.value.trim();
    if (!q || aiState.busy) return;
    aiState.busy = true;
    inp.value = '';
    $('#ai-send').disabled = true;
    aiBubble('me', q);
    const typing = aiBubble('bot', '…');
    typing.classList.add('typing');
    try {
      const r = await api('/api/ai/ask', { method: 'POST', body: JSON.stringify({ question: q }) });
      typing.remove();
      aiBubble('bot', r.answer);
      aiState.left = r.left; aiQuota();
    } catch (e) {
      typing.remove();
      if (!e.login) aiBubble('bot', e.message);
      if (e.message && /mañana/i.test(e.message)) { aiState.left = 0; aiQuota(); }
    } finally {
      aiState.busy = false;
      $('#ai-send').disabled = false;
      inp.focus();
    }
  }
  $('#ai-form').addEventListener('submit', askAI);

  // ---------- eventos ----------
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    playerFrom = null; // cambiar de pestaña a mano olvida el origen del detalle de jugador
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    syncBar(t.dataset.view);
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + t.dataset.view));
    if (t.dataset.view === 'search' && !$('#results').innerHTML) search('');
    if (t.dataset.view === 'locks') renderLocks();
    if (t.dataset.view === 'moves') renderMoves();
    if (t.dataset.view === 'compare') compareRender();
    if (t.dataset.view === 'today') renderToday();
    if (t.dataset.view === 'week') renderWeek();
    if (t.dataset.view === 'summary') renderSummary();
    if (t.dataset.view === 'watch') renderWatch();
    if (t.dataset.view === 'ai') renderAI();
    $('#view-title').textContent = t.dataset.title || t.textContent.trim();
    window.scrollTo(0, 0);
    closeMenu();
  });
  // ---------- menú lateral (botón del balón) ----------
  function openMenu() { document.body.classList.add('menu-open'); $('#menu-btn').setAttribute('aria-expanded', 'true'); $('#more-btn').setAttribute('aria-expanded', 'true'); $('#drawer').setAttribute('aria-hidden', 'false'); }
  function closeMenu() { document.body.classList.remove('menu-open'); $('#menu-btn').setAttribute('aria-expanded', 'false'); $('#more-btn').setAttribute('aria-expanded', 'false'); $('#drawer').setAttribute('aria-hidden', 'true'); }
  $('#menu-btn').onclick = () => document.body.classList.contains('menu-open') ? closeMenu() : openMenu();
  $('#drawer-bg').onclick = closeMenu;
  // ---------- barra inferior ----------
  function syncBar(view) {
    const bs = [...document.querySelectorAll('#tabbar [data-go]')];
    const hit = bs.some(b => b.dataset.go === view);
    bs.forEach(b => b.classList.toggle('on', b.dataset.go === view));
    $('#more-btn').classList.toggle('on', !hit);
  }
  document.querySelectorAll('#tabbar [data-go]').forEach(b => b.onclick = () => document.querySelector('.tab[data-view=' + b.dataset.go + ']').click());
  $('#more-btn').onclick = () => document.body.classList.contains('menu-open') ? closeMenu() : openMenu();
  $('#game').addEventListener('click', () => setTimeout(closeMenu, 300));
  $('#account').addEventListener('click', closeMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
  // Deslizar hacia la izquierda sobre el menú lo cierra, como en una app
  let dx0 = null;
  $('#drawer').addEventListener('touchstart', e => { dx0 = e.touches[0].clientX; }, { passive: true });
  $('#drawer').addEventListener('touchend', e => { if (dx0 != null && dx0 - e.changedTouches[0].clientX > 60) closeMenu(); dx0 = null; }, { passive: true });
  $('#mv-kind').onchange = renderMoves;
  $('#al-ics').onclick = alertIcs;
  $('#al-min').onchange = syncGoogle;
  $('#al-text').oninput = syncGoogle;
  $('#al-google').onclick = () => { localStorage.setItem('fantasy.alertMin', $('#al-min').value); setTimeout(closeAlert, 300); };
  // Al volver de otra app (iOS puede congelar o recargar la página), repinta desde la copia guardada
  window.addEventListener('pageshow', e => { if (e.persisted && snap) render(); });
  $('#al-cancel').onclick = closeAlert;
  $('#alert').onclick = e => { if (e.target.id === 'alert') closeAlert(); };
  $('#mv-who').onchange = renderMoves;
  $('#week-pick').onclick = e => { const b = e.target.closest('[data-week]'); if (!b) return; localStorage.setItem('fantasy.week', b.dataset.week); renderWeek(); };
  $('#week-manager').onchange = e => { $('#manager').value = e.target.value; $('#manager').dispatchEvent(new Event('change')); renderWeek(); };
  $('#manager').onchange = e => { localStorage.setItem(LS.manager, e.target.value); renderClauses(); renderManager(); };
  $('#refresh').onclick = () => doRefresh();
  $('#lock-mine').onchange = renderLocks;
  setInterval(() => { if (!$('#view-locks').classList.contains('hidden')) renderLocks(); }, 60000);
  // Aviso ligero al servidor para "activo hace X" del admin: al volver a la app y cada 5 min con la app delante
  let lastPing = Date.now();
  const ping = () => { if (!snap || document.hidden || Date.now() - lastPing < 5 * 60e3) return; lastPing = Date.now(); fetch('/api/me', { credentials: 'same-origin' }).catch(() => {}); };
  document.addEventListener('visibilitychange', ping);
  // Al volver a la app, mostrar los datos guardados sin consumir una recarga en segundo plano.
  setInterval(ping, 60e3);
  $('#q').oninput = e => search(e.target.value);
  document.querySelectorAll('#player-filters select').forEach(f => f.onchange = () => search($('#q').value));
  $('#sort').onchange = e => { localStorage.setItem('fantasy.sort', e.target.value); search($('#q').value); };
  $('#sort').value = localStorage.getItem('fantasy.sort') || 'change';
  const closeClauseHelp = () => { $('#clause-help').classList.add('hidden'); $('#clause-info').focus(); };
  $('#clause-info').onclick = () => { $('#clause-help').classList.remove('hidden'); $('#clause-help-close').focus(); };
  $('#clause-help-close').onclick = closeClauseHelp;
  $('#clause-help').onclick = e => { if (e.target.id === 'clause-help') closeClauseHelp(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#clause-help').classList.contains('hidden')) closeClauseHelp(); });
  $('#clause').oninput = e => {
    const m = currentManager(); if (m.realCash != null) return;
    const c = clauses(); const v = Number(e.target.value.replace(/\D/g, '')) || 0;
    if (v) c[m.name] = v; else delete c[m.name];
    localStorage.setItem(LS.clauses, JSON.stringify(c));
    renderManager();
  };
  $('#clause').addEventListener('change', e => { const v = Number(e.target.value.replace(/\D/g, '')); e.target.value = v ? nf.format(v) : ''; });
  document.addEventListener('click', e => { const ab = e.target.closest('[data-alert]'); if (ab) { openAlert(JSON.parse(ab.dataset.alert)); return; } if (e.target.closest('a, #alert')) return; const it = e.target.closest('[data-player]'); if (it) { history.replaceState(null, '', '#p=' + it.dataset.player); showPlayer(it.dataset.player); } });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  loadData();
})();


