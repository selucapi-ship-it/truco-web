// Founder-exclusiva: agrega en el servidor el estado real de todos los
// clientes de TruKi, leyendo directamente el proyecto Supabase COMPARTIDO de
// TruKi (uno solo para todos los clientes desde la migración multi-tenant —
// ver plantillas/06-truki-facturas/supabase/schema.sql). Sustituye al
// antiguo founder_truki_overview()/truki_instances, construidos para el
// modelo obsoleto de "un Supabase por cliente".
//
// RELLENAR en Netlify (site del panel principal) antes de que esto funcione:
//   - TRUKI_SUPABASE_URL              (la del proyecto "Truki Oficial")
//   - TRUKI_SUPABASE_SERVICE_ROLE_KEY (service_role de ese mismo proyecto)

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

  const mainHeaders = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    mainHeaders.Authorization = `Bearer ${serviceKey}`;
  }

  // Founder-exclusiva: mismo patrón de verificación que truki-remote-manage.js
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
    const [empresasResp, miembrosResp, facturasResp, eventosResp, usersResp, configResp] = await Promise.all([
      fetch(`${trukiUrl}/rest/v1/truki_empresa?select=id,nombre,nif,email_empresa,dpa_aceptado_en,dpa_aceptado_por,created_at&order=created_at.asc`, { headers: trukiHeaders }),
      fetch(`${trukiUrl}/rest/v1/truki_client_members?select=user_id,client_id,rol`, { headers: trukiHeaders }),
      fetch(`${trukiUrl}/rest/v1/truki_invoices?select=client_id,tipo,total,estado,creado_en`, { headers: trukiHeaders }),
      fetch(`${trukiUrl}/rest/v1/truki_events?tipo_evento=eq.error_cliente&select=client_id,creado_en,detalle&order=creado_en.desc&limit=500`, { headers: trukiHeaders }),
      fetch(`${trukiUrl}/auth/v1/admin/users?per_page=1000`, { headers: trukiHeaders }),
      fetch(`${trukiUrl}/rest/v1/truki_config?id=eq.1&select=declaracion_responsable_software,updated_at`, { headers: trukiHeaders })
    ]);
    if (!empresasResp.ok || !miembrosResp.ok || !facturasResp.ok || !eventosResp.ok || !usersResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    }

    const empresas = await empresasResp.json();
    const miembros = await miembrosResp.json();
    const facturas = await facturasResp.json();
    const eventos = await eventosResp.json();
    const usersData = await usersResp.json();
    const configRows = configResp.ok ? await configResp.json() : [];
    const users = Array.isArray(usersData) ? usersData : (usersData.users || []);

    const emailPorUserId = new Map(users.map(u => [u.id, u.email]));
    const userPorId = new Map(users.map(u => [u.id, u]));
    const ahora = Date.now();
    const hace7dias = ahora - 7 * 24 * 60 * 60 * 1000;
    const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0);

    const resultado = empresas.map(emp => {
      const miembrosEmpresa = miembros.filter(m => m.client_id === emp.id);
      const equipo = miembrosEmpresa.map(m => ({ email: emailPorUserId.get(m.user_id) || '(usuario borrado)', rol: m.rol }));
      const suspendida = miembrosEmpresa.length > 0 && miembrosEmpresa.every(m => {
        const u = userPorId.get(m.user_id);
        return u && u.banned_until && new Date(u.banned_until).getTime() > ahora;
      });

      const facturasEmpresa = facturas.filter(f => f.client_id === emp.id);
      const conTipo = tipo => facturasEmpresa.filter(f => f.tipo === tipo);
      const delMes = arr => arr.filter(f => new Date(f.creado_en) >= inicioMes);
      const facturasVigentes = conTipo('factura').filter(f => f.estado !== 'anulada');
      const eventosEmpresa = eventos.filter(e => e.client_id === emp.id); // ya vienen ordenados por creado_en.desc
      const ultimoError = eventosEmpresa[0];

      return {
        client_id: emp.id,
        nombre: emp.nombre,
        nif: emp.nif,
        email_empresa: emp.email_empresa,
        equipo,
        suspendida,
        dpa_aceptado_en: emp.dpa_aceptado_en,
        dpa_aceptado_por: emp.dpa_aceptado_por,
        created_at: emp.created_at,
        facturas_total: conTipo('factura').length,
        facturas_mes: delMes(conTipo('factura')).length,
        presupuestos_total: conTipo('presupuesto').length,
        presupuestos_mes: delMes(conTipo('presupuesto')).length,
        ingresos_total: facturasVigentes.reduce((s, f) => s + Number(f.total || 0), 0),
        errores_7d: eventosEmpresa.filter(e => new Date(e.creado_en).getTime() >= hace7dias).length,
        ultimo_error_mensaje: ultimoError ? ultimoError.detalle : null,
        ultimo_error_en: ultimoError ? ultimoError.creado_en : null
      };
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        clientes: resultado,
        declaracion_responsable_software: configRows[0]?.declaracion_responsable_software || '',
        declaracion_updated_at: configRows[0]?.updated_at || null
      })
    };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception' }) };
  }
};
