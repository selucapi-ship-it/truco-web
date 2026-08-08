// Crea una sesión de pago de Stripe con el importe ya calculado por pago.html
// (pago.html es la única fuente de verdad del precio — esta función nunca
// recalcula nada, solo cobra el importe que le llega).
//
// RELLENAR antes de que esto funcione de verdad:
//   - Variable de entorno STRIPE_SECRET_KEY en Netlify (Site settings → Environment variables).
//     Hasta que no exista, la función responde { ok:false, reason:'not_configured' } y
//     pago.html cae automáticamente al aviso de "escríbenos por WhatsApp" — no rompe nada.
//
// No hace falta crear Productos ni Precios en el panel de Stripe: el importe se
// construye al vuelo con price_data, así que un cambio de precio en pago.html
// no requiere tocar nada en Stripe.

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
  const solutions = Array.isArray(payload.solutions) ? payload.solutions : [];
  const refCode = payload.refCode ? String(payload.refCode).slice(0, 20) : '';
  const consumeReferralCredit = payload.consumeReferralCredit ? String(payload.consumeReferralCredit).slice(0, 100) : '';

  // Stripe exige un mínimo de 0,50€ en EUR y un importe entero en céntimos.
  if (!name || !Number.isFinite(amountCents) || amountCents < 50) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Datos de pago incompletos' }) };
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
