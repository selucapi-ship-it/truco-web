// Captura una orden de PayPal tras que el comprador vuelva de aprobarla en
// paypal.com (llamada por paypal-return.html con ?order_id=... en cuanto
// carga) y hace exactamente lo mismo que stripe-webhook.js hace para
// Stripe: alta/actualización del cliente en el CRM, ledger de pago, plazas
// de fundador, programa de referidos e invitación automática al portal.
//
// A diferencia de Stripe (que confirma vía webhook asíncrono aparte), aquí
// todo pasa síncronamente en la propia vuelta del comprador: se captura el
// pago y, si sale bien, se hacen todos los efectos antes de decirle a
// paypal-return.html a qué página redirigir — más simple y sin depender de
// que Netlify reciba un webhook por separado.
//
// RELLENAR en Netlify: mismas variables que create-paypal-order.js
// (PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_API_BASE opcional) +
// las ya existentes SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// N8N_ALTA_CLIENTE_WEBHOOK_URL, INVITE_CLIENT_INTERNAL_SECRET.

const ARRANQUE_PERMANENCIA_MESES = { start: 12, basic: 12, lite: 12, pro: 12 };

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
  return { plan_type: 'proyecto', arranque_tier: null, permanencia_meses: null, gift_period_days: 30 };
}

function supabaseHeaders(serviceKey) {
  const h = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    h.Authorization = `Bearer ${serviceKey}`;
  }
  return h;
}

async function obtenerTokenPaypal(apiBase, clientId, secret) {
  const resp = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.access_token || null;
}

exports.handler = async function (event) {
  const orderId = (event.queryStringParameters || {}).order_id;
  if (!orderId) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, reason: 'missing_order_id' }) };
  }

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  const apiBase = process.env.PAYPAL_API_BASE || 'https://api-m.paypal.com';
  const supabaseUrl = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!clientId || !secret || !supabaseUrl || !serviceKey) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  try {
    // Recupera lo que create-paypal-order.js guardó al crear esta orden —
    // sin esto no sabemos a qué plan/cliente corresponde el pago.
    const pendingResp = await fetch(
      `${supabaseUrl}/rest/v1/paypal_pending_orders?order_id=eq.${encodeURIComponent(orderId)}&select=payload`,
      { headers: supabaseHeaders(serviceKey) }
    );
    const pendingRows = pendingResp.ok ? await pendingResp.json() : [];
    const pending = pendingRows[0];
    if (!pending) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'unknown_order' }) };
    }
    const info = pending.payload || {};

    const token = await obtenerTokenPaypal(apiBase, clientId, secret);
    if (!token) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'paypal_auth_error' }) };
    }

    const captureResp = await fetch(`${apiBase}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const captureData = await captureResp.json().catch(() => ({}));
    if (!captureResp.ok || captureData.status !== 'COMPLETED') {
      console.error('[PAYPAL] captura fallida', captureResp.status, JSON.stringify(captureData));
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'capture_failed' }) };
    }

    const captureId = captureData?.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;
    const email = info.email;
    const nombre = info.nombre || null;
    const planKey = info.planKey || '';
    const arranqueTier = info.arranqueTier || '';
    const isFounding = !!info.founding;
    const solutions = Array.isArray(info.solutions) ? info.solutions : [];
    const refCode = info.refCode || '';
    const consumeReferralCreditFor = info.consumeReferralCredit || '';
    const amountTotalCents = Number(info.amountTotalCents) || null;

    let clientId2 = null;
    if (email) {
      const shape = planShape(planKey, arranqueTier);
      const headers = supabaseHeaders(serviceKey);
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
            p_is_founder: isFounding,
            p_amount_total_cents: amountTotalCents,
            p_paypal_order_id: orderId,
            p_paypal_capture_id: captureId,
          }),
        });
        if (resp.ok) {
          const rows = await resp.json();
          clientId2 = Array.isArray(rows) ? rows[0] : rows;
        }
      } catch (e) { /* el pago ya está cobrado; esto solo actualiza el CRM */ }

      if (isFounding && ['lite', 'pro', 'start', 'basic'].includes(arranqueTier)) {
        try {
          await fetch(`${supabaseUrl}/rest/v1/rpc/decrement_founding_spot`, {
            method: 'POST', headers, body: JSON.stringify({ p_tier: arranqueTier }),
          });
        } catch (e) { /* ajustable a mano si falla */ }
      }

      if (refCode) {
        try {
          await fetch(`${supabaseUrl}/rest/v1/rpc/reward_referral`, {
            method: 'POST', headers, body: JSON.stringify({ p_ref_code: refCode }),
          });
        } catch (e) { /* ajustable a mano si falla */ }
      }
      if (consumeReferralCreditFor) {
        try {
          await fetch(`${supabaseUrl}/rest/v1/rpc/consume_referral_credit`, {
            method: 'POST', headers, body: JSON.stringify({ p_client_id: consumeReferralCreditFor }),
          });
        } catch (e) { /* ajustable a mano si falla */ }
      }

      if (clientId2) {
        try {
          const inviteHeaders = { 'Content-Type': 'application/json' };
          if (process.env.INVITE_CLIENT_INTERNAL_SECRET) {
            inviteHeaders['X-Internal-Secret'] = process.env.INVITE_CLIENT_INTERNAL_SECRET;
          }
          await fetch('https://trucotechnology.com/.netlify/functions/invite-client', {
            method: 'POST', headers: inviteHeaders, body: JSON.stringify({ email, client_id: clientId2 }),
          });
        } catch (e) { /* invitable a mano desde el panel si falla */ }
      }
    }

    const n8nUrl = process.env.N8N_ALTA_CLIENTE_WEBHOOK_URL;
    if (n8nUrl) {
      try {
        await fetch(n8nUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: clientId2, email, nombre, plan_key: planKey,
            arranque_tier: arranqueTier || null, amount_total: amountTotalCents, order_id: orderId,
          }),
        });
      } catch (e) { /* no bloquear la confirmación por esto */ }
    }

    // Limpieza — el pago ya quedó registrado en "payments", esta fila
    // temporal ya no hace falta.
    try {
      await fetch(`${supabaseUrl}/rest/v1/paypal_pending_orders?order_id=eq.${encodeURIComponent(orderId)}`, {
        method: 'DELETE', headers: supabaseHeaders(serviceKey),
      });
    } catch (e) { /* no crítico */ }

    return { statusCode: 200, body: JSON.stringify({ ok: true, url: '/bienvenida.html?plan=' + encodeURIComponent(planKey) }) };
  } catch (err) {
    console.error('[PAYPAL] excepción en capture', err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception', message: err.message }) };
  }
};
