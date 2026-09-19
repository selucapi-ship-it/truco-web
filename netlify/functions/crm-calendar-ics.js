// Enlace de suscripción (iCal) privado de las citas que agendan los asistentes de
// un cliente. Se identifica por un token secreto que solo conoce el dueño del portal
// (crm_settings.ical_token). Compatible con Google Calendar, Outlook y Apple.
const SUPABASE_URL = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';

function headers() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const h = { apikey: key, 'Content-Type': 'application/json' };
  if (key && !key.startsWith('sb_secret_') && !key.startsWith('sb_publishable_')) h.Authorization = `Bearer ${key}`;
  return h;
}
const icsText = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

exports.handler = async function (event) {
  const token = String((event.queryStringParameters || {}).t || '');
  if (!/^[a-f0-9]{24,64}$/.test(token) || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 404, body: 'No encontrado' };
  }
  try {
    const s = await fetch(`${SUPABASE_URL}/rest/v1/crm_settings?ical_token=eq.${token}&select=client_id,brand_name`, { headers: headers() });
    const rows = s.ok ? await s.json() : [];
    if (!rows.length) return { statusCode: 404, body: 'No encontrado' };
    const desde = new Date(Date.now() - 30 * 864e5).toISOString();
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/reservas_creadas?client_id=eq.${rows[0].client_id}&inicio=gte.${encodeURIComponent(desde)}&select=google_event_id,servicio_nombre,cliente_final_nombre,cliente_final_telefono,inicio,fin&order=inicio.asc&limit=500`,
      { headers: headers() }
    );
    const citas = r.ok ? await r.json() : [];
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TRUCO technology//Citas//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${icsText((rows[0].brand_name || 'Mis citas') + ' · Citas TRUCO')}`, 'X-WR-TIMEZONE:Europe/Madrid'];
    citas.forEach((c) => {
      lines.push('BEGIN:VEVENT',
        `UID:${icsText(c.google_event_id || c.inicio)}@trucotechnology.com`,
        `DTSTAMP:${icsDate(new Date().toISOString())}`,
        `DTSTART:${icsDate(c.inicio)}`,
        `DTEND:${icsDate(c.fin || c.inicio)}`,
        `SUMMARY:${icsText(`${c.servicio_nombre || 'Cita'} — ${c.cliente_final_nombre || 'Cliente'}`)}`,
        `DESCRIPTION:${icsText(c.cliente_final_telefono ? 'Teléfono: ' + c.cliente_final_telefono : 'Cita agendada por tu asistente TRUCO')}`,
        'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'private, max-age=300' },
      body: lines.join('\r\n') + '\r\n',
    };
  } catch (e) {
    console.error('[CRM_ICS]', e && e.message);
    return { statusCode: 500, body: 'Error' };
  }
};
