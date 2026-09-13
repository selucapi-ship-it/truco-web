// Worker programado de "IA para Correo" — cada 15 minutos revisa la
// bandeja de entrada de CADA cliente con la automatización activa (misma
// idea de "backend compartido" que whatsapp-client-webhook.js) y deja
// preparada una RESPUESTA EN BORRADOR con IA para cada email nuevo sin
// leer, para que el cliente la revise y la envíe él mismo. Nunca envía un
// correo en nombre del cliente sin que él pulse "enviar" — a diferencia de
// WhatsApp/Web (donde el bot responde solo), el email es más formal y con
// más riesgo si la IA se equivoca, así que aquí el conservador por defecto
// es dejarlo en borrador. Si en el futuro se decide auto-enviar, es un
// cambio de una línea (drafts.create → messages.send) una vez validado con
// clientes reales.
//
// SIN PROBAR TODAVÍA — necesita GOOGLE_OAUTH_CLIENT_ID/SECRET reales y al
// menos un cliente que haya completado email-ia-oauth-start.js. Hasta
// entonces esto está listo pero no hay ningún refresh_token real que
// dispare nada (mismo estado que estuvo whatsapp-client-webhook.js hasta la
// Verificación de Empresa de Meta).

function authHeaders(key) {
  const h = { 'Content-Type': 'application/json', apikey: key };
  if (!key.startsWith('sb_secret_') && !key.startsWith('sb_publishable_')) {
    h.Authorization = `Bearer ${key}`;
  }
  return h;
}

async function listarConfigsActivas(supabaseUrl, serviceKey) {
  const resp = await fetch(
    `${supabaseUrl}/rest/v1/client_email_bot_config?activo=eq.true&oauth_refresh_token=not.is.null&select=*`,
    { headers: authHeaders(serviceKey) },
  );
  if (!resp.ok) {
    console.error('[EMAIL_IA_WORKER] No se pudieron listar las configs', resp.status, await resp.text());
    return [];
  }
  return resp.json();
}

async function refrescarAccessToken(refreshToken, googleClientId, googleClientSecret) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) {
    console.error('[EMAIL_IA_WORKER] No se pudo refrescar el access_token', resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  return data.access_token || null;
}

async function listarMensajesNuevos(accessToken, ultimaRevisionEn) {
  // Gmail no admite filtrar por timestamp exacto en la búsqueda, solo por
  // día ("after:YYYY/MM/DD") — se pide un margen de 1 día hacia atrás y
  // luego se descartan aquí abajo (por internalDate) los que ya se
  // procesaron, así nunca se pierde un mensaje por redondeo de fecha.
  const desde = ultimaRevisionEn ? new Date(ultimaRevisionEn) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  desde.setDate(desde.getDate() - 1);
  // category:primary evita contestar avisos automáticos que Gmail ya
  // clasifica fuera de la bandeja principal (notificaciones de Google,
  // recibos, newsletters...) — hueco real encontrado probando: sin esto
  // el worker generó un borrador de respuesta a un aviso de seguridad de
  // Google y a un email de Scalapay como si fueran consultas de clientes.
  const query = `is:unread in:inbox category:primary after:${desde.toISOString().slice(0, 10).replace(/-/g, '/')}`;
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=20`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) {
    console.error('[EMAIL_IA_WORKER] No se pudieron listar mensajes', resp.status, await resp.text());
    return [];
  }
  const data = await resp.json();
  return data.messages || [];
}

function decodificarBase64Url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function extraerTextoPlano(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodificarBase64Url(payload.body.data);
  }
  if (Array.isArray(payload.parts)) {
    for (const parte of payload.parts) {
      const texto = extraerTextoPlano(parte);
      if (texto) return texto;
    }
  }
  return '';
}

async function obtenerMensaje(accessToken, id) {
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) return null;
  return resp.json();
}

function cabecera(mensaje, nombre) {
  return mensaje.payload?.headers?.find((h) => h.name.toLowerCase() === nombre.toLowerCase())?.value || '';
}

function construirSystemPrompt(cfg) {
  const faq = Array.isArray(cfg.faq) && cfg.faq.length
    ? cfg.faq.map((f) => `P: ${f.pregunta}\nR: ${f.respuesta}`).join('\n\n')
    : 'Ninguna todavía.';

  return `Eres ${cfg.nombre_asistente || 'el asistente'} de ${cfg.nombre_negocio}, redactando un borrador de respuesta a un email real recibido en su bandeja. Tono: ${cfg.tono || 'profesional y cercano'}. Respondes en español, como un email real y breve, con un saludo y despedida naturales — nunca como un documento largo ni una IA genérica.

Preguntas frecuentes reales del negocio:
${faq}

Reglas: responde SOLO con la información de arriba. Si el email pregunta algo que no está aquí, dilo con naturalidad y ofrece confirmar el dato — nunca inventes precios, horarios ni servicios que no estén en esta lista. Termina la respuesta con esta firma exacta:\n${cfg.firma_email || `${cfg.nombre_asistente || 'El equipo'} de ${cfg.nombre_negocio}`}`;
}

async function llamarGemini(geminiKey, systemPrompt, mensajeUsuario) {
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: mensajeUsuario.slice(0, 4000) }] }],
      generationConfig: { temperature: 0.5, maxOutputTokens: 600 },
    }),
  });
  if (!resp.ok) {
    console.error('[EMAIL_IA_WORKER] Gemini falló', resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text?.trim() || null;
}

function construirMimeRespuesta({ para, asunto, messageId, references, textoRespuesta, deAlias }) {
  const asuntoRe = /^re:/i.test(asunto) ? asunto : `Re: ${asunto}`;
  const cabeceras = [
    `To: ${para}`,
    deAlias ? `From: ${deAlias}` : null,
    `Subject: ${asuntoRe}`,
    messageId ? `In-Reply-To: ${messageId}` : null,
    `References: ${[references, messageId].filter(Boolean).join(' ')}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
  ].filter(Boolean).join('\r\n');
  const crudo = `${cabeceras}\r\n\r\n${textoRespuesta}`;
  return Buffer.from(crudo).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function crearBorrador(accessToken, threadId, mimeBase64Url) {
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw: mimeBase64Url, threadId } }),
  });
  if (!resp.ok) {
    console.error('[EMAIL_IA_WORKER] No se pudo crear el borrador', resp.status, await resp.text());
    return false;
  }
  return true;
}

// Envío directo, sin pasar por borrador — solo para clientes con
// auto_enviar=true (lo pide el propio cliente explícitamente, no es el
// comportamiento por defecto). Mismo scope gmail.compose ya concedido
// (incluye "send emails", no hace falta pedir gmail.send aparte).
async function enviarCorreo(accessToken, threadId, mimeBase64Url) {
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: mimeBase64Url, threadId }),
  });
  if (!resp.ok) {
    console.error('[EMAIL_IA_WORKER] No se pudo enviar el correo', resp.status, await resp.text());
    return false;
  }
  return true;
}

async function actualizarUltimaRevision(supabaseUrl, serviceKey, clientId) {
  await fetch(`${supabaseUrl}/rest/v1/client_email_bot_config?client_id=eq.${clientId}`, {
    method: 'PATCH',
    headers: { ...authHeaders(serviceKey), Prefer: 'return=minimal' },
    body: JSON.stringify({ ultima_revision_en: new Date().toISOString() }),
  });
}

async function registrarInteraccion(supabaseUrl, serviceKey, clientId, nota) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/interactions`, {
      method: 'POST',
      headers: { ...authHeaders(serviceKey), Prefer: 'return=minimal' },
      body: JSON.stringify({ client_id: clientId, source: 'email', nota: nota.slice(0, 2000) }),
    });
  } catch (e) {
    console.error('[EMAIL_IA_WORKER] No se pudo registrar la interacción', e.message);
  }
}

async function procesarCliente(cfg, env) {
  const accessToken = await refrescarAccessToken(cfg.oauth_refresh_token, env.googleClientId, env.googleClientSecret);
  if (!accessToken) return;

  const mensajesNuevos = await listarMensajesNuevos(accessToken, cfg.ultima_revision_en);
  const desde = cfg.ultima_revision_en ? new Date(cfg.ultima_revision_en).getTime() : 0;

  for (const ref of mensajesNuevos) {
    const mensaje = await obtenerMensaje(accessToken, ref.id);
    if (!mensaje) continue;
    if (desde && Number(mensaje.internalDate) <= desde) continue; // ya procesado en una pasada anterior

    const de = cabecera(mensaje, 'From');
    const asunto = cabecera(mensaje, 'Subject');
    const messageIdHeader = cabecera(mensaje, 'Message-ID');
    const references = cabecera(mensaje, 'References');
    const texto = extraerTextoPlano(mensaje.payload) || mensaje.snippet || '';
    if (!texto.trim()) continue;
    // Segunda capa de defensa además de category:primary — remitentes
    // automáticos habituales que a veces caen igualmente en la bandeja
    // principal (avisos de seguridad, confirmaciones de terceros...).
    if (/no-?reply|donotreply|notification|mailer-daemon|postmaster/i.test(de)) continue;

    const systemPrompt = construirSystemPrompt(cfg);
    const respuesta = await llamarGemini(env.geminiKey, systemPrompt, `De: ${de}\nAsunto: ${asunto}\n\n${texto}`);
    if (!respuesta) continue;

    const mime = construirMimeRespuesta({
      para: de,
      asunto,
      messageId: messageIdHeader,
      references,
      textoRespuesta: respuesta,
      deAlias: cfg.gmail_address,
    });
    const hecho = cfg.auto_enviar
      ? await enviarCorreo(accessToken, mensaje.threadId, mime)
      : await crearBorrador(accessToken, mensaje.threadId, mime);
    if (hecho) {
      const detalle = cfg.auto_enviar ? 'respuesta enviada automáticamente con IA' : 'borrador de respuesta preparado con IA';
      await registrarInteraccion(env.supabaseUrl, env.serviceKey, cfg.client_id, `Email de "${de}" (asunto: "${asunto}") — ${detalle}.`);
    }
  }

  await actualizarUltimaRevision(env.supabaseUrl, env.serviceKey, cfg.client_id);
}

exports.handler = async function () {
  const env = {
    supabaseUrl: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    geminiKey: process.env.GEMINI_API_KEY,
    googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  };
  if (!env.supabaseUrl || !env.serviceKey || !env.geminiKey || !env.googleClientId || !env.googleClientSecret) {
    console.error('[EMAIL_IA_WORKER] Faltan variables de entorno obligatorias, no se ejecuta esta pasada');
    return { statusCode: 200, body: 'skipped' };
  }

  const configs = await listarConfigsActivas(env.supabaseUrl, env.serviceKey);
  for (const cfg of configs) {
    try {
      await procesarCliente(cfg, env);
    } catch (e) {
      console.error('[EMAIL_IA_WORKER] Excepción procesando cliente', cfg.client_id, e.message);
    }
  }

  return { statusCode: 200, body: `ok — ${configs.length} clientes revisados` };
};
