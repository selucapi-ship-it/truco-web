// ── ANALÍTICA PROPIA DEL SITIO ──
// Registra vistas de página y clics en botones clave contra Supabase
// (log_page_view / log_button_click, ver supabase/migration_site_analytics.sql)
// para alimentar la sección "Interacciones y Actividad" del panel admin.
// Nada de esto identifica a la persona — mismo criterio de privacidad que el
// resto del sitio: solo cuenta, con un id de sesión anónimo por navegador.
//
// Fire-and-forget a propósito: si Supabase falla o el visitante bloquea la
// petición, la página sigue funcionando exactamente igual, sin errores
// visibles ni bloqueos.
(function () {
  const SUPABASE_URL = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_dMe9-l4q9RvLgdUFRY3gWA_iIMilsXX';

  function sessionId() {
    try {
      let id = localStorage.getItem('truco_session_id');
      if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2));
        localStorage.setItem('truco_session_id', id);
      }
      return id;
    } catch (e) { return null; }
  }

  function call(fn, payload) {
    try {
      fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    } catch (e) { /* nunca debe romper la página */ }
  }

  // Vista de página — una vez por carga, nada más cargar el DOM.
  call('log_page_view', {
    p_page: location.pathname,
    p_session_id: sessionId(),
    p_referrer: (document.referrer || '').slice(0, 300),
  });

  // Helper global para marcar clics en botones/CTAs clave desde cualquier
  // página: onclick="trucoTrackClick('nombre_del_boton')" además de lo que
  // ese botón ya hiciera.
  window.trucoTrackClick = function (buttonKey) {
    call('log_button_click', { p_button_key: buttonKey, p_page: location.pathname, p_session_id: sessionId() });
  };

  // ── GOOGLE ANALYTICS 4 ──
  // Único sitio donde vive el ID: todas las páginas cargan este fichero.
  // Solo se carga si el visitante aceptó las cookies de análisis en el banner
  // de index.html (misma lectura localStorage + cookie propia que allí).
  const GA_MEASUREMENT_ID = 'G-L7GSH66RN6';

  function consentAccepted() {
    let v = null;
    try { v = localStorage.getItem('cookie_consent'); } catch (e) {}
    if (!v) { const m = document.cookie.match(/(?:^|; )cookie_consent=(accepted|rejected)/); if (m) v = m[1]; }
    return v === 'accepted';
  }

  window.trucoLoadGA = function () {
    if (window.gaLoaded) return;
    window.gaLoaded = true;
    const s = document.createElement('script');
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID;
    s.async = true;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_MEASUREMENT_ID);
  };

  if (consentAccepted()) window.trucoLoadGA();
})();
