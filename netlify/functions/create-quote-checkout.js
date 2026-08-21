// Genera un enlace de pago de Stripe para un presupuesto ya aceptado —
// founder-exclusiva. Reutiliza exactamente el mismo mecanismo que
// create-checkout.js (price_data/unit_amount calculado al vuelo, sin Price
// IDs de Stripe), solo que el importe lo decide el founder desde el
// presupuesto en vez de que lo calcule pago.html, y la metadata identifica el
// presupuesto en vez de un plan_key/tier — así stripe-webhook.js sabe tratarlo
// distinto (marcar el presupuesto como pagado en vez de aplicar la lógica de
// Departamentos).
//
// RELLENAR antes de que esto funcione de verdad:
//   - STRIPE_SECRET_KEY (ya la necesita create-checkout.js)
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ya las necesita save-lead.js)

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!stripeSecret || !supabaseUrl || !serviceKey) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  const headers = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }

  // Founder-exclusiva: mismo patrón que truki-remote-manage.js / invite-client.js.
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
            authorized = Array.isArray(roleRows) && roleRows.some(r => r.role === 'founder');
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

  const quoteId = payload.quote_id ? String(payload.quote_id) : '';
  if (!quoteId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta quote_id' }) };
  }

  try {
    const quoteResp = await fetch(`${supabaseUrl}/rest/v1/quotes?id=eq.${encodeURIComponent(quoteId)}&select=*`, { headers });
    if (!quoteResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    }
    const rows = await quoteResp.json();
    const quote = rows[0];
    if (!quote) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'presupuesto_no_encontrado' }) };
    }

    // El founder puede ajustar el importe justo antes de generar el enlace
    // (ej. redondear, aplicar un pequeño descuento de cierre) sin tener que
    // reeditar las líneas del presupuesto.
    const amountCents = Math.round(Number(payload.amount_cents_override ?? quote.total_estimado * 100));
    if (!Number.isFinite(amountCents) || amountCents < 50) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Importe inválido' }) };
    }

    const origin = event.headers.origin || 'https://' + event.headers.host;
    const Stripe = require('stripe');
    const stripe = Stripe(stripeSecret);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: amountCents,
          product_data: {
            name: 'Presupuesto TRUCO — ' + (quote.negocio || quote.nombre_contacto || 'servicio contratado'),
            description: (quote.lineas || []).map(l => l.descripcion).filter(Boolean).slice(0, 5).join(', ').slice(0, 500) || undefined,
          },
        },
        quantity: 1,
      }],
      customer_email: quote.email_contacto || undefined,
      success_url: origin + '/bienvenida.html?presupuesto=' + encodeURIComponent(quoteId) + '&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: origin + '/pago.html?cancelado=1',
      metadata: {
        source: 'custom_quote',
        quote_id: quoteId,
      },
    });

    await fetch(`${supabaseUrl}/rest/v1/quotes?id=eq.${encodeURIComponent(quoteId)}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ stripe_checkout_url: session.url, updated_at: new Date().toISOString() }),
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, url: session.url }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'stripe_error', message: err.message }) };
  }
};
