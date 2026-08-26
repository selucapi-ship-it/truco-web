// Founder-exclusiva: detalle real de UNA empresa de TruKi, a demanda (clic en
// la lista del panel) — no se carga en el resumen general para no disparar
// el tamaño de esa respuesta. Mismo proyecto Supabase compartido de TruKi
// que truki-overview.js, mismo patrón de verificación founder-only.

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const trukiUrl = process.env.TRUKI_SUPABASE_URL;
  const trukiKey = process.env.TRUKI_SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey || !trukiUrl || !trukiKey) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  const clientId = (event.queryStringParameters || {}).client_id;
  if (!clientId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta client_id' }) };
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

  const trukiHeaders = { 'Content-Type': 'application/json', apikey: trukiKey };
  if (!trukiKey.startsWith('sb_secret_') && !trukiKey.startsWith('sb_publishable_')) {
    trukiHeaders.Authorization = `Bearer ${trukiKey}`;
  }

  try {
    const cid = encodeURIComponent(clientId);
    const [empresaResp, miembrosResp, facturasResp, eventosResp, usersResp] = await Promise.all([
      fetch(`${trukiUrl}/rest/v1/truki_empresa?id=eq.${cid}&select=*`, { headers: trukiHeaders }),
      fetch(`${trukiUrl}/rest/v1/truki_client_members?client_id=eq.${cid}&select=user_id,rol,nombre_completo,puede_emitir_facturas,puede_anular_facturas,puede_emitir_gastos,puede_borrar_gastos,puede_generar_informes`, { headers: trukiHeaders }),
      fetch(`${trukiUrl}/rest/v1/truki_invoices?client_id=eq.${cid}&select=id,tipo,serie,numero,fecha,cliente_nombre,total,estado,estado_cobro,creado_en&order=creado_en.desc&limit=30`, { headers: trukiHeaders }),
      fetch(`${trukiUrl}/rest/v1/truki_events?client_id=eq.${cid}&select=tipo_evento,actor_email,detalle,creado_en&order=creado_en.desc&limit=20`, { headers: trukiHeaders }),
      fetch(`${trukiUrl}/auth/v1/admin/users?per_page=1000`, { headers: trukiHeaders })
    ]);
    if (!empresaResp.ok || !miembrosResp.ok || !facturasResp.ok || !eventosResp.ok || !usersResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    }

    const empresaRows = await empresaResp.json();
    const empresa = empresaRows[0];
    if (!empresa) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'empresa_no_encontrada' }) };
    }
    const miembros = await miembrosResp.json();
    const facturas = await facturasResp.json();
    const eventos = await eventosResp.json();
    const usersData = await usersResp.json();
    const users = Array.isArray(usersData) ? usersData : (usersData.users || []);
    const userPorId = new Map(users.map(u => [u.id, u]));
    const ahora = Date.now();

    const equipo = miembros.map(m => {
      const u = userPorId.get(m.user_id);
      const activo = !u || !u.banned_until || new Date(u.banned_until).getTime() <= ahora;
      return {
        user_id: m.user_id,
        email: u ? u.email : '(usuario borrado)',
        nombre_completo: m.nombre_completo,
        rol: m.rol,
        activo,
        puede_emitir_facturas: m.puede_emitir_facturas,
        puede_anular_facturas: m.puede_anular_facturas,
        puede_emitir_gastos: m.puede_emitir_gastos,
        puede_borrar_gastos: m.puede_borrar_gastos,
        puede_generar_informes: m.puede_generar_informes
      };
    });
    const suspendida = equipo.length > 0 && equipo.every(m => !m.activo);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        empresa,
        suspendida,
        equipo,
        facturas,
        eventos
      })
    };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception' }) };
  }
};
