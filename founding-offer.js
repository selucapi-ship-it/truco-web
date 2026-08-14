// ── OFERTA DE FUNDADOR — Start™, Basic™, Lite™ y Pro™ ──
//
// El contador NO se edita a mano: los números de abajo son solo el valor de
// arranque/fallback (por si Supabase no responde). En cuanto la página carga,
// se pide el valor real a la tabla founding_spots de Supabase — cada pago real
// a precio de fundador la decrementa automáticamente desde
// netlify/functions/stripe-webhook.js (ver supabase/migration_founding_spots.sql).
// Cuando el contador de un tier llegue a 0, la oferta desaparece sola PARA ESE
// TIER en todas las páginas y se queda su precio estándar.
//
// Las claves de tier ('start','basic','lite','pro') son las mismas que usa
// pago.html en ARRANQUES/DIRECT y coinciden con los nombres visibles
// (Start™/Basic™/Lite™/Pro™).
const FOUNDING_SPOTS_TOTAL = { start: 10, basic: 10, lite: 10, pro: 10 };
const FOUNDING_SPOTS_LEFT = { start: 10, basic: 10, lite: 10, pro: 10 };

// Precios — no tocar salvo que cambie la estrategia de precios en general.
const FOUNDING_PRICES = { start: 69, basic: 149, lite: 229, pro: 449 };
const STANDARD_PRICES = { start: 89, basic: 169, lite: 279, pro: 549 };

function foundingActive(tier){ return FOUNDING_SPOTS_LEFT[tier] > 0; }
function currentPrice(tier){ return foundingActive(tier) ? FOUNDING_PRICES[tier] : STANDARD_PRICES[tier]; }

// Cada página que pinta un precio/badge de fundador registra aquí su propia
// función de renderizado (empujándola a este array justo después de llamarla
// la primera vez). Así, si el número real de Supabase llega después de ese
// primer pintado (lo normal, por ser una petición de red), la página se
// vuelve a pintar sola con el dato correcto — sin tener que tocar nada más.
window.onFoundingSpotsUpdated = window.onFoundingSpotsUpdated || [];

(function fetchLiveFoundingSpots(){
  const SUPABASE_URL = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_dMe9-l4q9RvLgdUFRY3gWA_iIMilsXX';
  fetch(SUPABASE_URL + '/rest/v1/founding_spots?select=tier,spots_left', {
    headers: { apikey: SUPABASE_ANON_KEY }
  })
    .then(r => r.ok ? r.json() : null)
    .then(rows => {
      if (!Array.isArray(rows)) return;
      let changed = false;
      rows.forEach(row => {
        const left = Math.max(0, Number(row.spots_left));
        if (row.tier in FOUNDING_SPOTS_LEFT && FOUNDING_SPOTS_LEFT[row.tier] !== left) {
          FOUNDING_SPOTS_LEFT[row.tier] = left;
          changed = true;
        }
      });
      // Se re-pinta siempre que hay filas válidas, no solo si "changed": la
      // primera carga de una página nueva parte del valor de fallback de
      // arriba, y el valor real casi siempre difiere de él la primera vez.
      window.onFoundingSpotsUpdated.forEach(fn => { try { fn(); } catch (e) {} });
    })
    .catch(() => {}); // Supabase caído o sin red: se queda con los valores de fallback, no rompe nada.
})();
