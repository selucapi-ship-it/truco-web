// Registra un evento de uso real contra el límite mensual incluido de una
// solución de IA (WhatsApp, Web, Correo: 1.000/mes — Llamadas: 150/mes). La
// llama la integración concreta que TRUCO despliega para CADA cliente (su
// propio WhatsApp Business, su propio widget web, su procesador de correo o
// su agente de llamadas) cada vez que la IA resuelve una interacción — es el
// mismo patrón "plantillas por cliente" que el resto del proyecto: cada
// despliegue lleva su client_id propio configurado (RELLENAR en su config),
// igual que ya lleva sus propias claves de Supabase.
//
// Protegida con un secreto compartido, NO con la sesión de un cliente: quien
// llama aquí es un servidor (n8n, el agente de voz, el backend del widget
// web), nunca el navegador del cliente final. Sin esta protección, cualquiera
// podría inflar a mano el contador de otro cliente y hacer que se le facture
// de más — es un endpoint que mueve dinero real, así que no se deja abierto.
//
// RELLENAR antes de que esto funcione de verdad:
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ya las necesita save-lead.js)
//   - LOG_USAGE_SECRET — un valor aleatorio largo que tú eliges, el mismo que
//     configures en cada integración desplegada (n8n, agente de voz, etc.)
//     como cabecera X-Usage-Secret.

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sharedSecret = process.env.LOG_USAGE_SECRET;
  if (!supabaseUrl || !serviceKey || !sharedSecret) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  const providedSecret = event.headers['x-usage-secret'] || event.headers['X-Usage-Secret'];
  if (providedSecret !== sharedSecret) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Secreto inválido' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const clientId = payload.client_id ? String(payload.client_id).slice(0, 100) : '';
  const solutionKey = payload.solution_key ? String(payload.solution_key).slice(0, 30) : '';
  if (!clientId || !['whatsapp', 'web-ia', 'email-ia', 'llamadas'].includes(solutionKey)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta client_id o solution_key inválido' }) };
  }

  const headers = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }

  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/log_usage_event`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ p_client_id: clientId, p_solution_key: solutionKey }),
    });
    if (!resp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception' }) };
  }
};
