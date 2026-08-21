// ── PRECIOS DE AUTOMATIZACIONES — WhatsApp, Web, Llamadas, Correo, etc. ──
//
// Mismo patrón que founding-offer.js: los números de abajo son solo el valor
// de arranque/fallback (por si Supabase no responde). En cuanto la página
// carga, se piden los precios reales a la tabla solutions_catalog de
// Supabase — es la MISMA tabla que ya se edita desde admin/panel.html, así
// que cambiar un precio ahí (ej. para una oferta de Navidad) se refleja solo
// en cualquier página que incluya este script, sin tocar código.
//
// price_eur = valor de la automatización cuando va incluida dentro de un
// Departamento (Start/Basic/Lite/Pro). standalone_price_eur = precio de
// venderla suelta, fuera de cualquier Departamento (no todas las
// automatizaciones se venden sueltas).
const SOLUTION_PRICES = {
  whatsapp: 590, 'web-ia': 350, llamadas: 690, 'email-ia': 350,
  reservas: 350, firma: 500, ciberseguridad: 450, automatizaciones: 350, truki: 580,
};
const SOLUTION_STANDALONE_PRICES = {
  'web-ia': 29, crm: 950, docs: 400, integraciones: 600,
};

function solutionPrice(key) { return SOLUTION_PRICES[key] ?? null; }
function solutionStandalonePrice(key) { return SOLUTION_STANDALONE_PRICES[key] ?? null; }

// Mismo mecanismo de re-pintado que founding-offer.js: cada página empuja
// aquí su propia función de renderizado la primera vez que la llama, y se
// vuelve a llamar sola en cuanto llega el precio real de Supabase.
window.onSolutionsPricingUpdated = window.onSolutionsPricingUpdated || [];

(function fetchLiveSolutionsPricing() {
  const SUPABASE_URL = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_dMe9-l4q9RvLgdUFRY3gWA_iIMilsXX';
  fetch(SUPABASE_URL + '/rest/v1/solutions_catalog?select=solution_key,price_eur,standalone_price_eur', {
    headers: { apikey: SUPABASE_ANON_KEY }
  })
    .then(r => r.ok ? r.json() : null)
    .then(rows => {
      if (!Array.isArray(rows) || !rows.length) return;
      rows.forEach(row => {
        if (row.price_eur !== null && row.price_eur !== undefined) SOLUTION_PRICES[row.solution_key] = Number(row.price_eur);
        if (row.standalone_price_eur !== null && row.standalone_price_eur !== undefined) SOLUTION_STANDALONE_PRICES[row.solution_key] = Number(row.standalone_price_eur);
      });
      window.onSolutionsPricingUpdated.forEach(fn => { try { fn(); } catch (e) {} });
    })
    .catch(() => {}); // Supabase caído o sin red: se queda con los valores de fallback, no rompe nada.
})();
