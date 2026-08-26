// Founder-exclusiva: acciones sobre UNA empresa de TruKi desde el panel,
// sin entrar a su sesión — suspender/reactivar a todo su equipo de golpe
// (banea/desbanea cada auth.users de esa empresa, el mismo mecanismo que ya
// usa truki-team-manage.js para un solo usuario, aplicado a todos los suyos),
// o aceptar su RGPD/DPA en su nombre cuando su admin no está disponible y
// deja a todo el equipo bloqueado en esa pantalla sin ninguna salida dentro
// de la app cliente.

const ACCIONES_VALIDAS = ['suspender', 'reactivar', 'aceptar_dpa_manual'];
const BAN_LARGO = '876000h'; // ~100 años, mismo valor que truki-team-manage.js

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
  let founderEmail = null;
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
            if (Array.isArray(roleRows) && roleRows.some(r => r.role === 'founder')) {
              founderEmail = authUser.email || 'founder';
            }
          }
        }
      }
    } catch (e) {
      // founderEmail se queda null
    }
  }
  if (!founderEmail) {
    return { statusCode: 403, body: JSON.stringify({ error: 'No autorizado' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const clientId = payload.client_id ? String(payload.client_id) : '';
  const accion = payload.accion;
  if (!clientId || !ACCIONES_VALIDAS.includes(accion)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta client_id o accion inválida' }) };
  }

  const trukiHeaders = { 'Content-Type': 'application/json', apikey: trukiKey };
  if (!trukiKey.startsWith('sb_secret_') && !trukiKey.startsWith('sb_publishable_')) {
    trukiHeaders.Authorization = `Bearer ${trukiKey}`;
  }

  try {
    if (accion === 'aceptar_dpa_manual') {
      const resp = await fetch(`${trukiUrl}/rest/v1/truki_empresa?id=eq.${encodeURIComponent(clientId)}`, {
        method: 'PATCH',
        headers: { ...trukiHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({
          dpa_aceptado_en: new Date().toISOString(),
          dpa_aceptado_por: `${founderEmail} (vía panel, admin no disponible)`,
          updated_at: new Date().toISOString()
        })
      });
      if (!resp.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // suspender / reactivar: banear o desbanear a todos los miembros de la empresa
    const miembrosResp = await fetch(
      `${trukiUrl}/rest/v1/truki_client_members?client_id=eq.${encodeURIComponent(clientId)}&select=user_id`,
      { headers: trukiHeaders }
    );
    if (!miembrosResp.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    const miembros = await miembrosResp.json();
    if (!miembros.length) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'sin_miembros' }) };

    const banDuration = accion === 'suspender' ? BAN_LARGO : 'none';
    const resultados = await Promise.all(miembros.map(m =>
      fetch(`${trukiUrl}/auth/v1/admin/users/${encodeURIComponent(m.user_id)}`, {
        method: 'PUT',
        headers: trukiHeaders,
        body: JSON.stringify({ ban_duration: banDuration })
      })
    ));
    const fallos = resultados.filter(r => !r.ok).length;
    if (fallos === resultados.length) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, actualizados: resultados.length - fallos, fallos }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception' }) };
  }
};
