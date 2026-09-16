// Founder-exclusiva: confirma manualmente un pedido "pendiente de
// transferencia" — se llama desde el botón "Activar" del panel de admin, en
// cuanto el founder ve la transferencia entrar en su banco (BBVA no avisa
// solo al sistema, mismo motivo por el que "Cobros recurrentes" ya
// funcionaba así para la domiciliación bancaria).
//
// Replica exactamente la misma cadena de efectos que paypal-capture-order.js
// (que a su vez replica stripe-webhook.js): confirm_client_purchase(),
// plazas de fundador, programa de referidos, invitación al portal y webhook
// de n8n. Única diferencia real: aquí no hay ninguna pasarela que capturar,
// el dinero ya está en el banco del founder — esta función solo registra que
// él lo ha visto y confirmado.
//
// RELLENAR en Netlify: ya existentes, reutilizadas sin cambios —
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, INVITE_CLIENT_INTERNAL_SECRET,
// N8N_ALTA_CLIENTE_WEBHOOK_URL.

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

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }
  const headers = supabaseHeaders(serviceKey);

  // Founder-exclusiva: mismo patrón de verificación que truki-set-declaracion.js
  // (cualquier miembro del equipo con fila en staff_roles vale, no solo founder
  // — igual que el resto de acciones administrativas del panel).
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const userToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  let authorized = false;
  if (userToken) {
    try {
      const verifyResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${userToken}` }
      });
      if (verifyResp.ok) {
        const authUser = await verifyResp.json();
        if (authUser && authUser.id) {
          const roleResp = await fetch(
            `${supabaseUrl}/rest/v1/staff_roles?user_id=eq.${encodeURIComponent(authUser.id)}&select=role`,
            { headers }
          );
          if (roleResp.ok) {
            const roleRows = await roleResp.json();
            authorized = Array.isArray(roleRows) && roleRows.length > 0;
          }
        }
      }
    } catch (e) {
      // authorized se queda en false
    }
  }
  if (!authorized) {
    return { statusCode: 403, body: JSON.stringify({ error: 'No autorizado' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const referenceCode = (payload.referenceCode || '').trim();
  if (!referenceCode) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta el código de referencia' }) };
  }

  try {
    const orderResp = await fetch(
      `${supabaseUrl}/rest/v1/bank_transfer_orders?reference_code=eq.${encodeURIComponent(referenceCode)}&status=eq.pendiente&select=*`,
      { headers }
    );
    if (!orderResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'lookup_failed' }) };
    }
    const rows = await orderResp.json();
    const order = Array.isArray(rows) ? rows[0] : null;
    if (!order) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_found_or_already_confirmed' }) };
    }
    const info = order.payload || {};
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
            p_transfer_reference: referenceCode,
          }),
        });
        if (resp.ok) {
          const rowsOut = await resp.json();
          clientId2 = Array.isArray(rowsOut) ? rowsOut[0] : rowsOut;
        } else {
          console.error('[TRANSFER] confirm_client_purchase falló', resp.status, await resp.text());
        }
      } catch (e) { /* el dinero ya está en el banco; esto solo actualiza el CRM */ }

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
            arranque_tier: arranqueTier || null, amount_total: amountTotalCents, order_id: referenceCode,
          }),
        });
      } catch (e) { /* no bloquear la confirmación por esto */ }
    }

    // A diferencia de paypal_pending_orders (que se borra), aquí se conserva
    // la fila marcada como "confirmado" — es el único rastro de que esta
    // transferencia concreta llegó y quién la confirmó, útil para Fiscalidad
    // y para no volver a activarla por error dos veces.
    await fetch(`${supabaseUrl}/rest/v1/bank_transfer_orders?id=eq.${order.id}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'confirmado', confirmed_at: new Date().toISOString() }),
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, email }) };
  } catch (err) {
    console.error('[TRANSFER] excepción confirmando', err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception', message: err.message }) };
  }
};
