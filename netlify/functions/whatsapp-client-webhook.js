// Backend compartido de verdad para el automatismo "IA para WhatsApp" —
// UNA sola función atiende el número de WhatsApp de CUALQUIER cliente que
// lo tenga contratado, identificando de cuál se trata por el
// phone_number_id que manda Meta en cada webhook y leyendo su configuración
// real (negocio, tono, FAQ, catálogo, horario) desde
// get_whatsapp_bot_config_by_phone_number_id() — ver
// supabase/migration_client_whatsapp_bot_config.sql.
//
// Decisión de arquitectura (tarea #222 / "backend compartido"): esto
// reemplaza la idea original de "n8n autoalojado en un VPS" para ESTE
// automatismo concreto — misma función para todos los clientes, cero coste
// de servidor nuevo, reutiliza Netlify Functions que ya está en producción
// (chat-ai.js, antonia-chat.js). n8n seguiría siendo la opción para
// automatismos que de verdad necesiten editor visual o integraciones que no
// sean "webhook → leer config → llamar a Gemini → responder".
//
// SIN PROBAR END-TO-END TODAVÍA: la parte de leer la config y construir la
// respuesta con Gemini SÍ está probada (test manual con datos reales en
// Supabase). El envío real por la API de WhatsApp Cloud no se puede probar
// hasta que la Verificación de Empresa de Meta esté aprobada y al menos un
// cliente haya completado el Embedded Signup — hasta entonces esto está
// listo pero no hay ningún número real conectado que lo dispare.
//
// RELLENAR en Netlify antes de que esto funcione con clientes reales:
//   - WHATSAPP_CLIENTS_VERIFY_TOKEN  (cadena que tú eliges, se la das a Meta
//     al registrar este webhook — verifica que la petición GET es de Meta)
//   - META_WHATSAPP_SYSTEM_TOKEN     (el token del system user de TRUCO como
//     Meta Tech Provider, una vez aprobado — válido para TODOS los números
//     de clientes ya incorporados, no uno por cliente)
// Ya existentes y reutilizadas sin cambios: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY.

function authHeaders(key) {
  const h = { 'Content-Type': 'application/json', apikey: key };
  if (!key.startsWith('sb_secret_') && !key.startsWith('sb_publishable_')) {
    h.Authorization = `Bearer ${key}`;
  }
  return h;
}

async function buscarConfigPorNumero(supabaseUrl, serviceKey, phoneNumberId) {
  const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/get_whatsapp_bot_config_by_phone_number_id`, {
    method: 'POST',
    headers: authHeaders(serviceKey),
    body: JSON.stringify({ p_phone_number_id: phoneNumberId }),
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

  return `Eres ${cfg.nombre_asistente || 'el asistente'} de ${cfg.nombre_negocio}, respondiendo por WhatsApp. Tono: ${cfg.tono || 'profesional y cercano'}. Respondes en español, breve y natural, como un mensaje de WhatsApp real, no un email.

Horario de atención: ${horario}

Preguntas frecuentes reales del negocio:
${faq}

Catálogo / servicios reales:
${catalogo}

Reglas: responde SOLO con la información de arriba. Si te preguntan algo que no está aquí, dilo con naturalidad y ofrece que alguien del negocio lo confirme — nunca inventes precios, horarios ni servicios que no estén en esta lista.`;
}

async function llamarGemini(geminiKey, systemPrompt, mensajeUsuario) {
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: mensajeUsuario }] }],
      generationConfig: { temperature: 0.5, maxOutputTokens: 500 },
    }),
  });
  if (!resp.ok) {
    console.error('[WHATSAPP_CLIENT_BOT] Gemini fallo', resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text?.trim() || null;
}

async function enviarRespuestaWhatsapp(phoneNumberId, destinatario, texto) {
  const token = process.env.META_WHATSAPP_SYSTEM_TOKEN;
  if (!token) {
    console.error('[WHATSAPP_CLIENT_BOT] Falta META_WHATSAPP_SYSTEM_TOKEN, no se puede enviar la respuesta');
    return false;
  }
  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: destinatario,
      type: 'text',
      text: { body: texto },
    }),
  });
  if (!resp.ok) {
    console.error('[WHATSAPP_CLIENT_BOT] Envío fallo', resp.status, await resp.text());
    return false;
  }
  return true;
}

async function registrarInteraccion(supabaseUrl, serviceKey, clientId, nota) {
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/interactions`, {
      method: 'POST',
      headers: { ...authHeaders(serviceKey), Prefer: 'return=minimal' },
      body: JSON.stringify({ client_id: clientId, source: 'whatsapp', nota: nota.slice(0, 2000) }),
    });
    if (!resp.ok) {
      console.error('[WHATSAPP_CLIENT_BOT] No se pudo registrar la interacción', resp.status, await resp.text());
    }
  } catch (e) {
    console.error('[WHATSAPP_CLIENT_BOT] No se pudo registrar la interacción', e.message);
  }
}

exports.handler = async function (event) {
  // Verificación del webhook — Meta la llama una vez al registrar la URL.
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    const verifyToken = process.env.WHATSAPP_CLIENTS_VERIFY_TOKEN;
    if (params['hub.mode'] === 'subscribe' && verifyToken && params['hub.verify_token'] === verifyToken) {
      return { statusCode: 200, body: params['hub.challenge'] || '' };
    }
    return { statusCode: 403, body: 'Forbidden' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Meta espera un 200 rápido siempre que el payload sea válido — nunca
  // devolver un error por un cliente sin configurar o un mensaje que no sea
  // de texto, o Meta empieza a reintentar y desactiva el webhook.
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 200, body: 'ok' };
  }

  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const mensaje = value?.messages?.[0];
    const phoneNumberId = value?.metadata?.phone_number_id;
    if (!mensaje || mensaje.type !== 'text' || !phoneNumberId) {
      return { statusCode: 200, body: 'ok' }; // estado/entrega, no un mensaje de texto real
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!supabaseUrl || !serviceKey || !geminiKey) {
      console.error('[WHATSAPP_CLIENT_BOT] Faltan variables de entorno obligatorias');
      return { statusCode: 200, body: 'ok' };
    }

    const cfg = await buscarConfigPorNumero(supabaseUrl, serviceKey, phoneNumberId);
    if (!cfg) {
      // Número no reconocido, cliente sin la automatización activa, o en pausa.
      return { statusCode: 200, body: 'ok' };
    }

    const textoUsuario = mensaje.text.body.slice(0, 2000);
    const systemPrompt = construirSystemPrompt(cfg);
    const respuesta = await llamarGemini(geminiKey, systemPrompt, textoUsuario);
    if (!respuesta) return { statusCode: 200, body: 'ok' };

    await enviarRespuestaWhatsapp(phoneNumberId, mensaje.from, respuesta);
    await registrarInteraccion(supabaseUrl, serviceKey, cfg.client_id, `WhatsApp — cliente escribió: "${textoUsuario}" — bot respondió: "${respuesta}"`);

    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    console.error('[WHATSAPP_CLIENT_BOT] excepcion', e.message);
    return { statusCode: 200, body: 'ok' }; // 200 siempre, para no activar reintentos de Meta
  }
};
