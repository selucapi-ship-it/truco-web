// Founder/equipo-exclusiva: lista los pedidos pendientes de transferencia
// bancaria para el panel de admin. bank_transfer_orders tiene RLS activado
// sin ninguna política (igual que paypal_pending_orders) — nadie con la
// clave pública puede leerla directamente, así que el panel necesita esta
// Function con la service_role para verla.

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }
  const headers = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }

  // Mismo patrón de verificación que confirm-bank-transfer.js/truki-set-declaracion.js.
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

  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/bank_transfer_orders?order=created_at.desc&limit=50&select=*`,
      { headers }
    );
    if (!resp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'query_failed' }) };
    }
    const rows = await resp.json();
    return { statusCode: 200, body: JSON.stringify({ ok: true, orders: rows }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception', message: err.message }) };
  }
};
