// Función programada (ver netlify.toml → [functions."fiscal-deadline-reminder"]) que
// crea, en el Google Calendar del founder, un evento por cada plazo trimestral de
// Modelo 130/303 que todavía no exista, con avisos automáticos de Google Calendar
// (7 días y 1 día antes). No manda nada por su cuenta: es Calendar quien notifica,
// según lo que el founder tenga configurado en su cuenta de Google (popup/email).
//
// Se ejecuta con la cuenta de servicio ya usada por voice-agent (mismas variables
// de entorno GOOGLE_SERVICE_ACCOUNT_JSON_B64 y GOOGLE_CALENDAR_ID, hay que añadirlas
// también aquí en Netlify porque es un despliegue distinto).
//
// Idempotente: cada evento lleva una extendedProperties.private.trucoFiscalDeadline
// única (ej. "2026-T1"); antes de crear uno se comprueba si ya existe con esa marca.

const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(serviceAccount) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(serviceAccount.private_key);
  const jwt = `${signingInput}.${signature.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('No se pudo obtener token de Google: ' + JSON.stringify(data));
  return data.access_token;
}

// Mismas ventanas que nextFiscalDeadline() en admin/panel.html — mantener en sync.
function upcomingDeadlineWindows(fromYear) {
  const y = fromYear;
  return [
    { open: new Date(y, 0, 1), close: new Date(y, 0, 30), label: `Modelo 130 y 303 del T4 ${y - 1}`, key: `${y}-T4prev` },
    { open: new Date(y, 3, 1), close: new Date(y, 3, 20), label: `Modelo 130 y 303 del T1 ${y}`, key: `${y}-T1` },
    { open: new Date(y, 6, 1), close: new Date(y, 6, 20), label: `Modelo 130 y 303 del T2 ${y}`, key: `${y}-T2` },
    { open: new Date(y, 9, 1), close: new Date(y, 9, 20), label: `Modelo 130 y 303 del T3 ${y}`, key: `${y}-T3` },
    { open: new Date(y + 1, 0, 1), close: new Date(y + 1, 0, 30), label: `Modelo 130 y 303 del T4 ${y}`, key: `${y + 1}-T4prev` },
  ];
}

function toDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

async function eventExists(calendarId, accessToken, key) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?privateExtendedProperty=${encodeURIComponent('trucoFiscalDeadline=' + key)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) throw new Error('No se pudo consultar Calendar: ' + (await resp.text()));
  const data = await resp.json();
  return (data.items || []).length > 0;
}

async function createEvent(calendarId, accessToken, w) {
  const closeDateOnly = toDateOnly(w.close);
  const nextDay = new Date(w.close);
  nextDay.setDate(nextDay.getDate() + 1);
  const body = {
    summary: `📅 Presentar ${w.label}`,
    description:
      'Fecha tope para presentar el Modelo 130 (IRPF, pago fraccionado) y el Modelo 303 (IVA) de este trimestre en la Sede Electrónica de la AEAT. ' +
      'Revisa el panel de Fiscalidad de TRUCOtechnology antes de presentar.',
    start: { date: closeDateOnly },
    end: { date: toDateOnly(nextDay) },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 7 * 24 * 60 },
        { method: 'popup', minutes: 24 * 60 },
      ],
    },
    extendedProperties: { private: { trucoFiscalDeadline: w.key } },
  };
  const resp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error('No se pudo crear el evento: ' + (await resp.text()));
  return resp.json();
}

exports.handler = async function () {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  if (!raw) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'bad_service_account_json' }) };
  }

  try {
    const accessToken = await getAccessToken(serviceAccount);
    const now = new Date();
    const windows = upcomingDeadlineWindows(now.getFullYear());
    const creados = [];
    for (const w of windows) {
      if (w.close < now) continue; // ya pasó, no tiene sentido crear el aviso
      const yaExiste = await eventExists(calendarId, accessToken, w.key);
      if (yaExiste) continue;
      await createEvent(calendarId, accessToken, w);
      creados.push(w.label);
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, creados }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception', detail: String(e.message || e) }) };
  }
};
