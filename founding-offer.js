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

// Precios — mismo patrón que los cupos de arriba: estos son solo el valor de
// arranque/fallback. En cuanto la página carga se piden los precios reales a
// la tabla tier_config de Supabase (fuente de verdad única desde la migración
// "monstruo" — antes estaban duplicados a mano aquí y otra vez en
// portal/dashboard.html). Si Supabase no responde, se queda con estos valores.
const FOUNDING_PRICES = { start: 69, basic: 149, lite: 229, pro: 449 };
const STANDARD_PRICES = { start: 89, basic: 169, lite: 279, pro: 549 };

function foundingActive(tier){ return FOUNDING_SPOTS_LEFT[tier] > 0; }
function currentPrice(tier){ return foundingActive(tier) ? FOUNDING_PRICES[tier] : STANDARD_PRICES[tier]; }

// Formato de precio único para toda la web: coma para los decimales, punto
// para los miles (1.573,44) — no depende de Intl.toLocaleString('es-ES'),
// que ha dado resultados inconsistentes entre navegadores (a veces sin el
// punto de los miles). Antes cada página formateaba a mano con
// .toFixed(2).replace('.',',') y ninguna agrupaba los miles.
function fmtEuro(n){
  const partes=Math.abs(n).toFixed(2).split('.');
  const conMiles=partes[0].replace(/\B(?=(\d{3})+(?!\d))/g,'.');
  return (n<0?'-':'')+conMiles+','+partes[1];
}

// El precio real de un Departamento es el de su primer año: un bono anual
// pagado por adelantado (de una vez, con 12% dto., o fraccionado con
// SeQura) — nunca una cuota mensual que TRUCO cobre directamente durante
// esos 12 meses. La renovación automática a partir del segundo año sí es
// mensual, y es ese número el que se muestra como "luego X €/mes".
function annualPricingFor(monthly){
  const total=Math.round(monthly*12*0.88*100)/100;
  const totalIva=Math.round(total*1.21*100)/100;
  return { monthly, total, totalIva };
}
function annualPricing(tier){ return annualPricingFor(currentPrice(tier)); }
// El mismo cálculo pero con el precio estándar (sin fundador) — para poder
// tachar "lo que pagarías sin la oferta" al lado del precio real de fundador,
// en vez de una frase aparte explicando el precio de otros clientes.
function standardAnnualPricing(tier){ return annualPricingFor(STANDARD_PRICES[tier]); }

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

(function fetchLiveTierConfig(){
  const SUPABASE_URL = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_dMe9-l4q9RvLgdUFRY3gWA_iIMilsXX';
  // tier_config_effective: mismos campos que tier_config, pero ya devuelve el
  // precio de una oferta por tiempo si hay una activa hoy (pricing_offers) —
  // se revierte sola al precio real al terminar la oferta, sin tocar nada aquí.
  fetch(SUPABASE_URL + '/rest/v1/tier_config_effective?select=tier,founder_price_eur,standard_price_eur', {
    headers: { apikey: SUPABASE_ANON_KEY }
  })
    .then(r => r.ok ? r.json() : null)
    .then(rows => {
      if (!Array.isArray(rows) || !rows.length) return;
      rows.forEach(row => {
        if (!(row.tier in FOUNDING_PRICES)) return;
        FOUNDING_PRICES[row.tier] = Number(row.founder_price_eur);
        STANDARD_PRICES[row.tier] = Number(row.standard_price_eur);
      });
      window.onFoundingSpotsUpdated.forEach(fn => { try { fn(); } catch (e) {} });
    })
    .catch(() => {}); // tabla aún no migrada o Supabase caído: se queda con los valores de fallback, no rompe nada.
})();
