// Comprueba si un NIF/CIF ya está registrado por otro cliente — llamado
// desde pago.html mientras el usuario escribe. Solo devuelve un booleano,
// nunca datos de ese cliente: la web pública no tiene (ni debe tener) acceso
// de lectura a fichas ajenas, así que la comprobación real se hace aquí con
// la service_role key.
exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    return { statusCode: 200, body: JSON.stringify({ exists: false }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const nif = (payload.nif || '').toString().trim().slice(0, 40);
  if (!nif) return { statusCode: 200, body: JSON.stringify({ exists: false }) };

  const headers = { apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }

  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/clients?select=id&nif=ilike.${encodeURIComponent(nif)}&limit=1`,
      { headers }
    );
    if (!resp.ok) return { statusCode: 200, body: JSON.stringify({ exists: false }) };
    const rows = await resp.json();
    return { statusCode: 200, body: JSON.stringify({ exists: Array.isArray(rows) && rows.length > 0 }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ exists: false }) };
  }
};
