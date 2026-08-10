// ── OFERTA DE FUNDADOR — Lite™ y Pro™ ──
// Elemental™ y Basic™ se quedan FUERA de este sistema a propósito — precio plano, sin descuento
// de fundador ni contador de plazas (sus precios flat viven en ARRANQUES dentro de pago.html).
// Cambia SOLO los números de abajo cada vez que firmes un cliente fundador nuevo (resta 1 al tier correspondiente).
// Cada tier empieza en 10 (20 plazas en total, 10 Lite + 10 Pro, independientes entre sí).
// Cuando el contador de un tier llegue a 0, la oferta desaparece sola PARA ESE TIER en TODAS las páginas
// (index.html, servicios.html, pago.html, departamentos/lite.html, departamentos/pro.html)
// y se queda su precio estándar (279€ Lite / 549€ Pro) sin que tengas que tocar nada más.
const FOUNDING_SPOTS_LEFT = { lite: 10, pro: 10 };

// Precios — no tocar salvo que cambie la estrategia de precios en general.
const FOUNDING_PRICES = { lite: 229, pro: 449 };
const STANDARD_PRICES = { lite: 279, pro: 549 };

function foundingActive(tier){ return FOUNDING_SPOTS_LEFT[tier] > 0; }
function currentPrice(tier){ return foundingActive(tier) ? FOUNDING_PRICES[tier] : STANDARD_PRICES[tier]; }
