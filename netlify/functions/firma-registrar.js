// "Firma Digital" (producto independiente) — recibe la firma XAdES real ya
// obtenida con AutoFirma/Cliente@firma en el propio dispositivo del
// firmante (la operación criptográfica ya ocurrió fuera de nuestro
// servidor) y la guarda junto con el documento original. Identifica al
// cliente por firma_key (clave pública que pega en su propia web), mismo
// patrón que widget_key en client-web-widget-chat.js — nunca hace falta
// desplegar código nuevo por cliente, solo darle su fila en
// client_firma_config.
//
// Guarda el documento Y la firma juntos: una firma XAdES detached es un
// hash firmado del documento, no tiene valor probatorio archivada sola.

function authHeaders(key) {
  const h = { 'Content-Type': 'application/json', apikey: key };
  if (!key.startsWith('sb_secret_') && !key.startsWith('sb_publishable_')) {
    h.Authorization = `Bearer ${key}`;
  }
  return h;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

async function buscarConfigPorFirmaKey(supabaseUrl, serviceKey, firmaKey) {
  const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/get_firma_config_by_key`, {
    method: 'POST',
    headers: authHeaders(serviceKey),
    body: JSON.stringify({ p_firma_key: firmaKey }),
  });
  if (!resp.ok) return null;
  const rows = await resp.json();
  return rows && rows[0] ? rows[0] : null;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const firmaKey = payload.firma_key;
  const documentoNombre = payload.documento_nombre ? String(payload.documento_nombre).slice(0, 300) : 'documento';
  const documentoBase64 = payload.documento_base64;
  const firmaBase64 = payload.firma_base64;
  const certificadoBase64 = payload.certificado_base64 ? String(payload.certificado_base64).slice(0, 8000) : null;
  const firmanteNombre = payload.firmante_nombre ? String(payload.firmante_nombre).slice(0, 200) : null;
  const firmanteEmail = payload.firmante_email ? String(payload.firmante_email).slice(0, 200) : null;

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!firmaKey || !uuidRe.test(firmaKey) || typeof documentoBase64 !== 'string' || documentoBase64.length < 10 ||
      typeof firmaBase64 !== 'string' || firmaBase64.length < 20) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Faltan datos de la firma' }) };
  }

  const cfg = await buscarConfigPorFirmaKey(supabaseUrl, serviceKey, firmaKey);
  if (!cfg) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'firma_key no reconocida' }) };
  }

  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/documentos_firmados`, {
      method: 'POST',
      headers: { ...authHeaders(serviceKey), Prefer: 'return=representation' },
      body: JSON.stringify({
        client_id: cfg.client_id,
        documento_nombre: documentoNombre,
        documento_base64: documentoBase64,
        firma_base64: firmaBase64,
        certificado_base64: certificadoBase64,
        firmante_nombre: firmanteNombre,
        firmante_email: firmanteEmail,
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      console.error(`firma-registrar: respondió ${resp.status}: ${errBody.slice(0, 500)}`);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    }
    const [row] = await resp.json();
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, id: row && row.id }) };
  } catch (e) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, reason: 'exception' }) };
  }
};
