// Backend compartido de verdad para "IA para tu Web" — UNA sola función
// atiende el widget de CUALQUIER cliente, identificándolo por el widget_key
// público que él mismo pega en el HTML de su web (ver
// supabase/migration_client_web_bot_config.sql). Mismo patrón exacto que
// whatsapp-client-webhook.js y el futuro agente de "IA para Llamadas" — nunca
// se despliega código nuevo por cliente, solo se le da su fila de config.
//
// Distinto de chat-ai.js (que es 100% el asistente de VENTAS de la propia
// TRUCOtechnology, con su catálogo y precios hardcodeados) — esta función no
// sabe nada de TRUCO, solo del negocio del cliente que la está usando.
//
// IMPORTANTE — antes de dar esto por listo para un cliente real: confirmar
// que GEMINI_API_KEY tiene facturación activada, no la clave gratuita de 20
// peticiones/día que ya comparten chat-ai.js y ANTONIA — un solo cliente real
// con uso normal (decenas de conversaciones al día) agotaría esa cuota
// gratuita en minutos y rompería también el chat de venta de TRUCO.

// Clave pública (anon) de Supabase — no es un secreto, ya va expuesta tal
// cual en el navegador de cualquier visitante (mismo valor que usa
// founding-offer.js/chat-ai.js en el propio sitio). Solo sirve para llamar a
// check_chat_quota(), que internamente se limita sola por session_id.
const SUPABASE_ANON_KEY = 'sb_publishable_dMe9-l4q9RvLgdUFRY3gWA_iIMilsXX';

function authHeaders(key) {
  const h = { 'Content-Type': 'application/json', apikey: key };
  if (!key.startsWith('sb_secret_') && !key.startsWith('sb_publishable_')) {
    h.Authorization = `Bearer ${key}`;
  }
  return h;
}

async function buscarConfigPorWidgetKey(supabaseUrl, serviceKey, widgetKey) {
  const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/get_web_bot_config_by_widget_key`, {
    method: 'POST',
    headers: authHeaders(serviceKey),
    body: JSON.stringify({ p_widget_key: widgetKey }),
  });
  if (!resp.ok) return null;
  const rows = await resp.json();
  return rows && rows[0] ? rows[0] : null;
}

function construirSystemPrompt(cfg) {
  const horario = cfg.horario_atencion && Object.keys(cfg.horario_atencion).length
    ? Object.entries(cfg.horario_atencion).map(([dia, h]) => `${dia}: ${h}`).join('; ')
    : 'no especificado';
  const faq = Array.isArray(cfg.faq) && cfg.faq.length
    ? cfg.faq.map((f) => `P: ${f.pregunta}\nR: ${f.respuesta}`).join('\n\n')
    : 'Ninguna todavía.';
  const catalogo = Array.isArray(cfg.catalogo) && cfg.catalogo.length
    ? cfg.catalogo.map((c) => `- ${c.nombre}${c.precio ? ` (${c.precio}€)` : ''}${c.descripcion ? `: ${c.descripcion}` : ''}`).join('\n')
    : 'Ninguno todavía.';

  return `Eres ${cfg.nombre_asistente || 'el asistente'} de ${cfg.nombre_negocio}, respondiendo en el chat de su página web. Tono: ${cfg.tono || 'profesional y cercano'}. Respondes en español, breve y natural, como alguien real del negocio escribiendo en un chat — no como un documento ni una IA genérica.

Horario de atención: ${horario}

Preguntas frecuentes reales del negocio:
${faq}

Catálogo / servicios reales:
${catalogo}

Reglas: responde SOLO con la información de arriba. Si te preguntan algo que no está aquí, dilo con naturalidad y ofrece que alguien del negocio lo confirme — nunca inventes precios, horarios ni servicios que no estén en esta lista. Sé breve: 2-4 frases por turno, como una conversación de chat real, no una ficha técnica.`;
}

async function llamarGemini(geminiKey, systemPrompt, contents) {
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.6, maxOutputTokens: 500 },
    }),
  });
  if (!resp.ok) {
    console.error('[WEB_CLIENT_BOT] Gemini fallo', resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text?.trim() || null;
}

async function comprobarLimiteAntiAbuso(supabaseUrl, anonKey, widgetKey, sessionId) {
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/check_chat_quota`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      // Namespaced con el widget_key para no compartir contador con el chat
      // propio de TRUCO (chat-ai.js) ni con el de otro cliente. Límite
      // generoso (150/día) porque el tope de negocio real es el mensual
      // (1.000/mes en solutions_catalog) — esto solo frena abuso/spam puro.
      body: JSON.stringify({ p_session_id: `webia:${widgetKey}:${sessionId}`, p_limit: 150 }),
    });
    if (!resp.ok) return { allowed: true };
    return await resp.json();
  } catch (e) {
    return { allowed: true };
  }
}

async function registrarUso(supabaseUrl, serviceKey, clientId) {
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/log_usage_event`, {
      method: 'POST',
      headers: authHeaders(serviceKey),
      body: JSON.stringify({ p_client_id: clientId, p_solution_key: 'web-ia' }),
    });
    if (!resp.ok) {
      console.error('[WEB_CLIENT_BOT] No se pudo registrar el uso', resp.status, await resp.text());
    }
  } catch (e) {
    console.error('[WEB_CLIENT_BOT] No se pudo registrar el uso', e.message);
  }
}

// El widget se pega en la web de CADA cliente (un dominio distinto cada
// vez, desconocido de antemano), así que el navegador exige CORS — el
// widget_key ya identifica y limita a qué cliente pertenece cada llamada,
// así que abrir el origen a cualquier dominio aquí no es un problema de
// seguridad nuevo, es lo que hace falta para que esto funcione en absoluto.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const responder = (statusCode, payload) => ({ statusCode, headers: CORS_HEADERS, body: JSON.stringify(payload) });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return responder(400, { error: 'Invalid JSON' });
  }

  const widgetKey = String(body.widget_key || '').trim();
  const message = String(body.message || '').trim().slice(0, 1000);
  const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
  const sessionId = String(body.session_id || '').trim();
  if (!widgetKey || !message) {
    return responder(400, { error: 'Falta widget_key o message' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = SUPABASE_ANON_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!supabaseUrl || !serviceKey || !geminiKey) {
    return responder(200, { text: '', unresolved: true, reason: 'not_configured' });
  }

  const cfg = await buscarConfigPorWidgetKey(supabaseUrl, serviceKey, widgetKey);
  if (!cfg) {
    // widget_key no reconocido, o cliente sin la automatización activa/en pausa.
    return responder(200, { text: '', unresolved: true, reason: 'widget_not_found' });
  }

  const cuota = await comprobarLimiteAntiAbuso(supabaseUrl, anonKey, widgetKey, sessionId);
  if (cuota && cuota.allowed === false) {
    return responder(200, { text: '', unresolved: true, reason: 'rate_limited' });
  }

  const contents = [
    ...history.map((h) => ({ role: h.role === 'bot' || h.role === 'model' ? 'model' : 'user', parts: [{ text: String(h.text || '').slice(0, 1000) }] })),
    { role: 'user', parts: [{ text: message }] },
  ];

  const systemPrompt = construirSystemPrompt(cfg);
  const respuesta = await llamarGemini(geminiKey, systemPrompt, contents);
  if (!respuesta) {
    return responder(200, { text: '', unresolved: true, reason: 'api_error' });
  }

  await registrarUso(supabaseUrl, serviceKey, cfg.client_id);

  return responder(200, { text: respuesta, unresolved: false });
};
