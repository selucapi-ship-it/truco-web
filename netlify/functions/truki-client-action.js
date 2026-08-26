// Founder-exclusiva: acciones sobre UNA empresa de TruKi desde el panel,
// sin entrar a su sesión ni depender de que tenga un admin disponible:
// suspender/reactivar a todo el equipo de golpe, banear/desbanear o
// ascender/degradar a un usuario concreto, cambiarle sus permisos, aceptar
// el RGPD en su nombre, editar los datos fiscales de la empresa, o
// eliminarla por completo. Mismo mecanismo de baneo que ya usa
// truki-team-manage.js en la app cliente (auth.users.banned_until), solo
// que aquí no hace falta ser admin de esa empresa para disparar la acción.

const ACCIONES_VALIDAS = [
  'suspender', 'reactivar', 'aceptar_dpa_manual',
  'banear_usuario', 'desbanear_usuario', 'hacer_admin', 'quitar_admin', 'set_permiso',
  'editar_empresa', 'eliminar_empresa'
];
const PERMISOS_VALIDOS = ['puede_emitir_facturas', 'puede_anular_facturas', 'puede_emitir_gastos', 'puede_borrar_gastos', 'puede_generar_informes'];
const CAMPOS_EMPRESA_EDITABLES = ['nombre', 'nif', 'direccion', 'codigo_postal', 'localidad', 'provincia', 'web', 'email_empresa', 'email_informes', 'iva_default', 'precio_hora_mano_obra', 'serie_factura', 'serie_presupuesto'];
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

    if (accion === 'editar_empresa') {
      const cambios = {};
      for (const campo of CAMPOS_EMPRESA_EDITABLES) {
        if (payload.campos && Object.prototype.hasOwnProperty.call(payload.campos, campo)) {
          cambios[campo] = payload.campos[campo];
        }
      }
      if (!Object.keys(cambios).length) return { statusCode: 400, body: JSON.stringify({ error: 'Sin cambios' }) };
      cambios.updated_at = new Date().toISOString();
      const resp = await fetch(`${trukiUrl}/rest/v1/truki_empresa?id=eq.${encodeURIComponent(clientId)}`, {
        method: 'PATCH',
        headers: { ...trukiHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify(cambios)
      });
      if (!resp.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    if (accion === 'eliminar_empresa') {
      const resp = await fetch(`${trukiUrl}/rest/v1/truki_empresa?id=eq.${encodeURIComponent(clientId)}`, {
        method: 'DELETE',
        headers: { ...trukiHeaders, Prefer: 'return=minimal' }
      });
      if (!resp.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error', detalle: await resp.text() }) };
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    if (['banear_usuario', 'desbanear_usuario', 'hacer_admin', 'quitar_admin', 'set_permiso'].includes(accion)) {
      const userId = payload.user_id ? String(payload.user_id) : '';
      if (!userId) return { statusCode: 400, body: JSON.stringify({ error: 'Falta user_id' }) };

      // Mismas salvaguardas que truki-team-manage.js: no dejar una empresa sin ningún admin.
      const miembrosResp = await fetch(
        `${trukiUrl}/rest/v1/truki_client_members?client_id=eq.${encodeURIComponent(clientId)}&select=user_id,rol`,
        { headers: trukiHeaders }
      );
      if (!miembrosResp.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
      const miembrosEmpresa = await miembrosResp.json();
      const objetivo = miembrosEmpresa.find(m => m.user_id === userId);
      if (!objetivo) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'usuario_no_es_de_esta_empresa' }) };
      const admins = miembrosEmpresa.filter(m => m.rol === 'admin');
      if ((accion === 'quitar_admin' || accion === 'banear_usuario') && objetivo.rol === 'admin' && admins.length <= 1) {
        return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'ultimo_admin' }) };
      }

      if (accion === 'banear_usuario' || accion === 'desbanear_usuario') {
        const resp = await fetch(`${trukiUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
          method: 'PUT',
          headers: trukiHeaders,
          body: JSON.stringify({ ban_duration: accion === 'banear_usuario' ? BAN_LARGO : 'none' })
        });
        if (!resp.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (accion === 'hacer_admin' || accion === 'quitar_admin') {
        const resp = await fetch(`${trukiUrl}/rest/v1/truki_client_members?client_id=eq.${encodeURIComponent(clientId)}&user_id=eq.${encodeURIComponent(userId)}`, {
          method: 'PATCH',
          headers: { ...trukiHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ rol: accion === 'hacer_admin' ? 'admin' : 'trabajador' })
        });
        if (!resp.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }

      if (accion === 'set_permiso') {
        const permiso = payload.permiso;
        if (!PERMISOS_VALIDOS.includes(permiso)) return { statusCode: 400, body: JSON.stringify({ error: 'Permiso inválido' }) };
        const resp = await fetch(`${trukiUrl}/rest/v1/truki_client_members?client_id=eq.${encodeURIComponent(clientId)}&user_id=eq.${encodeURIComponent(userId)}`, {
          method: 'PATCH',
          headers: { ...trukiHeaders, Prefer: 'return=minimal' },
          body: JSON.stringify({ [permiso]: !!payload.valor })
        });
        if (!resp.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }
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
