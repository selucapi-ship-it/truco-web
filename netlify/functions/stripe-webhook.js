// Escucha la confirmación de pago de Stripe y:
//   1. Marca al cliente como 'cliente' en el CRM (Supabase), con el plan, la
//      fecha de inicio de permanencia/regalo y las soluciones concretas que
//      eligió (client_solutions) — de aquí bebe el aviso de renovación
//      automático y el portal de cliente.
//   2. Avisa al flujo de n8n "alta-cliente-nuevo" para que mande el
//      cuestionario y agende la reunión de bienvenida solo.
//   3. Invita al cliente al portal (netlify/functions/invite-client.js), para
//      que tenga su login esperándole sin que el founder tenga que hacer nada.
//
// RELLENAR antes de que esto funcione de verdad:
//   - STRIPE_SECRET_KEY (ya la necesita create-checkout.js)
//   - STRIPE_WEBHOOK_SECRET — lo da Stripe al crear el endpoint de webhook
//     (Dashboard → Developers → Webhooks → Add endpoint → apunta a esta URL,
//     evento a escuchar: checkout.session.completed).
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ya las necesita save-lead.js)
//   - N8N_ALTA_CLIENTE_WEBHOOK_URL — URL del webhook del flujo n8n
//     otros/n8n-truco/alta-cliente-nuevo.json una vez importado y activo.
//
// Mientras falte cualquiera de estas, la función no rompe nada: se limita a
// no hacer la parte que dependa de lo que falte.

// Permanencia / periodo de regalo por tipo de plan — mismos números que
// pago.html (ARRANQUES.*.permanenciaMeses y las notas de "30/90 días de
// regalo"). Si cambian ahí, cambiar aquí también.
const ARRANQUE_PERMANENCIA_MESES = { basic: 6, lite: 12, pro: 12 };
const PROYECTO_SOLO_GIFT_DAYS = 30; // web-lite / esencial-lite (proyecto sin Digitaliza)
const PROYECTO_CON_DIGITALIZA_GIFT_DAYS = 90; // cualquier combinación que incluya Digitaliza

function planShape(planKey, arranqueTier) {
  if (!planKey) return { plan_type: null, arranque_tier: null, permanencia_meses: null, gift_period_days: null };
  if (planKey.startsWith('arranque-')) {
    return {
      plan_type: 'arranque',
      arranque_tier: arranqueTier || null,
      permanencia_meses: ARRANQUE_PERMANENCIA_MESES[arranqueTier] || null,
      gift_period_days: null,
    };
  }
  const soloProyecto = planKey === 'web-lite' || planKey === 'esencial-lite';
  return {
    plan_type: 'proyecto',
    arranque_tier: null,
    permanencia_meses: null,
    gift_period_days: soloProyecto ? PROYECTO_SOLO_GIFT_DAYS : PROYECTO_CON_DIGITALIZA_GIFT_DAYS,
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeSecret || !webhookSecret) {
    // Sin esto configurado no podemos verificar que la llamada viene de
    // verdad de Stripe — respondemos 200 para que Stripe no reintente en
    // bucle, pero no procesamos nada.
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  const Stripe = require('stripe');
  const stripe = Stripe(stripeSecret);

  let stripeEvent;
  try {
    const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Firma inválida: ' + err.message }) };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: JSON.stringify({ ok: true, ignored: stripeEvent.type }) };
  }

  const session = stripeEvent.data.object;
  const email = session.customer_details ? session.customer_details.email : session.customer_email;
  const planKey = (session.metadata && session.metadata.plan_key) || '';
  const arranqueTier = (session.metadata && session.metadata.arranque_tier) || '';
  const isFounding = (session.metadata && session.metadata.founding) === 'true';
  const nombre = session.customer_details ? session.customer_details.name : null;
  let solutions = [];
  try {
    solutions = JSON.parse((session.metadata && session.metadata.solutions) || '[]');
    if (!Array.isArray(solutions)) solutions = [];
  } catch (e) {
    solutions = [];
  }
  const refCode = (session.metadata && session.metadata.ref_code) || '';
  const consumeReferralCreditFor = (session.metadata && session.metadata.consume_referral_credit) || '';

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let clientId = null;

  if (supabaseUrl && serviceKey && email) {
    const shape = planShape(planKey, arranqueTier);
    const headers = { 'Content-Type': 'application/json', apikey: serviceKey };
    if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
      headers.Authorization = `Bearer ${serviceKey}`;
    }
    try {
      const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/confirm_client_purchase`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_email: email,
          p_nombre: nombre,
          p_plan_key: planKey,
          p_plan_type: shape.plan_type,
          p_arranque_tier: shape.arranque_tier,
          p_permanencia_meses: shape.permanencia_meses,
          p_gift_period_days: shape.gift_period_days,
          p_solutions: solutions.length ? solutions : null,
        }),
      });
      if (resp.ok) {
        const rows = await resp.json();
        clientId = Array.isArray(rows) ? rows[0] : rows;
      }
    } catch (err) {
      // No bloquear la confirmación del webhook a Stripe por un fallo aquí —
      // el pago ya se ha cobrado, esto solo actualiza el CRM.
    }

    // Contador de plazas de fundador: solo baja 1 plaza cuando el pago
    // confirmado por Stripe se hizo realmente al precio de fundador (lo
    // decidió pago.html en el momento del checkout, vía metadata.founding) —
    // nunca en cada compra de Lite™/Pro™. decrement_founding_spot() ya se
    // protege sola contra bajar de 0 (ver migration_founding_spots.sql), así
    // que da igual si esto se procesa dos veces por un reintento de Stripe.
    if (isFounding && (arranqueTier === 'lite' || arranqueTier === 'pro')) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/rpc/decrement_founding_spot`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ p_tier: arranqueTier }),
        });
      } catch (err) {
        // No bloquear el webhook — en el peor caso el founder ajusta el
        // contador a mano una vez en el SQL Editor de Supabase.
      }
    }

    // Programa de referidos: si esta compra venía de un enlace de referido
    // válido, el referidor gana 1 crédito de descuento para su próxima
    // compra. Si quien compra ahora era él mismo canjeando un crédito ya
    // ganado, se le descuenta. Nunca mueve dinero real, todo vía el
    // descuento que ya aplica pago.html.
    if (refCode) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/rpc/reward_referral`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ p_ref_code: refCode }),
        });
      } catch (err) {
        // No bloquear el webhook — en el peor caso el referidor no recibe
        // su crédito y hay que dárselo a mano.
      }
    }
    if (consumeReferralCreditFor) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/rpc/consume_referral_credit`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ p_client_id: consumeReferralCreditFor }),
        });
      } catch (err) {
        // Igual: en el peor caso el crédito se queda sin consumir.
      }
    }

    // Da de alta el login del portal automáticamente, para que el cliente
    // tenga su cuenta esperándole sin que el founder tenga que hacer nada. Si
    // esto falla (ver invite-client.js — el endpoint /invite no está
    // verificado contra las claves nuevas de Supabase), no bloquea el webhook:
    // el founder puede invitar a mano desde admin/panel.html.
    if (clientId) {
      try {
        const origin = event.headers.origin || 'https://' + event.headers.host;
        await fetch(origin + '/.netlify/functions/invite-client', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, client_id: clientId }),
        });
      } catch (err) {
        // Igual: el pago y el CRM ya están bien, un fallo aquí solo significa
        // invitar al cliente a mano.
      }
    }
  }

  const n8nUrl = process.env.N8N_ALTA_CLIENTE_WEBHOOK_URL;
  if (n8nUrl) {
    try {
      await fetch(n8nUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          email,
          nombre,
          telefono: session.customer_details ? session.customer_details.phone : null,
          plan_key: planKey,
          arranque_tier: arranqueTier || null,
          amount_total: session.amount_total,
          session_id: session.id,
        }),
      });
    } catch (err) {
      // Igual: el pago ya está cobrado y el CRM ya está actualizado (si había
      // credenciales); que n8n esté caído no debe hacer fallar el webhook.
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
