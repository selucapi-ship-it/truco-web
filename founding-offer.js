// ── OFERTA DE FUNDADOR — Lite™ y Pro™ ──
// Cambia SOLO el número de abajo cada vez que firmes un cliente fundador nuevo.
// Empieza en 10. Cuando llegue a 0, la oferta desaparece sola en TODAS las páginas
// (index.html, servicios.html, pago.html, departamentos/lite.html, departamentos/pro.html)
// y se queda el precio estándar (279€ Lite / 549€ Pro) sin que tengas que tocar nada más.
const FOUNDING_SPOTS_LEFT = 10;

// Precios — no tocar salvo que cambie la estrategia de precios en general.
const FOUNDING_PRICES = { lite: 199, pro: 399 };
const STANDARD_PRICES = { lite: 279, pro: 549 };

function foundingActive(){ return FOUNDING_SPOTS_LEFT > 0; }
function currentPrice(tier){ return foundingActive() ? FOUNDING_PRICES[tier] : STANDARD_PRICES[tier]; }
