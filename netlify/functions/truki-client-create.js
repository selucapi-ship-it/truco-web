// Founder-exclusiva: da de alta una empresa nueva de TruKi directamente en
// el proyecto Supabase compartido, con su primer usuario admin — para no
// tener que hacerlo a mano en Supabase cada vez que entra un cliente nuevo.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const trukiUrl = process.env.TRUKI_SUPABASE_URL;
  const trukiKey = process.env.TRUKI_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey || !trukiUrl || !trukiKey) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  const mainHeaders = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    mainHeaders.Authorization = `Bearer ${serviceKey}`;
  }

  // Founder-exclusiva: mismo patrón de verificación que truki-overview.js
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
            { headers: mainHeaders }
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
  const nombre = (payload.nombre || '').trim();
  const nif = (payload.nif || '').trim();
  const emailEmpresa = (payload.email_empresa || '').trim();
  const adminEmail = (payload.admin_email || '').trim();
  const adminPassword = payload.admin_password || '';
  if (!nombre || !adminEmail || !adminPassword) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Faltan nombre, admin_email o admin_password' }) };
  }
  if (adminPassword.length < 8) {
    return { statusCode: 400, body: JSON.stringify({ error: 'La contraseña del admin debe tener al menos 8 caracteres' }) };
  }

  const trukiHeaders = { 'Content-Type': 'application/json', apikey: trukiKey };
  if (!trukiKey.startsWith('sb_secret_') && !trukiKey.startsWith('sb_publishable_')) {
    trukiHeaders.Authorization = `Bearer ${trukiKey}`;
  }

  try {
    const empresaResp = await fetch(`${trukiUrl}/rest/v1/truki_empresa`, {
      method: 'POST',
      headers: { ...trukiHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({ nombre, nif: nif || null, email_empresa: emailEmpresa || null })
    });
    if (!empresaResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error', detalle: await empresaResp.text() }) };
    }
    const empresaRows = await empresaResp.json();
    const empresa = empresaRows[0];

    const userResp = await fetch(`${trukiUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: trukiHeaders,
      body: JSON.stringify({ email: adminEmail, password: adminPassword, email_confirm: true })
    });
    const userData = await userResp.json().catch(() => ({}));
    if (!userResp.ok || !userData.id) {
      // La empresa ya se creó — no la borramos, mejor dejarla y que el founder añada el admin a mano si esto falla.
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'admin_no_creado', detalle: userData.msg || userData.error_description || 'error desconocido', empresa }) };
    }

    const miembroResp = await fetch(`${trukiUrl}/rest/v1/truki_client_members`, {
      method: 'POST',
      headers: { ...trukiHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userData.id, client_id: empresa.id, rol: 'admin' })
    });
    if (!miembroResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'miembro_no_vinculado', empresa, admin_user_id: userData.id }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, empresa }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception' }) };
  }
};
