// Agenda nativa: devuelve los próximos eventos del calendario de Google del cliente (o del founder)
// leyéndolos en el servidor con la cuenta de servicio de TRUCO. Sustituye al iframe de Google
// Calendar, que fallaba porque el navegador bloquea el inicio de sesión de Google dentro de un
// iframe (cookies de terceros) y obligaba a estar logueado en esa misma cuenta.
//
// Requisito: el calendario debe estar compartido con la cuenta de servicio (la misma que ya
// usan las reservas y el asistente de voz) con permiso «Realizar cambios en los eventos».
//
// GET /.netlify/functions/calendar-events?days=14[&cal=<id>]   (Authorization: Bearer <sesión>)
// GET /.netlify/functions/calendar-events?from=<ISO>&to=<ISO>[&cal=<id>]  (para un mes/rango concreto,
//   usado por el calendario visual navegable del portal — from/to tienen prioridad sobre days si vienen los dos)
//  - Cliente: siempre su calendar_id de crm_settings (el que mande el navegador se ignora).
//  - Founder: ?cal=<id> o, si no, GOOGLE_CALENDAR_ID.

const crypto = require('crypto');
const { getServiceAccountB64 } = require('./lib/google-sa');
const SUPABASE_URL = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function cuentaServicio() {
  const raw = await getServiceAccountB64();
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
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'method' });
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return json(200, { ok: false, error: 'not_configured' });

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const userToken = auth.replace(/^Bearer\s+/i, '').trim();
  if (!userToken) return json(401, { ok: false, error: 'sin_sesion' });
  const userHeaders = { apikey: serviceKey, Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' };

  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: userHeaders }).catch(() => null);
  if (!who || !who.ok) return json(401, { ok: false, error: 'sesion_invalida' });

  // ¿founder? (is_founder() lee la identidad del token del usuario)
  let founder = false;
  try {
    const f = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_founder`, { method: 'POST', headers: userHeaders, body: '{}' });
    founder = f.ok && (await f.json()) === true;
  } catch (e) { /* cliente normal */ }

  const q = event.queryStringParameters || {};
  let calId = null;
  if (founder) {
    calId = (q.cal || process.env.GOOGLE_CALENDAR_ID || '').trim();
  } else {
    // RLS: solo devuelve la fila del propio cliente
    const s = await fetch(`${SUPABASE_URL}/rest/v1/crm_settings?select=calendar_id`, { headers: userHeaders }).catch(() => null);
    const rows = s && s.ok ? await s.json() : [];
    calId = rows && rows[0] && rows[0].calendar_id ? String(rows[0].calendar_id).trim() : null;
  }
  if (!calId) return json(200, { ok: true, linked: false, events: [] });

  const sa = await cuentaServicio();
  if (!sa) return json(200, { ok: false, error: 'not_configured' });
  const token = await tokenGoogle(sa, 'https://www.googleapis.com/auth/calendar.readonly');
  if (!token) return json(200, { ok: false, error: 'google_auth' });

  let timeMin, timeMax;
  const fromDate = q.from ? new Date(q.from) : null;
  const toDate = q.to ? new Date(q.to) : null;
  if (fromDate && !isNaN(fromDate) && toDate && !isNaN(toDate)) {
    // rango explícito (mes visible del calendario navegable) — sin límite de 90 días,
    // ya que aquí el propio cliente decide qué mes mirar, pasado o futuro.
    timeMin = fromDate.toISOString();
    timeMax = toDate.toISOString();
  } else {
    const days = Math.min(Math.max(parseInt(q.days, 10) || 14, 1), 90);
    timeMin = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    timeMax = new Date(Date.now() + days * 86400000).toISOString();
  }
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=100`;
  const g = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (g.status === 403 || g.status === 404) {
    return json(200, { ok: false, error: 'not_shared', service_account: sa.client_email, calendar: calId });
  }
  if (!g.ok) return json(200, { ok: false, error: 'google_error' });
  const data = await g.json();
  const events = (data.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
    id: e.id,
    title: e.summary || '(sin título)',
    start: e.start && (e.start.dateTime || e.start.date),
    end: e.end && (e.end.dateTime || e.end.date),
    allDay: !!(e.start && e.start.date && !e.start.dateTime),
    location: e.location || '',
    link: e.htmlLink || '',
  }));
  return json(200, { ok: true, linked: true, calendar: calId, events });
};
