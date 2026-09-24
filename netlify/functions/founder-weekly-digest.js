// Expone founder_weekly_digest() (supabase/migration_growth_automation.sql) al
// panel — ese RPC solo tiene grant a service_role (pensado originalmente para
// un workflow externo de n8n que todavía no existe), así que el navegador del
// founder no puede llamarlo directo con su sesión normal. Esta función hace
// de puente: verifica que quien pregunta es founder de verdad, y solo entonces
// llama al RPC con la clave de servicio.
exports.handler = async function (event) {
  const supabaseUrl = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  const headers = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }

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

  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/founder_weekly_digest`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({}),
    });
    if (!resp.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    const digest = await resp.json();
    return { statusCode: 200, body: JSON.stringify({ ok: true, digest }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception' }) };
  }
};
