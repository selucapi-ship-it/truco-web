// Enlaza la cuenta de portal que un cliente acaba de crearse él mismo en
// pago.html (auto-registro con contraseña propia, en el mismo paso de
// checkout) con su ficha en `clients` — mismo campo auth_user_id que usa
// invite-client.js para las altas por email, distinta vía de llegada.
//
// El navegador ya hizo la parte sensible (sb.auth.signUp con su propia
// contraseña, contra la API de Supabase Auth directamente — nunca pasa por
// aquí). Esta función solo hace el enlace, con service_role, porque
// clients.auth_user_id no tiene policy de UPDATE para el propio cliente (a
// propósito, ver migration_client_portal.sql).
//
// Verificación importante antes de enlazar: comprobamos contra la propia
// Supabase Auth que el auth_user_id recibido corresponde de verdad a una
// cuenta con ESE email exacto. Sin esto, cualquiera podría mandar un
// client_id/email inventados e intentar enlazarse a la ficha de otro
// cliente — con la comprobación, solo pasa quien de verdad completó el
// registro de Supabase para ese email.
//
// Nota sin verificar en vivo: esto asume que el proyecto de Supabase tiene
// activada la confirmación de email por defecto (así viene de fábrica). Si
// estuviera desactivada, alguien podría registrarse con un email que no es
// suyo sin que nadie lo confirme — revisar Authentication → Settings →
// "Confirm email" antes de dar esto por seguro en producción.
//
// RELLENAR antes de que esto funcione de verdad:
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ya las necesita save-lead.js)

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

  const email = payload.email ? String(payload.email).trim().slice(0, 200) : '';
  const authUserId = payload.auth_user_id ? String(payload.auth_user_id).slice(0, 100) : '';
  if (!email || !authUserId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta email o auth_user_id' }) };
  }

  const headers = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }

  try {
    const lookupResp = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(authUserId)}`, { headers });
    if (!lookupResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'user_not_found' }) };
    }
    const user = await lookupResp.json();
    if (!user || (user.email || '').toLowerCase() !== email.toLowerCase()) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'email_mismatch' }) };
    }

    const patchResp = await fetch(`${supabaseUrl}/rest/v1/clients?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ auth_user_id: authUserId }),
    });
    if (!patchResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'link_failed' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception' }) };
  }
};
