// Crea una sesión de pago de Stripe con el importe calculado por pago.html —
// pago.html sigue siendo la fuente de verdad del precio que se MUESTRA (los
// descuentos de fundador, automatizaciones adicionales, etc. viven ahí), pero
// esta función ya NO se fía a ciegas del importe que le manda el navegador:
// antes de crear la sesión, recalcula un precio MÍNIMO legítimo para el tier
// indicado (con los mismos datos en vivo de Supabase que usa pago.html) y
// rechaza el pago si el importe recibido queda claramente por debajo — así
// no se puede manipular la petición desde las herramientas de desarrollador
// para pagar, por ejemplo, 0,50€ por un plan real. Solo cubre el modo de
// pago único (el financiado con SeQura nunca llega a esta función — pago.html
// lo redirige a WhatsApp cuando plan.totalRaw es null).
//
// RELLENAR antes de que esto funcione de verdad:
//   - Variable de entorno STRIPE_SECRET_KEY en Netlify (Site settings → Environment variables).
//     Hasta que no exista, la función responde { ok:false, reason:'not_configured' } y
//     pago.html cae automáticamente al aviso de "escríbenos por WhatsApp" — no rompe nada.
//
// No hace falta crear Productos ni Precios en el panel de Stripe: el importe se
// construye al vuelo con price_data, así que un cambio de precio en pago.html
// no requiere tocar nada en Stripe.

// Misma URL/clave pública (anon/publishable — segura de tener aquí, protegida
// por RLS) que ya usa chat-ai.js para leer estos mismos precios en vivo.
const SUPABASE_URL = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_dMe9-l4q9RvLgdUFRY3gWA_iIMilsXX';
const PERMANENCIA_MESES = 12; // igual para los 4 tiers, ver ARRANQUES en pago.html

// Reconstruye el precio mínimo legítimo de un pago único para el tier dado:
// misma fórmula que getActivePlan() en pago.html (12 meses × mensualidad,
// -12% por pago único, + extras del catálogo, + IVA).
//
// ⚠️ El precio de fundador es MÁS BAJO que el estándar — así que "usar
// siempre el estándar como suelo" (la primera versión de este fix) habría
// rechazado TODOS los pagos legítimos mientras quedasen plazas de fundador
// activas, que es la situación normal. Por eso aquí se comprueba de verdad
// founding_spots.spots_left: solo se usa el precio de fundador como suelo
// si realmente quedan plazas para ese tier Y el cliente lo reclama — si
// falsea "founding:true" sin plazas reales, cae al precio estándar (más
// alto), que sigue bloqueando el intento de pagar de menos.
async function precioMinimoLegitimo(arranqueTier, solutionKeys, foundingClaimed) {
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
  const [tiersResp, spotsResp, solResp] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/tier_config_effective?select=tier,founder_price_eur,standard_price_eur`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/founding_spots?select=tier,spots_left`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/solutions_catalog_effective?select=solution_key,price_eur`, { headers }),
  ]);
  if (!tiersResp.ok) return null; // si Supabase falla, no podemos validar — ver llamada más abajo
  const tiers = await tiersResp.json();
  const spots = spotsResp.ok ? await spotsResp.json() : [];
  const solutions = solResp.ok ? await solResp.json() : [];
  const tierRow = Array.isArray(tiers) ? tiers.find(t => t.tier === arranqueTier) : null;
  if (!tierRow) return null;
  const spotsLeft = Array.isArray(spots) ? (spots.find(s => s.tier === arranqueTier)?.spots_left ?? 0) : 0;
  const usaFundador = foundingClaimed && Number(spotsLeft) > 0;
  const monthly = Number(usaFundador ? tierRow.founder_price_eur : tierRow.standard_price_eur);
  if (!Number.isFinite(monthly)) return null;

  const extraTotal = (Array.isArray(solutionKeys) ? solutionKeys : []).reduce((sum, key) => {
    const sol = solutions.find(s => s.solution_key === key);
    return sum + (sol ? Number(sol.price_eur) || 0 : 0);
  }, 0);

  const totBase = monthly * PERMANENCIA_MESES;
  const tras12pct = Math.round(totBase * 0.88 * 100) / 100;
  const baseImponible = tras12pct + extraTotal;
  const iva = baseImponible * 0.21;
  return baseImponible + iva;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const name = payload.name ? String(payload.name).slice(0, 250) : null;
  const description = payload.description ? String(payload.description).slice(0, 500) : undefined;
  const amountCents = Math.round(Number(payload.amountCents));
  const customerEmail = payload.customerEmail ? String(payload.customerEmail).slice(0, 200) : undefined;
  const planKey = payload.planKey ? String(payload.planKey).slice(0, 100) : '';
  const arranqueTier = payload.arranqueTier ? String(payload.arranqueTier).slice(0, 20) : '';
  const founding = payload.founding === true;
  const solutions = Array.isArray(payload.solutions) ? payload.solutions : [];
  const refCode = payload.refCode ? String(payload.refCode).slice(0, 20) : '';
  const consumeReferralCredit = payload.consumeReferralCredit ? String(payload.consumeReferralCredit).slice(0, 100) : '';

  // Stripe exige un mínimo de 0,50€ en EUR y un importe entero en céntimos.
  if (!name || !Number.isFinite(amountCents) || amountCents < 50) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Datos de pago incompletos' }) };
  }

  // Antes de cobrar, se comprueba que el importe no sea sospechosamente bajo
  // para el tier indicado — evita que alguien manipule la petición desde las
  // herramientas de desarrollador del navegador para pagar menos del precio
  // real. Se permite un margen de 2 céntimos por redondeos de coma flotante.
  // Si Supabase no responde, se deja pasar el pago en vez de bloquear a
  // clientes reales por una caída puntual — el objetivo es cerrar el fraude
  // fácil, no exigir disponibilidad perfecta de un tercero para poder cobrar.
  if (arranqueTier) {
    try {
      const minimo = await precioMinimoLegitimo(arranqueTier, solutions, founding);
      if (minimo !== null && amountCents < Math.round(minimo * 100) - 2) {
        console.error(`create-checkout: importe sospechoso — recibido ${amountCents}c, mínimo esperado ${Math.round(minimo * 100)}c, tier ${arranqueTier}`);
        return { statusCode: 400, body: JSON.stringify({ error: 'El importe no coincide con el precio real del plan' }) };
      }
    } catch (e) {
      console.error('create-checkout: fallo al validar el precio mínimo, se deja pasar el pago:', e.message);
    }
  }

  const origin = (event.headers.origin) || ('https://' + event.headers.host);

  try {
    const Stripe = require('stripe');
    const stripe = Stripe(secretKey);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: amountCents,
            product_data: {
              name: name,
              description: description,
            },
          },
          quantity: 1,
        },
      ],
      customer_email: customerEmail,
      success_url: origin + '/bienvenida.html?plan=' + encodeURIComponent(planKey) + '&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: origin + '/pago.html?cancelado=1',
      metadata: {
        plan_key: planKey,
        arranque_tier: arranqueTier,
        founding: founding ? 'true' : 'false',
        source: 'checkout',
        solutions: JSON.stringify(solutions).slice(0, 500),
        ref_code: refCode,
        consume_referral_credit: consumeReferralCredit,
      },
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, url: session.url }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'stripe_error', message: err.message }) };
  }
};
