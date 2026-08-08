// Crea el login del portal para un cliente que ya existe en la tabla
// `clients`: invita el email vía Supabase Auth y enlaza el usuario resultante
// a su ficha (clients.auth_user_id). Llamada por:
//   - stripe-webhook.js, automáticamente, justo después de confirmar un pago.
//   - un botón "Invitar al portal" en admin/panel.html, para altas manuales
//     que no pasaron por Stripe.
//
// RELLENAR antes de que esto funcione de verdad:
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ya las necesita save-lead.js)
//
// Nota importante, sin verificar en vivo: este proyecto usa las claves nuevas
// de Supabase (sb_secret_...), y no hay certeza total de que el endpoint
// /auth/v1/invite de GoTrue las acepte exactamente igual que las claves JWT
// clásicas (service_role tradicional). Mientras no se confirme contra un
// proyecto real, si esta función falla usa el respaldo manual: Supabase
// Dashboard → Authentication → Users → Invite user, y luego pega el
// auth_user_id resultante a mano en la ficha del cliente desde admin/panel.html
// (o directamente en la tabla).

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const email = payload.email ? String(payload.email).trim().slice(0, 200) : '';
  const clientId = payload.client_id ? String(payload.client_id).slice(0, 100) : '';
  if (!email || !clientId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta email o client_id' }) };
  }

  // Mismo patrón condicional que save-lead.js: las claves nuevas (sb_secret_...)
  // solo van en "apikey" — si además se manda en "Authorization: Bearer", la
  // plataforma la intenta leer como JWT y falla con "Invalid JWT". Las claves
  // antiguas (un JWT eyJ...) sí necesitan ambos headers.
  const headers = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }

  const origin = event.headers.origin || 'https://' + event.headers.host;

  try {
    const inviteResp = await fetch(`${supabaseUrl}/auth/v1/invite`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email,
        options: { redirect_to: origin + '/portal/activar.html' },
      }),
    });

    // 422/400 con "already been registered" no es un fallo real — el cliente
    // ya tiene login de algún alta anterior; seguimos e intentamos enlazarlo.
    let authUserId = null;
    if (inviteResp.ok) {
      const inviteData = await inviteResp.json();
      authUserId = inviteData && inviteData.id ? inviteData.id : null;
    } else if (inviteResp.status !== 422 && inviteResp.status !== 400) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'invite_failed', status: inviteResp.status }) };
    }

    if (!authUserId) {
      // El usuario ya existía — lo buscamos por email para poder enlazarlo igualmente.
      const lookupResp = await fetch(`${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
        method: 'GET',
        headers,
      });
      if (lookupResp.ok) {
        const lookupData = await lookupResp.json();
        const users = Array.isArray(lookupData) ? lookupData : (lookupData.users || []);
        authUserId = users[0] ? users[0].id : null;
      }
    }

    if (!authUserId) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'no_auth_user_found' }) };
    }

    const patchResp = await fetch(`${supabaseUrl}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ auth_user_id: authUserId }),
    });
    if (!patchResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'link_failed' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, auth_user_id: authUserId }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception' }) };
  }
};
