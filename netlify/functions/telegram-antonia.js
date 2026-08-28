// ANTONIA — asistente administrativa personal del founder, por Telegram.
// Webhook de Telegram: recibe cada mensaje, comprueba que es el founder
// (nunca responde a nadie más, ni siquiera para decir que existe), recoge un
// resumen en vivo de fiscalidad + clientes/leads + facturación TruKi +
// calendario, y contesta con Gemini usando solo esos datos reales — nunca
// inventa. Mismo patrón de "pre-consulta y mete el contexto en el prompt"
// que ya usa portal-chat.js, sin function-calling (no hay precedente de eso
// en este repo y añade riesgo sin necesidad para un único usuario de bajo
// volumen).
//
// RELLENAR en Netlify antes de que esto funcione:
//   - TELEGRAM_BOT_TOKEN            (lo da @BotFather al crear el bot)
//   - TELEGRAM_WEBHOOK_SECRET       (string aleatorio, lo comprobamos nosotros)
//   - ANTONIA_TELEGRAM_ALLOWED_ID   (el ID numérico de Telegram del founder)
//   - GOOGLE_SERVICE_ACCOUNT_JSON_B64 y GOOGLE_CALENDAR_ID (los mismos que ya
//     usa voice-agent/src/agent.py para el calendario)
// Ya existentes y reutilizadas sin cambios: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, TRUKI_SUPABASE_URL, TRUKI_SUPABASE_SERVICE_ROLE_KEY,
// GEMINI_API_KEY.

const crypto = require('crypto');

const ANTONIA_SYSTEM_PROMPT = `Eres ANTONIA, la asistente administrativa personal del founder de TRUCO technology. Te habla por Telegram, como a una compañera de confianza en el día a día del negocio — no como un robot ni con frases de manual.

Reglas:
1. Responde SOLO con los datos reales que se te dan en el bloque de abajo. Si algo que te pregunta no está ahí, dilo claramente ("no tengo ese dato ahora mismo, revísalo tú directamente") — nunca inventes ni supongas una cifra o un estado.
2. Sé breve y directa — esto es un chat de trabajo rápido, no un informe.
3. Si alguno de los 4 bloques de datos dice que no está disponible, dilo también en vez de ignorarlo en silencio.`;

function authHeaders(key) {
  const h = { 'Content-Type': 'application/json', apikey: key };
  if (!key.startsWith('sb_secret_') && !key.startsWith('sb_publishable_')) {
    h.Authorization = `Bearer ${key}`;
  }
  return h;
}

function eur(cents) {
  return (cents / 100).toFixed(2).replace('.', ',') + ' €';
}

async function fetchFiscal(supabaseUrl, key) {
  try {
    const now = new Date();
    const trimestre = Math.floor(now.getMonth() / 3) + 1;
    const anio = now.getFullYear();
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/founder_fiscal_resumen`, {
      method: 'POST',
      headers: authHeaders(key),
      body: JSON.stringify({ p_anio: anio, p_trimestre: trimestre }),
    });
    if (!resp.ok) {
      console.error('[ANTONIA] fetchFiscal fallo', resp.status, await resp.text());
      return 'No disponible ahora mismo.';
    }
    const r = await resp.json();
    return `Trimestre ${trimestre} de ${anio} (en curso): ingresos ${eur(r.ingresos_netos_acumulados_cents)}, gastos deducibles ${eur(r.gastos_deducibles_acumulados_cents)}, resultado Modelo 303 del trimestre ${eur(r.resultado_303_cents)}, pendiente Modelo 130 ${eur(r.pago_fraccionado_pendiente_130_cents)}.`;
  } catch (e) {
    console.error('[ANTONIA] fetchFiscal excepcion', e.message);
    return 'No disponible ahora mismo.';
  }
}

async function fetchClientes(supabaseUrl, key) {
  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/clients?select=nombre,status,created_at&order=created_at.desc&limit=30`,
      { headers: authHeaders(key) }
    );
    if (!resp.ok) {
      console.error('[ANTONIA] fetchClientes fallo', resp.status, await resp.text());
      return 'No disponible ahora mismo.';
    }
    const rows = await resp.json();
    const porStatus = {};
    rows.forEach((c) => { porStatus[c.status] = (porStatus[c.status] || 0) + 1; });
    const resumenEstados = Object.entries(porStatus).map(([k, v]) => `${k}: ${v}`).join(', ') || 'sin registros';
    const sinCerrar = rows
      .filter((c) => !['cliente', 'descartado', 'baja'].includes(c.status))
      .slice(0, 5)
      .map((c) => `${c.nombre || '(sin nombre)'} (${c.status})`);
    return `Últimos 30 registros por estado — ${resumenEstados}. Leads sin cerrar más recientes: ${sinCerrar.length ? sinCerrar.join('; ') : 'ninguno'}.`;
  } catch (e) {
    console.error('[ANTONIA] fetchClientes excepcion', e.message);
    return 'No disponible ahora mismo.';
  }
}

async function fetchTruki(trukiUrl, trukiKey) {
  if (!trukiUrl || !trukiKey) return 'No configurada.';
  try {
    const resp = await fetch(
      `${trukiUrl}/rest/v1/truki_invoices?select=cliente_nombre,tipo,total,estado,estado_cobro,fecha&order=fecha.desc&limit=10`,
      { headers: authHeaders(trukiKey) }
    );
    if (!resp.ok) {
      console.error('[ANTONIA] fetchTruki fallo', resp.status, await resp.text());
      return 'No disponible ahora mismo.';
    }
    const rows = await resp.json();
    if (!rows.length) return 'Sin facturas ni presupuestos registrados.';
    return rows
      .map((r) => `${r.tipo} de ${r.cliente_nombre || '(sin nombre)'} — ${r.total}€, estado "${r.estado}"${r.estado_cobro ? ` / cobro "${r.estado_cobro}"` : ''}, ${r.fecha}`)
      .join('\n');
  } catch (e) {
    console.error('[ANTONIA] fetchTruki excepcion', e.message);
    return 'No disponible ahora mismo.';
  }
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleAccessToken() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  if (!raw) return null;
  const sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = base64url(signer.sign(sa.private_key));
  const jwt = `${header}.${claim}.${signature}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  if (!resp.ok) {
    console.error('[ANTONIA] getGoogleAccessToken fallo', resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  return data.access_token || null;
}

async function fetchCalendario() {
  try {
    const token = await getGoogleAccessToken();
    if (!token) return 'No configurado.';
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    const now = new Date();
    const en7dias = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${now.toISOString()}&timeMax=${en7dias.toISOString()}&singleEvents=true&orderBy=startTime`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      console.error('[ANTONIA] fetchCalendario fallo', resp.status, await resp.text());
      return 'No disponible ahora mismo.';
    }
    const data = await resp.json();
    const items = data.items || [];
    if (!items.length) return 'Sin eventos en los próximos 7 días.';
    return items
      .map((e) => `- ${e.summary || '(sin título)'} — ${(e.start && (e.start.dateTime || e.start.date)) || '?'}`)
      .join('\n');
  } catch (e) {
    console.error('[ANTONIA] fetchCalendario excepcion', e.message);
    return 'No disponible ahora mismo.';
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Solo aceptamos peticiones que traigan el secreto que le dimos a Telegram
  // al registrar el webhook — cualquier otra cosa, fuera.
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const receivedSecret = event.headers['x-telegram-bot-api-secret-token'];
  if (!expectedSecret || receivedSecret !== expectedSecret) {
    return { statusCode: 403, body: 'Forbidden' };
  }

  let update;
  try {
    update = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 200, body: 'ok' };
  }

  const message = update.message;
  if (!message || !message.text) return { statusCode: 200, body: 'ok' };

  // Solo el founder — a cualquier otro remitente se le ignora en silencio,
  // sin confirmar ni desmentir que el bot exista.
  const allowedId = process.env.ANTONIA_TELEGRAM_ALLOWED_ID;
  const fromId = message.from && String(message.from.id);
  if (!allowedId || fromId !== String(allowedId)) {
    return { statusCode: 200, body: 'ok' };
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const geminiKey = process.env.GEMINI_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!botToken || !geminiKey || !supabaseUrl || !supabaseKey) {
    console.error('[ANTONIA] faltan variables de entorno obligatorias', {
      botToken: !!botToken, geminiKey: !!geminiKey, supabaseUrl: !!supabaseUrl, supabaseKey: !!supabaseKey,
    });
    return { statusCode: 200, body: 'ok' };
  }
  const trukiUrl = process.env.TRUKI_SUPABASE_URL;
  const trukiKey = process.env.TRUKI_SUPABASE_SERVICE_ROLE_KEY;

  const chatId = message.chat.id;
  const texto = message.text.slice(0, 2000);

  const [fiscal, clientes, truki, calendario] = await Promise.all([
    fetchFiscal(supabaseUrl, supabaseKey),
    fetchClientes(supabaseUrl, supabaseKey),
    fetchTruki(trukiUrl, trukiKey),
    fetchCalendario(),
  ]);

  // Comando de diagnóstico: manda de vuelta el estado real de cada fuente
  // tal cual, sin pasar por Gemini — para depurar sin depender de los logs
  // de Netlify (que no se han podido leer de forma fiable desde fuera).
  if (texto.trim() === '/diag') {
    const diag = `DIAGNÓSTICO ANTONIA
Variables presentes: TRUKI_URL=${!!trukiUrl} TRUKI_KEY=${!!trukiKey} GOOGLE_SA=${!!process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64} GOOGLE_CAL_ID=${!!process.env.GOOGLE_CALENDAR_ID}

[FISCALIDAD]
${fiscal}

[CLIENTES]
${clientes}

[TRUKI]
${truki}

[CALENDARIO]
${calendario}`;
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: diag.slice(0, 4000) }),
    });
    return { statusCode: 200, body: 'ok' };
  }

  const contexto = `DATOS REALES AHORA MISMO:

[FISCALIDAD — trimestre en curso]
${fiscal}

[CLIENTES Y LEADS]
${clientes}

[FACTURACIÓN TRUKI]
${truki}

[CALENDARIO — próximos 7 días]
${calendario}`;

  let respuesta = 'No he podido pensar la respuesta ahora mismo, inténtalo otra vez en un momento.';
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: `${ANTONIA_SYSTEM_PROMPT}\n\n${contexto}` }] },
          contents: [{ role: 'user', parts: [{ text: texto }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    if (resp.ok) {
      const data = await resp.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (rawText) respuesta = rawText;
      else console.error('[ANTONIA] Gemini respondio sin texto', JSON.stringify(data).slice(0, 500));
    } else {
      console.error('[ANTONIA] Gemini fallo', resp.status, await resp.text());
    }
  } catch (e) {
    console.error('[ANTONIA] Gemini excepcion', e.message);
  }

  console.log('[ANTONIA] contexto usado:', contexto.replace(/\n/g, ' | '));

  for (let i = 0; i < respuesta.length; i += 4000) {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: respuesta.slice(i, i + 4000) }),
    });
  }

  return { statusCode: 200, body: 'ok' };
};
