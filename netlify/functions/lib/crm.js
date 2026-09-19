// CRM base por cliente: cada automatización que atiende a alguien (reservas,
// WhatsApp, correo) llama aquí para dejar el contacto y la actividad en la
// libreta de ese cliente. Nunca lanza: un fallo del CRM no debe romper la
// automatización que lo llama.
const SUPABASE_URL = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';

async function crmCapture({ clientId, source, kind, nombre, telefono, email, texto, estado }) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey || !clientId) return null;
  const headers = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/crm_capture`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_client_id: clientId,
        p_source: source || null,
        p_kind: kind || 'mensaje',
        p_nombre: nombre || null,
        p_telefono: telefono || null,
        p_email: email || null,
        p_texto: texto || null,
        p_estado: estado || null,
      }),
    });
    if (!resp.ok) {
      console.error('[CRM] crm_capture', resp.status);
      return null;
    }
    return await resp.json();
  } catch (e) {
    console.error('[CRM] crm_capture', e && e.message);
    return null;
  }
}

// "Ana López <ana@x.com>" → { nombre: 'Ana López', email: 'ana@x.com' }
function parseFrom(de) {
  const s = String(de || '');
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { nombre: m[1].trim() || null, email: m[2].trim() };
  return { nombre: null, email: s.trim() || null };
}

module.exports = { crmCapture, parseFrom };
