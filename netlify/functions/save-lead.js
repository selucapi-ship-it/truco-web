exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const source = payload.source;
  if (!['checkout', 'chat', 'voice'].includes(source)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid source' }) };
  }

  const body = {
    p_source: source,
    p_session_id: payload.session_id ? String(payload.session_id).slice(0, 200) : null,
    p_nombre: payload.nombre ? String(payload.nombre).slice(0, 200) : null,
    p_email: payload.email ? String(payload.email).slice(0, 200) : null,
    p_telefono: payload.telefono ? String(payload.telefono).slice(0, 60) : null,
    p_negocio: payload.negocio ? String(payload.negocio).slice(0, 200) : null,
    p_tipo: payload.tipo ? String(payload.tipo).slice(0, 120) : null,
    p_nif: payload.nif ? String(payload.nif).slice(0, 40) : null,
    p_nota: payload.nota ? String(payload.nota).slice(0, 2000) : null,
  };

  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/rpc/log_interaction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception' }) };
  }
};
