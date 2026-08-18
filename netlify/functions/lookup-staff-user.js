// Busca el auth_user_id de un email para poder darlo de alta en staff_roles
// desde la sección "Equipo" de admin/panel.html (add_staff_member necesita un
// uuid, no un email, y buscarlo por email requiere la Auth Admin API, que solo
// funciona con la service_role key — por eso hace falta esta función en vez de
// que el panel llame a Supabase directamente).
//
// Nunca confía en quién dice ser el que llama: verifica el token de sesión
// contra Supabase (mismo patrón que portal-chat.js) y comprueba que ese
// usuario está en staff_roles con role 'founder' antes de devolver nada — así
// esta función no se convierte en una forma de enumerar usuarios del sistema
// para cualquiera con una sesión válida.
//
// RELLENAR antes de que esto funcione de verdad:
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ya las necesita save-lead.js)

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const userToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!userToken) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Falta sesión' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const email = payload.email ? String(payload.email).trim().slice(0, 200) : '';
  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta email' }) };
  }

  const serviceHeaders = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    serviceHeaders.Authorization = `Bearer ${serviceKey}`;
  }

  try {
    // 1. Verificar que el token de sesión es válido y de quién es.
    const verifyResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${userToken}` },
    });
    if (!verifyResp.ok) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Sesión inválida' }) };
    }
    const authUser = await verifyResp.json();
    const callerId = authUser && authUser.id;
    if (!callerId) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Sesión inválida' }) };
    }

    // 2. Confirmar que quien llama es founder (no basta con admin/support: dar
    //    de alta personal es una acción exclusiva del founder, igual que
    //    add_staff_member la restringe en SQL — esta función es solo el paso
    //    previo de búsqueda, pero no tiene sentido dejarla más abierta que la
    //    propia función que la consume).
    const roleResp = await fetch(
      `${supabaseUrl}/rest/v1/staff_roles?user_id=eq.${encodeURIComponent(callerId)}&select=role`,
      { headers: serviceHeaders }
    );
    if (!roleResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'role_check_failed' }) };
    }
    const roleRows = await roleResp.json();
    const isFounder = Array.isArray(roleRows) && roleRows.some(r => r.role === 'founder');
    if (!isFounder) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Solo el founder puede buscar usuarios para el equipo' }) };
    }

    // 3. Buscar el email objetivo en Auth.
    const lookupResp = await fetch(`${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
      method: 'GET',
      headers: serviceHeaders,
    });
    if (!lookupResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'lookup_failed' }) };
    }
    const lookupData = await lookupResp.json();
    const users = Array.isArray(lookupData) ? lookupData : (lookupData.users || []);
    const foundUserId = users[0] ? users[0].id : null;

    if (!foundUserId) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'no_user_found' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, user_id: foundUserId }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception' }) };
  }
};
