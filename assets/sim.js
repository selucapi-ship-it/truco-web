/* Simulaciones interactivas: una conversación/llamada que se va escribiendo y una pantalla
   de ordenador donde se guardan cosas solas. Se configuran con window.SIM_TALK y window.SIM_SCREEN. */
(function () {
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var SV = function (d) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>'; };
  var ICON = {
    phone: SV('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>'),
    chat: SV('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
    mail: SV('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/>'),
    cal: SV('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
    doc: SV('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/>'),
    shield: SV('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>'),
    web: SV('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
    user: SV('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    bolt: SV('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
    warn: SV('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>')
  };
  var $ = function (r, s) { return r.querySelector(s); };

  /* ─────────────── 1. Conversación / llamada ─────────────── */
  function talk(cfg, mount) {
    var kind = cfg.icon === 'phone' ? 'call' : 'chat';
    var wave = cfg.wave !== false && cfg.icon === 'phone';
    var waveHtml = '';
    if (wave) for (var i = 0; i < 32; i++) waveHtml += '<i></i>';
    var card = cfg.card || {};
    var cardKind = card.kind === 'panel' ? 'rs-panel' : 'rs-ticket';
    mount.innerHTML =
      '<div class="rs-call rs-kind-' + kind + '" role="img" aria-label="' + esc(cfg.aria || 'Simulación de ejemplo') + '">' +
      '<div class="rs-c-top"><div class="rs-ring">' + (ICON[cfg.icon] || ICON.chat) + '</div>' +
      '<div class="rs-c-who"><b>' + esc(cfg.title) + '</b><span data-s>' + esc(cfg.s0) + '</span></div>' +
      (cfg.timer === false ? '' : '<div class="rs-timer" data-t>00:00</div>') + '</div>' +
      (wave ? '<div class="rs-wave" aria-hidden="true">' + waveHtml + '</div>' : '') +
      '<div class="rs-talk" data-talk></div>' +
      (card.head ? '<div class="' + cardKind + '"><div class="rs-tk-h"><span>' + esc(card.head[0]) + '</span><span data-tk>' + esc(card.head[1] || '') + '</span></div>' +
        '<ul class="rs-tk-items" data-items></ul><div class="rs-tk-foot"><span class="rs-tk-meta" data-meta>' + esc(card.meta || '') + '</span><span class="rs-stamp" data-stamp>' + esc(card.stamp || '✓ Hecho') + '</span></div></div>' : '') +
      '<button type="button" class="rs-replay" data-replay hidden>↻ Ver la demostración otra vez</button>' +
      '<div class="rs-note">' + esc(cfg.note || 'Simulación de ejemplo · asistente virtual (IA)') + '</div></div>';
    var root = $(mount, '.rs-call'), talkEl = $(root, '[data-talk]'), items = $(root, '[data-items]');
    var stateEl = $(root, '[data-s]'), timerEl = $(root, '[data-t]'), tk = $(root, '[data-tk]');
    var meta = $(root, '[data-meta]'), stamp = $(root, '[data-stamp]'), replay = $(root, '[data-replay]');
    var token = 0, secs = 0, tmr = null;
    var fmt = function (n) { return ('0' + Math.floor(n / 60)).slice(-2) + ':' + ('0' + (n % 60)).slice(-2); };
    var iaL = cfg.iaLabel || 'Asistente virtual (IA)', cliL = cfg.cliLabel || 'Cliente';
    function reset() {
      talkEl.innerHTML = ''; if (items) items.innerHTML = '';
      if (meta) meta.classList.remove('show'); if (stamp) stamp.classList.remove('show');
      stateEl.textContent = cfg.s0; root.classList.remove('done'); if (timerEl) timerEl.textContent = '00:00';
      if (tk) tk.textContent = card.head ? (card.head[1] || '') : ''; replay.hidden = true; secs = 0; clearInterval(tmr);
    }
    function addRow(r) { if (!items) return; var li = document.createElement('li'); li.innerHTML = '<b>' + esc(r[0]) + '</b><span>' + esc(r[1]) + '</span>'; items.appendChild(li); requestAnimationFrame(function () { li.classList.add('show'); }); }
    function rowsOf(fx) { return !fx || !fx.row ? [] : (Array.isArray(fx.row[0]) ? fx.row : [fx.row]); }
    function finish() {
      stateEl.textContent = cfg.s2; root.classList.add('done'); if (tk && card.head) tk.textContent = card.head[2] || card.head[1] || '';
      if (meta) meta.classList.add('show'); if (stamp) stamp.classList.add('show'); replay.hidden = false;
    }
    async function play() {
      var my = ++token; reset();
      if (reduce) {
        cfg.lines.forEach(function (s) { var d = document.createElement('div'); d.className = 'rs-line show ' + s.w; d.innerHTML = '<small>' + esc(s.w === 'ia' ? iaL : cliL) + '</small>' + esc(s.t); talkEl.appendChild(d); rowsOf(s.fx).forEach(addRow); });
        if (items) Array.prototype.forEach.call(items.children, function (li) { li.classList.add('show'); });
        finish(); return;
      }
      await sleep(900); if (my !== token) return;
      stateEl.textContent = cfg.s1; if (tk && card.head) tk.textContent = card.head[1] || '';
      if (timerEl) tmr = setInterval(function () { secs++; timerEl.textContent = fmt(secs); }, 1000);
      for (var i = 0; i < cfg.lines.length; i++) {
        var s = cfg.lines[i], d = document.createElement('div');
        d.className = 'rs-line ' + s.w + ' typing';
        d.innerHTML = '<small>' + esc(s.w === 'ia' ? iaL : cliL) + '</small><span></span>';
        talkEl.appendChild(d); requestAnimationFrame((function (x) { return function () { x.classList.add('show'); }; })(d));
        var span = $(d, 'span'), txt = s.t;
        for (var c = 0; c < txt.length; c++) { if (my !== token) return; span.textContent += txt[c]; await sleep(s.w === 'ia' ? 22 : 28); }
        d.classList.remove('typing');
        rowsOf(s.fx).forEach(addRow);
        if (s.fx && s.fx.meta && meta) meta.classList.add('show');
        if (s.fx && s.fx.done) { await sleep(450); if (my !== token) return; clearInterval(tmr); finish(); return; }
        await sleep(620); if (my !== token) return;
      }
      clearInterval(tmr); finish();
    }
    replay.addEventListener('click', play);
    if ('IntersectionObserver' in window) new IntersectionObserver(function (es, o) { if (es[0].isIntersecting) { o.disconnect(); play(); } }, { threshold: 0.3 }).observe(root);
    else play();
  }

  /* ─────────────── 2. Pantalla de ordenador ─────────────── */
  function screen(cfg, mount) {
    var tiles = cfg.tiles || [];
    var legend = (cfg.legend || []).map(function (l) { return '<span><i style="' + l[1] + '"></i>' + esc(l[0]) + '</span>'; }).join('');
    var ph = cfg.phone;
    var phone = ph ? '<div class="rs-mob" aria-hidden="true"><h5>' + esc(ph.title) + '</h5>' + ph.fields.map(function (f) { return '<div class="f"><span>' + esc(f[0]) + '</span><b>' + esc(f[1]) + '</b></div>'; }).join('') + '<button type="button" data-mb>' + esc(ph.btn) + '</button></div>' : '';
    mount.innerHTML =
      '<div class="rs-stage" role="img" aria-label="' + esc(cfg.aria || 'Simulación de ejemplo de la pantalla del negocio') + '"><div class="rs-laptop"><div class="rs-screen">' +
      '<div class="rs-bar"><div class="rs-dots"><i></i><i></i><i></i></div><span class="rs-url">' + esc(cfg.url) + '</span><span class="rs-live">' + esc(cfg.live || 'en directo') + '</span></div>' +
      '<div class="rs-app"><div class="rs-toast" data-toast><div class="ic">' + (ICON[cfg.icon] || ICON.cal) + '</div><div><b data-tn></b><span data-ti></span></div><div class="sv">' + esc(cfg.saved || '✓ GUARDADO') + '</div></div>' +
      '<div><div class="rs-h"><span>' + esc(cfg.leftTitle) + '</span><span data-count></span></div><div class="rs-floor" data-floor style="grid-template-columns:repeat(' + (cfg.cols || 4) + ',minmax(0,1fr))"></div><div class="rs-legend">' + legend + '</div></div>' +
      '<div><div class="rs-h"><span>' + esc(cfg.rightTitle) + '</span><span>' + esc(cfg.rightTag || 'ordenadas') + '</span></div><div class="rs-list" data-list></div></div>' +
      '</div></div><div class="rs-base"></div>' + phone + '</div></div>' +
      '<p class="rs-caption">' + esc(cfg.caption || 'Ejemplo de la pantalla de un negocio. Los datos son ficticios.') + '</p>';
    var stage = $(mount, '.rs-stage'), floor = $(mount, '[data-floor]'), list = $(mount, '[data-list]'), toast = $(mount, '[data-toast]');
    var count = $(mount, '[data-count]'), mb = $(mount, '[data-mb]');
    var nounOne = (cfg.noun || ['elemento', 'elementos'])[0], nounMany = (cfg.noun || ['elemento', 'elementos'])[1];
    tiles.forEach(function (t) {
      var d = document.createElement('div'); d.className = 'rs-tb' + (t.round ? ' round' : '') + (t.state ? ' ' + t.state : ''); d.setAttribute('data-id', t.id);
      d.innerHTML = '<b>' + esc(t.label) + '</b><em>' + esc(t.sub || '') + '</em>'; floor.appendChild(d);
    });
    var tileEl = function (id) { return floor.querySelector('[data-id="' + id + '"]'); };
    function resetB() {
      list.innerHTML = ''; count.textContent = '0 ' + nounMany;
      tiles.forEach(function (t) { var el = tileEl(t.id); el.className = 'rs-tb' + (t.round ? ' round' : '') + (t.state ? ' ' + t.state : ''); el.querySelector('em').textContent = t.sub || ''; });
      toast.classList.remove('show', 'saved');
    }
    function commit(e, i) {
      var el = e.tile && tileEl(e.tile);
      if (el) { el.classList.remove('busy'); el.classList.add(e.state || 'res', 'pulse'); el.querySelector('em').textContent = e.tileText || ''; }
      var row = document.createElement('div'); row.className = 'rs-row';
      row.innerHTML = '<span class="h">' + esc(e.h) + '</span><span class="n">' + esc(e.n) + '<small>' + esc(e.sub) + '</small></span><span class="rs-src">' + esc(e.src) + '</span><span class="rs-ok">✓</span>';
      list.appendChild(row); requestAnimationFrame(function () { row.classList.add('show'); });
      count.textContent = (i + 1) + ' ' + (i ? nounMany : nounOne);
    }
    var running = 0;
    async function loop(my) {
      while (my === running) {
        resetB(); await sleep(900);
        for (var i = 0; i < cfg.events.length; i++) {
          if (my !== running) return; var e = cfg.events[i];
          $(toast, '[data-tn]').textContent = e.toast[0]; $(toast, '[data-ti]').textContent = e.toast[1];
          if (mb && ph.pressOn === i) mb.classList.add('press');
          toast.classList.remove('saved'); toast.classList.add('show'); await sleep(1100);
          if (my !== running) return; toast.classList.add('saved'); commit(e, i); await sleep(1300);
          if (mb) mb.classList.remove('press'); toast.classList.remove('show'); await sleep(700);
        }
        await sleep(3600);
      }
    }
    if (reduce) { resetB(); cfg.events.forEach(commit); }
    else if ('IntersectionObserver' in window) new IntersectionObserver(function (es) {
      if (es[0].isIntersecting && !running) { running = 1; loop(1); } else if (!es[0].isIntersecting && running) { running = 0; }
    }, { threshold: 0.3 }).observe(stage);
    else { running = 1; loop(1); }
  }

  function boot() {
    var a = document.getElementById('simTalk'), b = document.getElementById('simScreen');
    if (a && window.SIM_TALK) talk(window.SIM_TALK, a);
    if (b && window.SIM_SCREEN) screen(window.SIM_SCREEN, b);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
