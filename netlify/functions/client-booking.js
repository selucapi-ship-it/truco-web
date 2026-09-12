// Backend compartido de verdad para "Reservas y Agenda" — la mitad que
// faltaba (CREAR una reserva; el recordatorio ya existía como plantilla n8n
// en plantillas/03-automatizaciones/n8n-flows/recordatorio-citas.json).
// Mismo patrón que whatsapp-client-webhook.js / client-web-widget-chat.js:
// una sola función sirve a todos los clientes, identificándolos por su
// widget_key (ver supabase/migration_client_reservas_config.sql).
//
// El calendario NUNCA es de TRUCO — se reserva directo en el Google Calendar
// del propio cliente, que lo comparte con la misma cuenta de servicio que ya
// usa antonia-agent/voice-agent (GOOGLE_SERVICE_ACCOUNT_JSON_B64).
//
// horario_atencion usa un formato MÁQUINA-LEGIBLE (a diferencia de WhatsApp/
// Web-IA, que es texto libre para un FAQ): un objeto con una clave por día
// (lun,mar,mie,jue,vie,sab,dom), cada una una lista de rangos [inicio,fin] en
// "HH:MM", p.ej. {"lun":[["09:00","14:00"],["16:00","20:00"]],"dom":[]}.

const crypto = require('crypto');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const DIAS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];

function authHeaders(key) {
  const h = { 'Content-Type': 'application/json', apikey: key };
  if (!key.startsWith('sb_secret_') && !key.startsWith('sb_publishable_')) {
    h.Authorization = `Bearer ${key}`;
  }
  return h;
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleAccessToken(scope) {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  if (!raw) return null;
  const sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = base64url(signer.sign(sa.private_key));
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${header}.${claim}.${signature}`,
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.access_token || null;
}

async function buscarConfigPorWidgetKey(supabaseUrl, serviceKey, widgetKey) {
  const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/get_reservas_config_by_widget_key`, {
    method: 'POST',
    headers: authHeaders(serviceKey),
    body: JSON.stringify({ p_widget_key: widgetKey }),
  });
  if (!resp.ok) return null;
  const rows = await resp.json();
  return rows && rows[0] ? rows[0] : null;
}

// Devuelve los eventos (ocupado) de un día concreto en el calendario del cliente.
async function fetchEventosDelDia(token, calendarId, fechaYMD) {
  const timeMin = `${fechaYMD}T00:00:00Z`;
  const timeMax = `${fechaYMD}T23:59:59Z`;
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const data = await resp.json();
  return (data.items || []).map((e) => ({
    inicio: new Date(e.start.dateTime || e.start.date),
    fin: new Date(e.end.dateTime || e.end.date),
  }));
}

function minutosDesdeMedianoche(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Convierte una fecha+hora "de pared" en una zona horaria concreta (ej. las
// 09:00 en Europe/Madrid) al instante UTC real que le corresponde — nunca hay
// que fiarse de la zona horaria del propio servidor (Netlify Functions corre
// en UTC), igual que ya tocó corregir antes en agent.py/apuntar_en_agenda con
// el mismo tipo de bug (eventos guardados 1-2h tarde/pronto). Truco estándar
// de "doble conversión": vemos qué hora muestra la zona objetivo para un
// instante ingenuo, y corregimos por la diferencia.
function horaLocalAInstanteUTC(fechaYMD, horaHHMM, zona) {
  const ingenua = new Date(`${fechaYMD}T${horaHHMM}:00Z`);
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(ingenua);
  const obj = {};
  for (const p of partes) obj[p.type] = p.value;
  const comoSiUtc = Date.UTC(Number(obj.year), Number(obj.month) - 1, Number(obj.day), Number(obj.hour) % 24, Number(obj.minute), Number(obj.second));
  const diferencia = ingenua.getTime() - comoSiUtc;
  return new Date(ingenua.getTime() + diferencia);
}

// Genera los huecos libres de duración `duracionMin` (+ buffer) dentro de los
// rangos de horario del día, quitando lo que ya está ocupado. Devuelve
// instantes UTC completos (ISO con Z) — nunca "YYYY-MM-DDTHH:MM" sin zona,
// que es justo lo ambiguo que causaba el bug.
function calcularHuecosLibres(fechaYMD, rangosDia, ocupado, duracionMin, bufferMin, zona) {
  const huecos = [];
  const paso = duracionMin + bufferMin;
  const ahora = new Date();
  for (const [inicioStr, finStr] of rangosDia) {
    let cursor = minutosDesdeMedianoche(inicioStr);
    const finRango = minutosDesdeMedianoche(finStr);
    while (cursor + duracionMin <= finRango) {
      const hh = String(Math.floor(cursor / 60)).padStart(2, '0');
      const mm = String(cursor % 60).padStart(2, '0');
      const inicioSlot = horaLocalAInstanteUTC(fechaYMD, `${hh}:${mm}`, zona);
      const finSlot = new Date(inicioSlot.getTime() + duracionMin * 60000);
      const solapa = ocupado.some((ev) => inicioSlot < ev.fin && finSlot > ev.inicio);
      if (!solapa && inicioSlot > ahora) {
        huecos.push(inicioSlot.toISOString());
      }
      cursor += paso;
    }
  }
  return huecos;
}

exports.handler = async function (event) {
  const responder = (statusCode, payload) => ({ statusCode, headers: CORS_HEADERS, body: JSON.stringify(payload) });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return responder(405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return responder(400, { error: 'Invalid JSON' });
  }

  const widgetKey = String(body.widget_key || '').trim();
  const accion = String(body.accion || '').trim();
  if (!widgetKey || !['disponibilidad', 'reservar'].includes(accion)) {
    return responder(400, { error: 'Falta widget_key o accion inválida' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return responder(200, { ok: false, reason: 'not_configured' });
  }

  const cfg = await buscarConfigPorWidgetKey(supabaseUrl, serviceKey, widgetKey);
  if (!cfg) {
    return responder(200, { ok: false, reason: 'widget_not_found' });
  }

  const token = await getGoogleAccessToken('https://www.googleapis.com/auth/calendar');
  if (!token) {
    return responder(200, { ok: false, reason: 'google_auth_error' });
  }

  const fecha = String(body.fecha || '').trim(); // YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    return responder(400, { error: 'Falta fecha en formato YYYY-MM-DD' });
  }

  const servicio = (Array.isArray(cfg.servicios) ? cfg.servicios : []).find((s) => s.nombre === body.servicio_nombre);
  if (!servicio) {
    return responder(200, { ok: false, reason: 'servicio_no_encontrado' });
  }

  const diaSemana = DIAS[new Date(`${fecha}T12:00:00`).getDay()];
  const rangosDia = (cfg.horario_atencion && cfg.horario_atencion[diaSemana]) || [];

  const ocupado = await fetchEventosDelDia(token, cfg.google_calendar_id, fecha);
  if (ocupado === null) {
    return responder(200, { ok: false, reason: 'calendar_error' });
  }

  if (accion === 'disponibilidad') {
    const huecos = calcularHuecosLibres(fecha, rangosDia, ocupado, servicio.duracion_min, cfg.buffer_min || 0, cfg.zona_horaria || 'Europe/Madrid');
    return responder(200, { ok: true, huecos });
  }

  // accion === 'reservar'
  const horaInicio = String(body.hora_inicio || '').trim(); // "YYYY-MM-DDTHH:MM"
  if (!horaInicio) {
    return responder(400, { error: 'Falta hora_inicio' });
  }
  const inicio = new Date(horaInicio);
  const fin = new Date(inicio.getTime() + servicio.duracion_min * 60000);

  // Re-comprobar que sigue libre justo antes de crear el evento — evita que
  // dos visitantes reserven el mismo hueco a la vez entre que consultaron
  // disponibilidad y confirmaron.
  const sigueOcupado = ocupado.some((ev) => inicio < ev.fin && fin > ev.inicio);
  if (sigueOcupado) {
    return responder(200, { ok: false, reason: 'hueco_ya_no_disponible' });
  }

  const nombreCliente = String(body.cliente_final_nombre || '').slice(0, 200);
  const telefonoCliente = String(body.cliente_final_telefono || '').slice(0, 50);

  const createResp = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cfg.google_calendar_id)}/events`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: `${servicio.nombre} — ${nombreCliente || 'Cliente'}`,
        description: `Reserva creada automáticamente.\nServicio: ${servicio.nombre}\nCliente: ${nombreCliente}\nTeléfono: ${telefonoCliente}`,
        start: { dateTime: inicio.toISOString(), timeZone: cfg.zona_horaria || 'Europe/Madrid' },
        end: { dateTime: fin.toISOString(), timeZone: cfg.zona_horaria || 'Europe/Madrid' },
      }),
    }
  );
  if (!createResp.ok) {
    console.error('[RESERVAS] Error creando evento', createResp.status, await createResp.text());
    return responder(200, { ok: false, reason: 'calendar_create_error' });
  }
  const evento = await createResp.json();

  await fetch(`${supabaseUrl}/rest/v1/reservas_creadas`, {
    method: 'POST',
    headers: { ...authHeaders(serviceKey), Prefer: 'return=minimal' },
    body: JSON.stringify({
      client_id: cfg.client_id,
      google_event_id: evento.id,
      servicio_nombre: servicio.nombre,
      cliente_final_nombre: nombreCliente,
      cliente_final_telefono: telefonoCliente,
      inicio: inicio.toISOString(),
      fin: fin.toISOString(),
    }),
  }).catch((e) => console.error('[RESERVAS] No se pudo registrar la reserva', e.message));

  return responder(200, { ok: true, inicio: inicio.toISOString(), fin: fin.toISOString() });
};
