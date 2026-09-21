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
