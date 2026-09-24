// Guarda las respuestas del cuestionario-esencial.html — quien lo rellena es
// el cliente, sin sesión ni login (no tiene por qué tener acceso al portal
// todavía), así que esto es una función pública que valida el client_id y
// escribe con service_role, igual que save-lead.js.
//
// Reutiliza audit_respuestas con los MISMOS pregunta_id que ya usa el guion
// de auditoría del panel (we1, we2, wa1, etc.) — así las respuestas aparecen
// solas en la pestaña Auditoría de la ficha del cliente, sin tabla nueva ni
// lógica duplicada. El logo (si lo manda) se guarda en clients.logo_base64,
// igual que las fotos de ticket de fiscal_expenses — este proyecto no usa
// Supabase Storage en ningún sitio.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
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

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const clientId = payload.client_id ? String(payload.client_id) : '';
  const respuestas = Array.isArray(payload.respuestas) ? payload.respuestas : [];
  // Límite generoso pero real: evita que una petición manipulada intente
  // colar miles de filas o un base64 descomunal.
  if (!clientId || !respuestas.length || respuestas.length > 40) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Datos incompletos' }) };
  }
  const logoBase64 = payload.logo_base64 ? String(payload.logo_base64).slice(0, 8_000_000) : null;
  const logoFilename = payload.logo_filename ? String(payload.logo_filename).slice(0, 200) : null;

  try {
    // Comprueba que el cliente existe de verdad antes de escribir nada a su nombre.
    const clientResp = await fetch(`${supabaseUrl}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}&select=id`, { headers });
    if (!clientResp.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    const clientRows = await clientResp.json();
    if (!clientRows.length) return { statusCode: 404, body: JSON.stringify({ error: 'Cliente no encontrado' }) };

    const rows = respuestas
      .filter(r => r && typeof r.pregunta_id === 'string' && typeof r.respuesta === 'string' && r.respuesta.trim())
      .map(r => ({
        client_id: clientId,
        pregunta_id: r.pregunta_id.slice(0, 50),
        respuesta: r.respuesta.slice(0, 4000),
        updated_at: new Date().toISOString(),
      }));

    if (rows.length) {
      const upsertResp = await fetch(`${supabaseUrl}/rest/v1/audit_respuestas`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows),
      });
      if (!upsertResp.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    }

    if (logoBase64) {
      const patchResp = await fetch(`${supabaseUrl}/rest/v1/clients?id=eq.${encodeURIComponent(clientId)}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ logo_base64: logoBase64, logo_filename: logoFilename }),
      });
      if (!patchResp.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error_logo' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception' }) };
  }
};
