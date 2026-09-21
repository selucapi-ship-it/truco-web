/* Portada: hub interactivo del Departamento, expansores de tarjetas y plegado móvil. */
(function () {
  'use strict';
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ───────── HUB ───────── */
  var SYS = {
    wa:   { label: 'WhatsApp',         idle: 'Contesta y agenda las 24 h' },
    mail: { label: 'Correo',           idle: 'Contesta por ti, con tu tono' },
    db:   { label: 'Base de datos',    idle: 'Guarda a cada cliente y cada cita' },
    bot:  { label: 'Asistente virtual', idle: 'Chat y llamadas, siempre atendidos' },
    web:  { label: 'Web interactiva',  idle: 'Tu escaparate, siempre al día' }
  };
  var REQ = [
    { chip: 'Me he puesto enfermo',
      say: '“Me he puesto enfermo: aplaza las citas de hoy.”',
      acts: { wa: 'Avisa a cada cliente y propone nueva hora', mail: 'Avisa a quien tenía cita y escribió por correo', db: 'Libera tu agenda de hoy', bot: 'Chat y llamadas avisan de que hoy no atiendes', web: 'Cierra los huecos de hoy en tu agenda' },
      done: 'Todas las citas de hoy avisadas y con nueva hora propuesta. Tú, a descansar.' },
    { chip: 'Cambiar el horario',
      say: '“Este sábado abrimos solo de 9 a 14.”',
      acts: { wa: 'Ya responde con el horario nuevo', mail: 'Contesta con el horario nuevo', db: 'El calendario ajusta los huecos libres', bot: 'Chat y llamadas avisan del cambio', web: 'Horario actualizado en tu web' },
      done: 'Cambiado en los cinco sitios a la vez. Tú solo lo dijiste una vez.' },
    { chip: 'Lanzar una oferta',
      say: '“Esta semana, 10% en la primera visita.”',
      acts: { wa: 'Ofrece el 10% a quien pregunte', mail: 'Incluye la oferta en sus respuestas', db: 'Anota a quién se la ofreció', bot: 'La menciona y agenda la cita', web: 'Banner de la oferta publicado' },
      done: 'La oferta está en marcha en todos tus canales, sin que tocaras nada.' },
    { chip: '¿Qué ha pasado hoy?',
      say: '“Resúmeme el día.”',
      acts: { wa: 'Cuenta las conversaciones de hoy', mail: 'Lista lo que queda por contestar', db: 'Reúne citas, contactos y pendientes', bot: 'Resume chats y llamadas', web: 'Cuántas personas escribieron desde la web' },
      done: 'Tu resumen está en el portal: citas de mañana y quién espera respuesta.' },
    { chip: 'Ajustar a mi asistente',
      say: '“Que no cierre ventas solo: que me avise antes.”',
      acts: { wa: 'Ajustado: te avisa antes de cerrar', bot: 'Ajustado en chat y llamadas', web: 'Ajustado en el chat de tu web' },
      done: 'Ajustado a tu manera, no a la nuestra. Sin pedir nada a ningún técnico.' }
  ];
  var INFO = {
    wa: 'WhatsApp: tu asistente contesta a tus clientes con tu tono, agenda las citas y te avisa de lo importante. Tú no lo tocas: se lo pides a tu Departamento.',
    mail: 'Correo: tu Departamento contesta por ti a las consultas habituales y te deja lo que de verdad necesita tu decisión.',
    db: 'Base de datos: cada persona que te escribe, llama o reserva entra en tu CRM con su historial, y tus citas en tu calendario.',
    bot: 'Asistente virtual: atiende el chat de tu web y, según tu Departamento, también las llamadas, y agenda mientras hablan.',
    web: 'Web interactiva: tu escaparate, con chat y agenda de citas, siempre actualizada por tu Departamento.'
  };

  function initHub(root) {
    var say = root.querySelector('.dh-say');
    var status = root.querySelector('.dh-status span');
    var report = root.querySelector('.dh-report > span:last-child');
    var chips = [].slice.call(root.querySelectorAll('.dh-chip'));
    var nodes = {};
    [].slice.call(root.querySelectorAll('.dh-sys')).forEach(function (n) { nodes[n.getAttribute('data-k')] = n; });
    var timers = [], idx = -1, auto = true, visible = false, loop = null;

    function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
    function clearAll() { timers.forEach(clearTimeout); timers = []; }
    function reset() {
      Object.keys(nodes).forEach(function (k) {
        nodes[k].classList.remove('on', 'off');
        nodes[k].querySelector('small').textContent = SYS[k].idle;
      });
      root.removeAttribute('data-run');
    }
    function type(el, text, done) {
      if (reduced) { el.textContent = text; done(); return; }
      var i = 0; el.textContent = '';
      (function step() {
        el.textContent = text.slice(0, ++i);
        if (i < text.length) later(step, 18); else done();
      })();
    }
    function play(i) {
      clearAll(); reset(); idx = i;
      var r = REQ[i];
      chips.forEach(function (c, k) { c.classList.toggle('on', k === i); });
      status.textContent = 'Escuchando…';
      report.innerHTML = '<b>Tu Departamento</b> · esperando tu petición…';
      type(say, r.say, function () {
        root.setAttribute('data-run', '1');
        status.textContent = 'Recibido — se pone a ello';
        later(function () {
          root.setAttribute('data-run', '2');
          status.textContent = 'Actuando sobre tus sistemas…';
          var keys = Object.keys(nodes), n = 0;
          keys.forEach(function (k) {
            var hit = r.acts[k];
            later(function () {
              if (hit) { nodes[k].classList.add('on'); nodes[k].querySelector('small').textContent = hit; }
              else { nodes[k].classList.add('off'); }
            }, 250 + (n++) * 260);
          });
          later(function () {
            status.textContent = 'Hecho';
            report.innerHTML = '<b>✓ Hecho.</b> ' + r.done;
            root.removeAttribute('data-run');
          }, 250 + keys.length * 260 + 300);
        }, 800);
      });
    }
    function schedule() {
      if (loop) clearTimeout(loop);
      if (!auto || !visible || reduced) return;
      loop = setTimeout(function () { play((idx + 1) % REQ.length); schedule(); }, 8200);
    }
    function userPick(i) { auto = false; if (loop) clearTimeout(loop); play(i); }

    chips.forEach(function (c, k) { c.addEventListener('click', function () { userPick(k); }); });
    Object.keys(nodes).forEach(function (k) {
      nodes[k].addEventListener('click', function () {
        auto = false; if (loop) clearTimeout(loop); clearAll(); reset();
        chips.forEach(function (c) { c.classList.remove('on'); });
        nodes[k].classList.add('on');
        status.textContent = 'Tu Departamento se encarga de esto';
        report.innerHTML = '<b>' + SYS[k].label + '.</b> ' + INFO[k].replace(/^[^:]+: /, '');
      });
    });
    reset();
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        visible = es[0].isIntersecting;
        if (visible && idx === -1) { play(0); }
        schedule();
      }, { threshold: 0.35 }).observe(root);
    } else { play(0); }
  }
  var hub = document.getElementById('deptHub');
  if (hub) initHub(hub);


  /* ───────── ¿Es esto para ti?: selector de sectores (lee las tarjetas del carrusel) ───────── */
  (function () {
    var box = document.getElementById('sectorPicker');
    var sec = document.getElementById('sectores');
    if (!box || !sec) return;
    var cards = [].slice.call(sec.querySelectorAll('.sector-card'));
    if (!cards.length) return;
    var SHORT = {
      'sectores/abogados.html': { chip: 'Abogados', ic: '⚖️', label: 'Te pasa', pains: ['WhatsApps acumulados mientras estás en juicio', 'Citas que se pierden por falta de confirmación'],
        sol: 'Entrenamos tu asistente con tus protocolos de consulta: atiende, agenda la reunión y te avisa. <b>Apareces cuando el cliente ya sabe que eres su abogado.</b>' },
      'sectores/clinicas.html': { chip: 'Clínicas', ic: '🩺', label: 'Te pasa', pains: ['Pacientes que llaman en consulta y no vuelven a intentarlo', 'Citas que se olvidan porque nadie avisó'],
        sol: 'Tu asistente conoce tu agenda y tus protocolos: responde dudas, confirma y recuerda cada cita. <b>Tú solo revisas la agenda por la mañana y por la noche.</b>' },
      'sectores/inmobiliarias.html': { chip: 'Inmobiliarias', ic: '🏠', label: 'Te pasa', pains: ['Interesados que escriben a las 23h y al día siguiente ya llamaron a otra agencia', 'Leads de portales que se enfrían esperando'],
        sol: 'Entrenado con las fichas de tus propiedades, responde al segundo, agenda la visita y hace seguimiento. <b>Si el interesado está listo, puede cerrar la venta sin que intervengas.</b>' },
      'sectores/estetica.html': { chip: 'Estética', ic: '💅', label: 'Te pasa', pains: ['Consultas de disponibilidad mientras estás atendiendo', 'Cancelaciones de última hora que nadie ocupa'],
        sol: 'Recibe las consultas, enlaza con tu agenda y ocupa cada cancelación. <b>Tú trabajas, el negocio se llena solo.</b>' },
      'sectores/oficios.html': { chip: 'Oficios', ic: '🔧', label: 'Te pasa', pains: ['Presupuestos por WhatsApp que no puedes contestar en obra', 'Clientes que se van al siguiente porque no coges el teléfono'],
        sol: 'Con tus tarifas y tu disponibilidad real, responde al momento y agenda la visita. <b>Si hay que cambiar algo, nos escribes a nosotros: tú nunca lo tocas.</b>' },
      'sectores/gimnasios.html': { chip: 'Gimnasios', ic: '🏋️', label: 'Te pasa', pains: ['Interesados por Instagram que no reciben respuesta', 'Bajas de socios a los que nadie atendió a tiempo'],
        sol: 'Se integra con lo que ya usas, atiende, retiene socios y agenda seguimientos. <b>Tú entrenas, nosotros cuidamos que no se vayan.</b>' },
      'sectores/comercio-pequeno.html': { chip: 'Comercio', ic: '🛍️', label: 'Por ejemplo', pains: ['Peluquería, barbería, esteticista', 'Papelería, frutería, florería, tienda de barrio'],
        sol: 'No necesitas web ni automatizarlo todo: con el Departamento <b>Start™</b> automatizamos gratis esa única cosa que se te escapa — WhatsApp, reservas o facturación.' }
    };
    var data = cards.map(function (c) {
      var a = c.querySelector('.sc-card-cta'), href = a ? a.getAttribute('href') : '#';
      var t = (c.querySelector('.sc-title') || {}).textContent || '', sub = (c.querySelector('.sc-sub') || {}).textContent || '';
      var sh = SHORT[href] || {};
      return {
        href: href, title: t, sub: sub, chip: sh.chip || t, ic: sh.ic || '•', label: sh.label || 'Te pasa',
        pains: sh.pains || [].slice.call(c.querySelectorAll('.sc-pains li')).map(function (l) { return l.textContent; }),
        sol: sh.sol || ((c.querySelector('.sc-solution p') || {}).innerHTML || '')
      };
    });
    var chips = box.querySelector('.sp-chips'), panel = box.querySelector('.sp-panel'), btns = [];
    function show(i) {
      var d = data[i];
      btns.forEach(function (b, k) { b.classList.toggle('on', k === i); b.setAttribute('aria-selected', k === i ? 'true' : 'false'); });
      panel.innerHTML = '<div class="sp-head"><b>' + d.title + '</b><span>' + d.sub + '</span></div>' +
        '<div class="sp-row"><em>' + d.label + '</em><ul>' + d.pains.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul></div>' +
        '<div class="sp-row sp-sol"><em>Lo que hacemos</em><p>' + d.sol + '</p></div>' +
        '<a class="sc-card-cta" href="' + d.href + '">Ver cómo queda en mi sector →</a>';
    }
    data.forEach(function (d, i) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'sp-chip'; b.setAttribute('role', 'tab');
      b.innerHTML = '<span>' + d.ic + '</span>' + d.chip;
      b.addEventListener('click', function () { show(i); });
      chips.appendChild(b); btns.push(b);
    });
    sec.classList.add('sp-on');
    show(0);
  })();


  /* ───────── Comparativa: el chat de socio se reproduce al verse ───────── */
  (function () {
    var chat = document.getElementById('vsChat');
    if (!chat || reduced || !('IntersectionObserver' in window)) return;
    var msgs = [].slice.call(chat.querySelectorAll('.vs-msg'));
    chat.classList.add('vs-anim');
    var done = false;
    new IntersectionObserver(function (es, obs) {
      if (done || !es[0].isIntersecting) return;
      done = true; obs.disconnect();
      msgs.forEach(function (m, i) { setTimeout(function () { m.classList.add('show'); }, 500 + i * 1300); });
    }, { threshold: 0.5 }).observe(chat);
  })();


  /* ───────── Chat: se amplía cuando conversas; pantalla completa en móvil ───────── */
  (function () {
    var box = document.getElementById('chatBox');
    if (!box) return;
    var bd = document.createElement('div'); bd.id = 'chatBackdrop';
    bd.addEventListener('click', function () { setBig(false); });
    document.body.appendChild(bd);
    function isMobile() { return window.innerWidth <= 700; }
    function setBig(on) {
      box.classList.toggle('big', !!on);
      document.body.classList.toggle('chat-big', !!on && !isMobile());
    }
    window.toggleChatBig = function () { setBig(!box.classList.contains('big')); };
    function sync() {
      var open = box.classList.contains('open');
      document.body.classList.toggle('chat-open', open);
      if (!open) { setBig(false); }
    }
    new MutationObserver(sync).observe(box, { attributes: true, attributeFilter: ['class'] });
    var msgs = document.getElementById('chatMsgs');
    if (msgs) new MutationObserver(function (list) {
      list.forEach(function (m) {
        [].slice.call(m.addedNodes).forEach(function (n) {
          if (n.nodeType === 1 && n.classList.contains('user') && !isMobile()) setBig(true);
        });
      });
    }).observe(msgs, { childList: true });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && box.classList.contains('open') && typeof closeChat === 'function') closeChat();
    });
    var fl = document.getElementById('floatLabel');
    if (fl) fl.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (typeof openChat === 'function') openChat(); } });
  })();


  /* ───────── Sectores: las tarjetas con imagen aparecen escalonadas ───────── */
  (function () {
    var g = document.getElementById('sectorCards');
    if (!g || reduced || !('IntersectionObserver' in window)) return;
    var cards = [].slice.call(g.querySelectorAll('.scg-card'));
    g.classList.add('scg-js');
    new IntersectionObserver(function (es, obs) {
      if (!es[0].isIntersecting) return;
      obs.disconnect();
      cards.forEach(function (c, i) { setTimeout(function () { c.classList.add('in'); }, i * 110); });
    }, { threshold: 0.12 }).observe(g);
  })();

  /* ───────── Expansores “ver todo lo que puedes elegir” ───────── */
  [].slice.call(document.querySelectorAll('.entry-more')).forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var ul = b.previousElementSibling;
      var open = ul.classList.toggle('open');
      b.textContent = open ? 'Ver menos' : b.getAttribute('data-label');
    });
  });

  /* ───────── Secciones informativas plegadas en móvil ───────── */
  var mq = window.matchMedia('(max-width: 700px)');
  function foldSync() {
    [].slice.call(document.querySelectorAll('details.m-fold')).forEach(function (d) { d.open = !mq.matches; });
  }
  foldSync();
  if (mq.addEventListener) mq.addEventListener('change', foldSync);
  function openForHash() {
    var h = location.hash && location.hash.slice(1); if (!h) return;
    var el = document.getElementById(h); if (!el) return;
    var d = el.closest ? el.closest('details.m-fold') : null;
    if (d) { d.open = true; setTimeout(function () { el.scrollIntoView(); }, 30); }
  }
  window.addEventListener('hashchange', openForHash);
  [].slice.call(document.querySelectorAll('a[href^="#"]')).forEach(function (a) {
    a.addEventListener('click', function () {
      var id = a.getAttribute('href').slice(1); var el = id && document.getElementById(id);
      var d = el && el.closest ? el.closest('details.m-fold') : null;
      if (d) d.open = true;
    });
  });
})();
