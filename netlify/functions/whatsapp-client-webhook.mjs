// Backend compartido de verdad para el automatismo "IA para WhatsApp" —
// UNA sola función atiende el número de WhatsApp de CUALQUIER cliente que
// lo tenga contratado, identificando de cuál se trata por el
// phone_number_id que manda Meta en cada webhook y leyendo su configuración
// real (negocio, tono, FAQ, catálogo, horario) desde
// get_whatsapp_bot_config_by_phone_number_id() — ver
// supabase/migration_client_whatsapp_bot_config.sql.
//
// Formato de función v2 de Netlify (export default, Request/Response web
// estándar) — necesario SOLO para esta función: usa META_WHATSAPP_SYSTEM_TOKEN
// y TRUCO_OWN_PHONE_NUMBER_ID, y sumarlas al resto de variables del sitio
// superaba el límite de 4KB que AWS Lambda impone a las funciones "clásicas"
// (formato v1, exports.handler) — ver https://ntl.fyi/functions-migrate. Las
// demás funciones del sitio siguen en v1 sin tocar; solo esta se libra del
// límite al no pasar por el runtime clásico de Lambda.
//
// RELLENAR en Netlify antes de que esto funcione con clientes reales:
//   - WHATSAPP_CLIENTS_VERIFY_TOKEN  (cadena que tú eliges, se la das a Meta
//     al registrar este webhook — verifica que la petición GET es de Meta.
//     Se reutiliza el mismo valor aunque el cliente tenga su propia app de
//     Meta — el verify token lo elegimos nosotros al configurar CADA app)
//   - META_WHATSAPP_SYSTEM_TOKEN     (el token del system user de TRUCO como
//     Meta Tech Provider, una vez aprobado — válido para TODOS los números
//     de clientes ya incorporados bajo el Business Manager de TRUCO)
// Ya existentes y reutilizadas sin cambios: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY.
//
// PUENTE TEMPORAL (mientras se espera la Advanced Access de TRUCOchat, ~20
// días desde 2026-09-13): un cliente puede tener su PROPIA app de Meta bajo
// su propio Business Manager ("Direct Developer", no necesita Advanced
// Access) — en ese caso su fila en client_whatsapp_bot_config trae su
// propio meta_access_token y se usa ESE en vez del compartido. Ver
// supabase/migration_whatsapp_per_client_meta_token.sql — diseño aditivo:
// si la columna es NULL, todo sigue igual que siempre.

import { crmCapture } from './lib/crm.js';
import { notifyTelegram } from './lib/chat-guard.js';

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
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
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

async function enviarRespuestaWhatsapp(phoneNumberId, destinatario, texto, tokenCliente) {
  // Si el cliente tiene su propia app de Meta (puente temporal, ver cabecera
  // del archivo), se usa su token. Si no, el compartido de TRUCO de siempre.
  const token = tokenCliente || process.env.META_WHATSAPP_SYSTEM_TOKEN;
  if (!token) {
    console.error('[WHATSAPP_CLIENT_BOT] Falta token de envío (ni meta_access_token del cliente ni META_WHATSAPP_SYSTEM_TOKEN)');
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

// ── "JOSE": el propio WhatsApp de TRUCO (+34 681 89 97 93) ──
// No es "un cliente más": no tiene ficha en client_whatsapp_bot_config (esa
// tabla es para las empresas que contratan IA para WhatsApp). Este número
// necesita el mismo conocimiento que el chat de la web (Departamentos,
// precios solo si preguntan, sectores...) y distinguir si quien escribe ya
// es cliente de TRUCO (mirando clients.telefono) o todavía no.
// TRUCO_OWN_PHONE_NUMBER_ID = el phone_number_id que da Meta a ese número
// (no es secreto, es solo un identificador — se guarda en Netlify sin marcar
// como variable sensible).
function normalizarTelefono(t) {
  return String(t || '').replace(/\D/g, '').replace(/^0+/, '');
}

async function buscarClientePorTelefono(supabaseUrl, serviceKey, telefono) {
  const norm = normalizarTelefono(telefono);
  if (!norm) return null;
  // Compara por los últimos 9 dígitos para no depender de cómo esté guardado
  // el prefijo (+34, 0034, sin prefijo...).
  const ultimos9 = norm.slice(-9);
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/clients?select=id,negocio,nombre,arranque_tier,telefono&telefono=ilike.*${ultimos9}`, {
      headers: authHeaders(serviceKey),
    });
    if (!resp.ok) return null;
    const rows = await resp.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (e) {
    return null;
  }
}

const JOSE_PROMPT_BASE = `Eres Jose, el asistente virtual de TRUCOtechnology, respondiendo por el WhatsApp de la empresa. Escribes en español, en frases cortas y naturales de WhatsApp — nunca un email largo, nunca markdown ni enlaces con formato, si das una web escríbela tal cual (trucotechnology.com).

TRANSPARENCIA: te presentas como el asistente virtual de TRUCOtechnology. Solo si te preguntan directamente si eres una persona, dilo con claridad.

QUÉ ES TRUCO: Departamento Tecnológico externalizado para pymes y autónomos en España. 4 escalones — Start™ (sin web, 1 automatización), Basic™ (web + 1 automatización, el recomendado para la mayoría de negocios con local), Lite™ (web + 2 automatizaciones), Pro™ (web + 3 automatizaciones). El primer año se paga de una vez (con 12% dto. si pagas con tarjeta o PayPal); después, mes a mes sin permanencia.

REGLA DE PRECIOS: NUNCA menciones cifras en euros, descuentos ni plazas de fundador si no te lo preguntan expresamente. Recomienda por lo que resuelve, no por lo que cuesta.

RESTAURANTES: la IA para Llamadas coge el teléfono, toma el pedido y reserva mesa; también por WhatsApp y web. El escalón natural es Lite™ (Llamadas + WhatsApp).

El primer paso siempre es una auditoría gratuita con una persona real del equipo (no tú): 20-30 min, sin compromiso. Ofrécela cuando ya hayas entendido su negocio, no en el primer mensaje.

Si te preguntan algo que no sabes o que se sale de esto, dilo con naturalidad y ofrece la auditoría gratuita para resolverlo con una persona.`;

const JOSE_PROSPECTO = `\n\nQUIÉN TE ESCRIBE: alguien que todavía NO es cliente de TRUCO. Diagnostica su negocio (a qué se dedica, qué le está costando) y recomienda el Departamento que encaje, sin presionar.`;

function josePromptCliente(cliente) {
  const nombre = cliente.negocio || cliente.nombre || 'el cliente';
  return `\n\nQUIÉN TE ESCRIBE: ${nombre}, que YA es cliente de TRUCO (Departamento ${cliente.arranque_tier || 'contratado'}). No le vendas nada: ayúdale con su duda o su cuenta. Si necesita un cambio real (ajustar algo de su Departamento, una incidencia, una automatización nueva), dile que se lo pasas al equipo y que le responden — no prometas que tú lo vas a hacer.`;
}

async function manejarMensajeJose(supabaseUrl, serviceKey, geminiKey, phoneNumberId, mensaje, nombreContacto) {
  const de = mensaje.from;
  const texto = mensaje.text.body.slice(0, 2000);
  const cliente = await buscarClientePorTelefono(supabaseUrl, serviceKey, de);
  const prompt = JOSE_PROMPT_BASE + (cliente ? josePromptCliente(cliente) : JOSE_PROSPECTO);
  const respuesta = await llamarGemini(geminiKey, prompt, texto);
  if (!respuesta) return;
  await enviarRespuestaWhatsapp(phoneNumberId, de, respuesta, null);
  if (cliente) {
    await registrarInteraccion(supabaseUrl, serviceKey, cliente.id, `WhatsApp (Jose) — escribió: "${texto}" — Jose respondió: "${respuesta}"`);
    await crmCapture({ clientId: cliente.id, source: 'whatsapp', kind: 'mensaje', nombre: nombreContacto, telefono: de, texto: `Escribió: "${texto.slice(0, 250)}" · Jose respondió: "${respuesta.slice(0, 250)}"` });
  } else {
    await notifyTelegram(`💬 WhatsApp de TRUCO (Jose): nuevo mensaje de un posible cliente.\nDe: ${nombreContacto || de} (${de})\nEscribió: "${texto.slice(0, 300)}"\nJose respondió: "${respuesta.slice(0, 300)}"`);
  }
}

export default async (req) => {
  const url = new URL(req.url);

  // Verificación del webhook — Meta la llama una vez al registrar la URL.
  if (req.method === 'GET') {
    const params = url.searchParams;
    const verifyToken = process.env.WHATSAPP_CLIENTS_VERIFY_TOKEN;
    if (params.get('hub.mode') === 'subscribe' && verifyToken && params.get('hub.verify_token') === verifyToken) {
      return new Response(params.get('hub.challenge') || '', { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Meta espera un 200 rápido siempre que el payload sea válido — nunca
  // devolver un error por un cliente sin configurar o un mensaje que no sea
  // de texto, o Meta empieza a reintentar y desactiva el webhook.
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response('ok', { status: 200 });
  }

  try {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const mensaje = value?.messages?.[0];
    const phoneNumberId = value?.metadata?.phone_number_id;
    if (!mensaje || mensaje.type !== 'text' || !phoneNumberId) {
      return new Response('ok', { status: 200 }); // estado/entrega, no un mensaje de texto real
    }

    const supabaseUrl = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!supabaseUrl || !serviceKey || !geminiKey) {
      console.error('[WHATSAPP_CLIENT_BOT] Faltan variables de entorno obligatorias');
      return new Response('ok', { status: 200 });
    }

    // El propio número de TRUCO ("Jose") no es un cliente más de la tabla
    // compartida — tiene su propio conocimiento y su propia lógica.
    if (phoneNumberId === process.env.TRUCO_OWN_PHONE_NUMBER_ID) {
      await manejarMensajeJose(supabaseUrl, serviceKey, geminiKey, phoneNumberId, mensaje, value?.contacts?.[0]?.profile?.name);
      return new Response('ok', { status: 200 });
    }

    const cfg = await buscarConfigPorNumero(supabaseUrl, serviceKey, phoneNumberId);
    if (!cfg) {
      // Número no reconocido, cliente sin la automatización activa, o en pausa.
      return new Response('ok', { status: 200 });
    }

    const textoUsuario = mensaje.text.body.slice(0, 2000);
    const systemPrompt = construirSystemPrompt(cfg);
    const respuesta = await llamarGemini(geminiKey, systemPrompt, textoUsuario);
    if (!respuesta) return new Response('ok', { status: 200 });

    await enviarRespuestaWhatsapp(phoneNumberId, mensaje.from, respuesta, cfg.meta_access_token);
    await registrarInteraccion(supabaseUrl, serviceKey, cfg.client_id, `WhatsApp — cliente escribió: "${textoUsuario}" — bot respondió: "${respuesta}"`);
    await crmCapture({
      clientId: cfg.client_id, source: 'whatsapp', kind: 'mensaje',
      nombre: value?.contacts?.[0]?.profile?.name, telefono: mensaje.from,
      texto: `Escribió: "${textoUsuario.slice(0, 250)}" · El asistente respondió: "${respuesta.slice(0, 250)}"`,
    });

    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('[WHATSAPP_CLIENT_BOT] excepcion', e.message);
    return new Response('ok', { status: 200 }); // 200 siempre, para no activar reintentos de Meta
  }
};
