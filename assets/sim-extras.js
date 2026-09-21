/* Widgets únicos de cada página: CRM, firma digital, recordatorios, flujos, avisos… Se configuran con window.SIM_EXTRAS. */
(function () {
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var SV = function (d) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>'; };
  var IC = {
    bell: SV('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
    check: SV('<polyline points="20 6 9 17 4 12"/>'),
    cal: SV('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
    chat: SV('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
    mail: SV('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/>'),
    phone: SV('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>'),
    doc: SV('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
    user: SV('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    bolt: SV('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
    shield: SV('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>'),
    search: SV('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    folder: SV('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
    warn: SV('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    star: SV('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
    globe: SV('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
    cart: SV('<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>'),
    key: SV('<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>')
  };
  var ic = function (n) { return IC[n] || IC.check; };
  var $ = function (r, s) { return r.querySelector(s); };

  /* cada widget devuelve { start(token, isAlive) } y se repite mientras está visible */
  var W = {};

  /* ── CRM / tablero ── */
  W.kanban = function (c, st) {
    var cols = c.cols, cards = c.cards, moves = c.moves;
    st.innerHTML = '<div class="wk" style="grid-template-columns:repeat(' + cols.length + ',minmax(0,1fr))">' + cols.map(function (n, i) { return '<div class="wk-col" data-c="' + i + '"><h6>' + esc(n) + '</h6></div>'; }).join('') + '</div><div class="w-msg" data-msg></div>';
    var msg = $(st, '[data-msg]');
    var colEl = function (i) { return st.querySelector('[data-c="' + i + '"]'); };
    function put(cd, ci, cls) {
      var el = st.querySelector('[data-k="' + cd.id + '"]');
      if (!el) { el = document.createElement('div'); el.setAttribute('data-k', cd.id); el.innerHTML = '<b>' + esc(cd.t) + '</b><span>' + esc(cd.s) + '</span>'; }
      el.className = 'wk-card' + (cls ? ' ' + cls : ''); el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
      colEl(ci).appendChild(el); return el;
    }
    function reset() { st.querySelectorAll('.wk-card').forEach(function (e) { e.remove(); }); cards.forEach(function (cd) { put(cd, cd.col); }); msg.textContent = ''; st.querySelectorAll('.wk-col').forEach(function (e) { e.classList.remove('hot'); }); }
    reset();
    return async function (alive) {
      reset(); if (reduce) { moves.forEach(function (m) { var cd = cards.filter(function (x) { return x.id === m[0]; })[0]; put(cd, m[1], m[1] === cols.length - 1 ? 'won' : 'now'); }); msg.textContent = moves[moves.length - 1][2]; return; }
      await sleep(900);
      for (var i = 0; i < moves.length; i++) {
        if (!alive()) return; var m = moves[i], cd = cards.filter(function (x) { return x.id === m[0]; })[0];
        st.querySelectorAll('.wk-col').forEach(function (e) { e.classList.remove('hot'); }); colEl(m[1]).classList.add('hot');
        put(cd, m[1], m[1] === cols.length - 1 ? 'won' : 'now'); msg.textContent = m[2]; await sleep(1500);
      }
      await sleep(2600);
    };
  };

  /* ── Firma digital ── */
  W.sign = function (c, st) {
    var lines = ''; for (var i = 0; i < (c.lines || 4); i++) lines += '<div class="wf-ln" style="width:' + (100 - (i * 9) % 30) + '%"></div>';
    st.innerHTML = '<div class="wf-doc"><h6>' + esc(c.doc) + '</h6>' + lines +
      '<div class="wf-sig"><svg viewBox="0 0 150 56" aria-hidden="true"><path d="M4 40 C 14 8, 26 6, 22 32 S 40 50, 52 22 S 72 8, 78 30 S 100 44, 116 22 S 134 14, 146 30" /></svg><small>' + esc(c.signer) + '</small></div>' +
      '<div class="wf-stamp">✓ ' + esc(c.stamp || 'FIRMADO') + '</div><div class="wf-chip">' + ic('check') + esc(c.after || 'Copia enviada y guardada') + '</div></div>';
    var p = $(st, 'path'), len = p.getTotalLength(), stamp = $(st, '.wf-stamp'), chip = $(st, '.wf-chip');
    var set = function (v) { p.style.strokeDasharray = len; p.style.strokeDashoffset = v; };
    set(len);
    return async function (alive) {
      stamp.classList.remove('show'); chip.classList.remove('show'); p.style.transition = 'none'; set(len);
      if (reduce) { set(0); stamp.classList.add('show'); chip.classList.add('show'); return; }
      await sleep(1000); if (!alive()) return; void p.getBoundingClientRect(); p.style.transition = 'stroke-dashoffset 1.8s ease-in-out'; set(0);
      await sleep(2000); if (!alive()) return; stamp.classList.add('show'); await sleep(600); chip.classList.add('show'); await sleep(3200);
    };
  };

  /* ── Línea de tiempo ── */
  W.timeline = function (c, st) {
    st.innerHTML = '<ul class="wt">' + c.steps.map(function (s) { return '<li class="' + (s.g ? 'g' : '') + '"><div class="wt-dot">' + ic(s.i) + '</div><div><b>' + esc(s.t) + '</b><span>' + esc(s.s) + '</span></div><em>' + esc(s.h || '') + '</em></li>'; }).join('') + '</ul>';
    var lis = st.querySelectorAll('li');
    return async function (alive) {
      lis.forEach(function (l) { l.classList.remove('on'); });
      if (reduce) { lis.forEach(function (l) { l.classList.add('on'); }); return; }
      await sleep(700);
      for (var i = 0; i < lis.length; i++) { if (!alive()) return; lis[i].classList.add('on'); await sleep(1300); }
      await sleep(2800);
    };
  };

  /* ── Lista que se va marcando ── */
  W.checklist = function (c, st) {
    st.innerHTML = '<div class="wc-bar"><i></i></div><ul class="wc-list">' + c.items.map(function (s) { return '<li><span class="bx">✓</span><span>' + esc(s[0]) + '</span><small>' + esc(s[1] || '') + '</small></li>'; }).join('') + '</ul>';
    var lis = st.querySelectorAll('li'), bar = $(st, '.wc-bar i');
    return async function (alive) {
      lis.forEach(function (l) { l.classList.remove('on'); }); bar.style.width = '0';
      if (reduce) { lis.forEach(function (l) { l.classList.add('on'); }); bar.style.width = '100%'; return; }
      await sleep(700);
      for (var i = 0; i < lis.length; i++) { if (!alive()) return; lis[i].classList.add('on'); bar.style.width = Math.round((i + 1) / lis.length * 100) + '%'; await sleep(1000); }
      await sleep(2800);
    };
  };

  /* ── Móvil con avisos ── */
  W.notify = function (c, st) {
    st.innerHTML = '<div class="wn">' + c.items.map(function (n) { return '<div class="wn-i ' + (n.c || '') + '"><div class="ic">' + ic(n.i) + '</div><div><b>' + esc(n.t) + '</b><span>' + esc(n.s) + '</span></div><em>' + esc(n.h || 'ahora') + '</em></div>'; }).join('') + '</div>';
    var it = st.querySelectorAll('.wn-i');
    return async function (alive) {
      it.forEach(function (l) { l.classList.remove('show'); });
      if (reduce) { it.forEach(function (l) { l.classList.add('show'); }); return; }
      await sleep(800);
      for (var i = 0; i < it.length; i++) { if (!alive()) return; it[i].classList.add('show'); await sleep(1500); }
      await sleep(2800);
    };
  };

  /* ── Documento que se escribe ── */
  W.doc = function (c, st) {
    st.innerHTML = '<div class="wd">' + (c.rows || []).map(function (r) { return '<div class="wd-r"><b>' + esc(r[0]) + '</b><span>' + esc(r[1]) + '</span></div>'; }).join('') +
      '<div class="wd-body"></div><div class="wd-btns">' + (c.btns || []).map(function (b, i, a) { return '<span class="' + (i === a.length - 1 ? 'p' : '') + '">' + esc(b) + '</span>'; }).join('') + '</div></div>';
    var body = $(st, '.wd-body'), btns = $(st, '.wd-btns');
    return async function (alive) {
      body.textContent = ''; btns.classList.remove('show'); body.classList.remove('typing');
      if (reduce) { body.textContent = c.text; btns.classList.add('show'); return; }
      await sleep(800); body.classList.add('typing');
      for (var i = 0; i < c.text.length; i++) { if (!alive()) return; body.textContent += c.text[i]; await sleep(20); }
      body.classList.remove('typing'); await sleep(500); btns.classList.add('show'); await sleep(3800);
    };
  };

  /* ── Flujo entre herramientas ── */
  W.flow = function (c, st) {
    st.innerHTML = '<div class="wl">' + c.nodes.map(function (n, i) { return (i ? '<div class="wl-c"><i></i></div>' : '') + '<div class="wl-n"><div class="ic">' + ic(n.i) + '</div><div><b>' + esc(n.t) + '</b><span>' + esc(n.s) + '</span></div></div>'; }).join('') + '</div><div class="w-msg" data-msg></div>';
    var ns = st.querySelectorAll('.wl-n'), cs = st.querySelectorAll('.wl-c'), msg = $(st, '[data-msg]');
    return async function (alive) {
      ns.forEach(function (n) { n.classList.remove('on'); }); cs.forEach(function (n) { n.classList.remove('on'); }); msg.textContent = '';
      if (reduce) { ns.forEach(function (n) { n.classList.add('on'); }); cs.forEach(function (n) { n.classList.add('on'); }); msg.textContent = c.end || ''; return; }
      await sleep(700);
      for (var i = 0; i < ns.length; i++) { if (!alive()) return; if (i) cs[i - 1].classList.add('on'); await sleep(i ? 350 : 0); ns[i].classList.add('on'); await sleep(1100); }
      msg.textContent = c.end || ''; await sleep(3200);
    };
  };

  /* ── Selector con pestañas ── */
  W.picker = function (c, st) {
    st.innerHTML = '<div class="wp-tabs">' + c.tabs.map(function (t, i) { return '<button type="button" data-i="' + i + '">' + esc(t.l) + '</button>'; }).join('') + '</div><div class="wp-body" data-b></div>';
    var btn = st.querySelectorAll('button'), body = $(st, '[data-b]'), cur = 0, manual = false;
    function show(i) { cur = i; btn.forEach(function (b, k) { b.classList.toggle('on', k === i); }); var t = c.tabs[i]; body.innerHTML = '<h5>' + esc(t.h) + '</h5><ul>' + t.p.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul><span class="wp-res">' + esc(t.r) + '</span>'; }
    btn.forEach(function (b) { b.addEventListener('click', function () { manual = true; show(+b.getAttribute('data-i')); }); });
    show(0);
    return async function (alive) {
      if (reduce) return;
      while (alive() && !manual) { await sleep(3600); if (!alive() || manual) return; show((cur + 1) % c.tabs.length); }
    };
  };

  /* ── Buscador ── */
  W.search = function (c, st) {
    st.innerHTML = '<div class="ws-in"><span class="q" style="display:none"></span>' + ic('search') + '<span data-q></span></div>' + c.results.map(function (r) { return '<div class="ws-r">' + ic(r.i || 'doc') + '<div><b>' + esc(r.t) + '</b><small>' + esc(r.s) + '</small></div><em>' + esc(r.a || 'Abrir') + '</em></div>'; }).join('');
    var q = $(st, '[data-q]'), inp = $(st, '.ws-in'), rs = st.querySelectorAll('.ws-r');
    return async function (alive) {
      q.textContent = ''; rs.forEach(function (r) { r.classList.remove('show'); });
      if (reduce) { q.textContent = c.q; rs.forEach(function (r) { r.classList.add('show'); }); return; }
      await sleep(800); inp.classList.add('typing');
      for (var i = 0; i < c.q.length; i++) { if (!alive()) return; q.textContent += c.q[i]; await sleep(45); }
      inp.classList.remove('typing'); await sleep(400);
      for (var k = 0; k < rs.length; k++) { if (!alive()) return; rs[k].classList.add('show'); await sleep(600); }
      await sleep(3200);
    };
  };

  function boot() {
    var cfg = window.SIM_EXTRAS, mount = document.getElementById('simExtras');
    if (!cfg || !mount) return;
    mount.innerHTML = '<div class="w-grid' + (cfg.cards.length === 1 ? ' one' : '') + '">' + cfg.cards.map(function (c) {
      return '<div class="w-card"><div class="w-tag">' + esc(c.tag) + '</div><div class="w-h">' + esc(c.h) + '</div><div class="w-sub">' + esc(c.sub) + '</div><div class="w-stage"></div><div class="w-foot">' + esc(c.foot || 'Ejemplo con datos ficticios') + '</div></div>';
    }).join('') + '</div>';
    var cards = mount.querySelectorAll('.w-card');
    cfg.cards.forEach(function (c, i) {
      var stage = $(cards[i], '.w-stage'), run = W[c.type](c, stage), tok = 0, on = false;
      function loop() { var my = ++tok; (async function () { while (on && my === tok) { await run(function () { return on && my === tok; }); if (reduce) return; await sleep(60); } })(); }
      if (reduce) { run(function () { return true; }); return; }
      if ('IntersectionObserver' in window) new IntersectionObserver(function (es) {
        if (es[0].isIntersecting && !on) { on = true; loop(); } else if (!es[0].isIntersecting && on) { on = false; tok++; }
      }, { threshold: 0.35 }).observe(cards[i]);
      else { on = true; loop(); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
