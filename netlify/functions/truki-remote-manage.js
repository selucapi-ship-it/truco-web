// Suspende o reactiva de golpe a TODOS los usuarios de una instancia de
// TruKi de un cliente, sin tener que entrar a su Supabase — pensado para
// cortar el acceso de inmediato ante un impago, y para reactivarlo si se
// regulariza. Founder-exclusiva.
//
// No toca la base de datos del cliente directamente: llama a la propia
// Function truki-team-manage.js de esa instancia (una acción nueva,
// suspender_todos/reactivar_todos), autenticada con el master_secret que se
// generó al registrar la instancia — el mismo mecanismo servidor-a-servidor
// que ya usa truki-usage-intake.js, en la dirección contraria.
//
// RELLENAR antes de que esto funcione de verdad:
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ya las necesita save-lead.js)

const ACCIONES = { suspender: 'suspender_todos', reactivar: 'reactivar_todos' };

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  const headers = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }

  // Founder-exclusiva: mismo patrón de verificación que invite-client.js
  // (sesión real + staff_roles.role='founder', no basta con estar logueado).
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

  const instanceId = payload.instance_id ? String(payload.instance_id) : '';
  const accion = ACCIONES[payload.accion];
  if (!instanceId || !accion) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta instance_id o accion inválida' }) };
  }

  try {
    const instResp = await fetch(
      `${supabaseUrl}/rest/v1/truki_instances?id=eq.${encodeURIComponent(instanceId)}&select=id,netlify_site_url,master_secret`,
      { headers }
    );
    if (!instResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    }
    const rows = await instResp.json();
    const instancia = rows[0];
    if (!instancia || !instancia.netlify_site_url) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'instancia_no_encontrada' }) };
    }

    const remoteResp = await fetch(`${instancia.netlify_site_url}/.netlify/functions/truki-team-manage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Truki-Master-Secret': instancia.master_secret
      },
      body: JSON.stringify({ accion: payload.accion === 'suspender' ? 'suspender_todos' : 'reactivar_todos' })
    });
    const remoteData = await remoteResp.json().catch(() => ({}));
    if (!remoteResp.ok || !remoteData.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'instancia_error', detalle: remoteData.reason || remoteResp.status }) };
    }

    const nuevoEstado = payload.accion === 'suspender' ? 'suspended' : 'active';
    const updateResp = await fetch(`${supabaseUrl}/rest/v1/truki_instances?id=eq.${encodeURIComponent(instanceId)}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ status: nuevoEstado, updated_at: new Date().toISOString() })
    });
    if (!updateResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, status: nuevoEstado }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception' }) };
  }
};
