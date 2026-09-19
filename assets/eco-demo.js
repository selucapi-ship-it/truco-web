// Demo interactiva del ecosistema TRUCO: portal, CRM y calendario con datos de ejemplo.
(function () {
  var root = document.getElementById('ecoApp');
  if (!root) return;
  var $ = function (s, r) { return (r || root).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || root).querySelectorAll(s)); };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ST = [['nuevo', 'Nuevos', '#2f7bff'], ['contactado', 'Contactados', '#a78bfa'], ['cita', 'Con cita', '#d9a83f'], ['cliente', 'Clientes', '#22c55e']];
  var COLORS = ['#ecc878', '#9cc2ff', '#b5f0c8', '#e9b3ff', '#ffc9a1', '#a8e6e0'];
  var people = [
    { n: 'Javier Ruiz', s: 'nuevo', src: '💬 WhatsApp', m: '“¿Cuánto cuesta una web para mi taller?”' },
    { n: 'Clínica Sol', s: 'contactado', src: '✉️ Correo', m: 'Pide presupuesto para gestionar sus citas.' },
    { n: 'Ana López', s: 'contactado', src: '🌐 Web', m: 'Pregunta si trabajáis los sábados.' },
    { n: 'Marta Soto', s: 'cita', src: '📅 Reserva', m: 'Reservó “Primera consulta” · jueves 11:00.' },
    { n: 'Diego Ferrer', s: 'cliente', src: '📞 Llamada', m: 'Contrato firmado. Empieza la semana que viene.' },
    { n: 'La Plaza', s: 'cliente', src: '✉️ Correo', m: 'Renuevan el servicio de mantenimiento.' }
  ];
  var citas = [
    { h: '11:00', n: 'Marta Soto', s: 'Primera consulta', by: 'Agendada por tu asistente de WhatsApp a las 09:41' },
    { h: '13:30', n: 'Pedro Vidal', s: 'Revisión', by: 'Reservada en tu web mientras comías' },
    { h: '17:00', n: 'Lucía Prieto', s: 'Presupuesto', by: 'Agendada por tu asistente al atender una llamada' }
  ];
  var feed = [
    { t: '17:30', h: '✉️ <b>Correo respondido</b> a Clínica Sol — presupuesto enviado.' },
    { t: '13:05', h: '📞 <b>Llamada atendida:</b> Lucía Prieto pidió cita y ya está en tu agenda.' },
    { t: '11:20', h: '📅 <b>Cita agendada:</b> Pedro Vidal, hoy a las 13:30.' },
    { t: '09:41', h: '💬 <b>WhatsApp atendido:</b> Marta Soto reservó su primera consulta.' }
  ];
  var sel = null, selAp = null, dragName = null;
  var color = function (n) { var h = 0; for (var i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0; return COLORS[h % COLORS.length]; };
  var ini = function (n) { return n.split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase(); };

  function show(v) {
    $$('.eco2-view').forEach(function (el) { el.hidden = el.getAttribute('data-v') !== v; });
    $$('.eco2-tab').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-go') === v); b.setAttribute('aria-selected', b.getAttribute('data-go') === v); });
  }
  function counts() {
    var wait = people.filter(function (p) { return p.s === 'nuevo'; }).length;
    return { total: people.length + 18, wait: wait + 1, citas: citas.length };
  }
  function renderPortal() {
    var c = counts();
    $('#eco-tile-crm span').innerHTML = '<b style="display:inline;font:700 .68rem DM Sans,sans-serif;color:#f2f0ea">' + c.total + ' contactos</b> · ' + c.wait + ' esperan tu respuesta';
    $('#eco-tile-cal span').innerHTML = '<b style="display:inline;font:700 .68rem DM Sans,sans-serif;color:#f2f0ea">' + c.citas + ' citas hoy</b> · la siguiente, a las ' + citas[0].h;
    $('#eco-feed').innerHTML = feed.slice(0, 5).map(function (e, i) { return '<div class="eco2-ev' + (e.fresh ? ' new' : '') + '"><time>' + e.t + '</time><span>' + e.h + '</span></div>'; }).join('');
  }
  function renderCrm() {
    var c = counts();
    $('#eco-kpis').innerHTML = '<div><b>' + c.total + '</b>contactos</div><div><b>' + c.citas + '</b>citas hoy</div><div class="hot"><b>' + c.wait + '</b>esperan respuesta</div>';
    $('#eco-board').innerHTML = ST.map(function (s) {
      var list = people.filter(function (p) { return p.s === s[0]; });
      return '<div class="eco2-col" data-k="' + s[0] + '"><h4><i style="background:' + s[2] + '"></i>' + s[1] + '<em>' + list.length + '</em></h4>' +
        list.map(function (p) {
          return '<button type="button" class="eco2-c' + (sel === p.n ? ' sel' : '') + (p.fresh ? ' new' : '') + '" draggable="true" data-n="' + esc(p.n) + '"><span class="t"><span class="av" style="background:' + color(p.n) + '">' + ini(p.n) + '</span><span><b>' + esc(p.n) + '</b>' + p.src + '</span></span></button>';
        }).join('') + '</div>';
    }).join('');
    var d = $('#eco-det');
    var p = people.filter(function (x) { return x.n === sel; })[0];
    d.innerHTML = p
      ? '<b>' + esc(p.n) + '</b> · ' + p.src + '<br>' + p.m + '<div class="mv">' + ST.map(function (s) { return '<button type="button" data-mv="' + s[0] + '" class="' + (p.s === s[0] ? 'on' : '') + '">' + (p.s === s[0] ? '● ' : 'Pasar a ') + s[1].replace(/s$/, '') + '</button>'; }).join('') + '</div>'
      : '<span>👆 Toca un contacto para ver su historial y cambiarle el estado. También puedes arrastrarlo.</span>';
    people.forEach(function (x) { x.fresh = false; });
  }
  function renderCal() {
    $('#eco-cal').innerHTML = '<div class="eco2-day">Hoy · jueves</div>' + citas.map(function (a, i) {
      return '<button type="button" class="eco2-ap' + (selAp === i ? ' sel' : '') + (a.fresh ? ' new' : '') + '" data-i="' + i + '"><span class="h">' + a.h + '</span><span><b>' + esc(a.n) + '</b>' + esc(a.s) + (selAp === i ? '<br><em style="color:#b5f0c8;font-style:normal">✓ ' + esc(a.by) + '</em>' : '') + '</span></button>';
    }).join('');
    citas.forEach(function (a) { a.fresh = false; });
  }
  function all() { renderPortal(); renderCrm(); renderCal(); }

  root.addEventListener('click', function (e) {
    var go = e.target.closest('[data-go]'); if (go) { show(go.getAttribute('data-go')); return; }
    var card = e.target.closest('.eco2-c'); if (card) { sel = card.getAttribute('data-n'); renderCrm(); return; }
    var mv = e.target.closest('[data-mv]');
    if (mv) { var p = people.filter(function (x) { return x.n === sel; })[0]; if (p) { p.s = mv.getAttribute('data-mv'); renderCrm(); renderPortal(); } return; }
    var ap = e.target.closest('.eco2-ap'); if (ap) { selAp = +ap.getAttribute('data-i'); renderCal(); }
  });
  root.addEventListener('dragstart', function (e) { var c = e.target.closest('.eco2-c'); if (!c) return; dragName = c.getAttribute('data-n'); c.classList.add('drag'); if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragName); } });
  root.addEventListener('dragend', function (e) { var c = e.target.closest('.eco2-c'); if (c) c.classList.remove('drag'); });
  root.addEventListener('dragover', function (e) { var col = e.target.closest('.eco2-col'); if (col) { e.preventDefault(); col.classList.add('over'); } });
  root.addEventListener('dragleave', function (e) { var col = e.target.closest('.eco2-col'); if (col) col.classList.remove('over'); });
  root.addEventListener('drop', function (e) {
    var col = e.target.closest('.eco2-col'); if (!col) return; e.preventDefault();
    var p = people.filter(function (x) { return x.n === dragName; })[0]; if (p) { p.s = col.getAttribute('data-k'); sel = p.n; renderCrm(); renderPortal(); }
  });

  // Vida propia: cada pocos segundos entra algo nuevo, para que se vea que se llena solo.
  var script = [
    function () { people.unshift({ n: 'Lucía Prieto', s: 'nuevo', src: '💬 WhatsApp', m: '“Hola, ¿tenéis hueco esta semana?”', fresh: true }); feed.unshift({ t: 'Ahora', h: '💬 <b>Nuevo contacto por WhatsApp:</b> Lucía Prieto — ya está en tu CRM.', fresh: true }); },
    function () { citas.push({ h: '18:15', n: 'Sonia Martín', s: 'Urgencia', by: 'Agendada por tu asistente hace un momento', fresh: true }); feed.unshift({ t: 'Ahora', h: '📅 <b>Cita agendada:</b> Sonia Martín, hoy a las 18:15 — ya en tu calendario.', fresh: true }); },
    function () { people.unshift({ n: 'Pedro Vidal', s: 'cita', src: '📅 Reserva', m: 'Reservó “Revisión” · viernes 10:00.', fresh: true }); feed.unshift({ t: 'Ahora', h: '🌐 <b>Reserva en tu web:</b> Pedro Vidal — guardado en tu CRM y en tu agenda.', fresh: true }); }
  ];
  var step = 0, timer = null;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function tick() { if (step >= script.length) { clearInterval(timer); return; } script[step++](); all(); }
  function start() { if (!timer && !reduce) timer = setInterval(tick, 6500); }
  function stop() { clearInterval(timer); timer = null; }
  if ('IntersectionObserver' in window) new IntersectionObserver(function (en) { en[0].isIntersecting ? start() : stop(); }, { threshold: 0.4 }).observe(root);
  all(); show('portal');
})();
