// Recibe el resumen de uso que manda cada instancia de TruKi (facturas y
// presupuestos emitidos, errores recientes) y lo guarda en
// truki_usage_snapshots, para que el founder lo vea desde el panel principal
// sin tener que entrar al Supabase de cada cliente.
//
// Autenticada por el master_secret propio de esa instancia (guardado en
// truki_instances al registrarla) — NO por sesión de usuario: quien llama
// aquí es la propia Function truki-report-usage.js de cada instancia de
// TruKi, un servidor llamando a otro servidor, nunca el navegador de un
// trabajador. Si el secreto no coincide con el de esa instancia, se rechaza
// — así una instancia no puede reportar datos falsos en nombre de otra.
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

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const clientId = payload.client_id ? String(payload.client_id).slice(0, 100) : '';
  const secret = payload.master_secret ? String(payload.master_secret) : '';
  if (!clientId || !secret) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta client_id o master_secret' }) };
  }

  const headers = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }

  try {
    const instResp = await fetch(
      `${supabaseUrl}/rest/v1/truki_instances?client_id=eq.${encodeURIComponent(clientId)}&select=id,master_secret`,
      { headers }
    );
    if (!instResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    }
    const rows = await instResp.json();
    const instancia = rows[0];
    if (!instancia || instancia.master_secret !== secret) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Secreto inválido' }) };
    }

    const clamp = n => Math.max(0, Math.min(Number(n) || 0, 1000000));
    const snapshot = {
      instance_id: instancia.id,
      facturas_mes: clamp(payload.facturas_mes),
      presupuestos_mes: clamp(payload.presupuestos_mes),
      facturas_total: clamp(payload.facturas_total),
      presupuestos_total: clamp(payload.presupuestos_total),
      errores_7d: clamp(payload.errores_7d),
      ultimo_error: payload.ultimo_error ? String(payload.ultimo_error).slice(0, 500) : null,
      ultimo_error_at: payload.ultimo_error_at || null,
      reported_at: new Date().toISOString()
    };

    const upsertResp = await fetch(`${supabaseUrl}/rest/v1/truki_usage_snapshots`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(snapshot)
    });
    if (!upsertResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception' }) };
  }
};
