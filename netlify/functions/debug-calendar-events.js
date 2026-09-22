// TEMPORAL — diagnostico del bug de disponibilidad del agente de voz. Lista
// los eventos reales (titulo + inicio + fin) de GOOGLE_CALENDAR_ID entre
// ?from=ISO y ?to=ISO, usando la misma cuenta de servicio ya configurada.
// No expone ningun secreto — solo titulos y horas de eventos. Borrar este
// fichero en cuanto se resuelva el bug de las citas del agente de voz.
//
// GET /.netlify/functions/debug-calendar-events?from=2026-09-24T00:00:00%2B02:00&to=2026-09-24T23:59:59%2B02:00&t=<WHATSAPP_CLIENTS_VERIFY_TOKEN>

const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function cuentaServicio() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  if (!raw) return null;
  try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch (e) { return null; }
}
async function tokenGoogle(sa, scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = b64url(signer.sign(sa.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${header}.${claim}.${signature}`,
  });
  if (!r.ok) return null;
  return (await r.json()).access_token || null;
}
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  if (q.t !== process.env.WHATSAPP_CLIENTS_VERIFY_TOKEN) return json(403, { error: 'forbidden' });

  const sa = cuentaServicio();
  if (!sa) return json(200, { error: 'no_service_account' });
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  const token = await tokenGoogle(sa, 'https://www.googleapis.com/auth/calendar.readonly');
  if (!token) return json(200, { error: 'google_auth_failed' });

  const from = q.from || new Date().toISOString();
  const to = q.to || new Date(Date.now() + 3 * 86400000).toISOString();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}&singleEvents=true&orderBy=startTime&maxResults=50`;
  const g = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await g.json();
  if (!g.ok) return json(200, { error: 'google_error', status: g.status, detail: data });

  const eventos = (data.items || []).map((e) => ({
    summary_literal: JSON.stringify(e.summary ?? null),
    start: e.start,
    end: e.end,
    status: e.status,
  }));

  return json(200, { calendar_id_usado: calendarId, service_account_email: sa.client_email, total_eventos: eventos.length, eventos });
};
