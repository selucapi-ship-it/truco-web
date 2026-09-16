// Recibe la redirección de Google tras el consentimiento OAuth, cambia el
// código por tokens, y guarda el refresh_token + la dirección de Gmail real
// en client_email_bot_config (ver migration_client_email_bot_config.sql).
// El refresh_token nunca pasa por el navegador del cliente ni se le
// muestra — esta función lo escribe directo en Supabase con la
// service_role key, misma disciplina que el resto de config con secretos.
//
// SIN PROBAR TODAVÍA — mismo motivo que email-ia-oauth-start.js (necesita
// la app de OAuth real en Google Cloud Console).

const crypto = require('crypto');

function authHeaders(key) {
  const h = { 'Content-Type': 'application/json', apikey: key };
  if (!key.startsWith('sb_secret_') && !key.startsWith('sb_publishable_')) {
    h.Authorization = `Bearer ${key}`;
  }
  return h;
}

function verificarState(state, secret) {
  const [clientId, firma] = String(state || '').split('.');
  if (!clientId || !firma) return null;
  const esperada = crypto.createHmac('sha256', secret).update(clientId).digest('hex');
  const a = Buffer.from(firma);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return clientId;
}

async function intercambiarCodigoPorTokens({ code, googleClientId, googleClientSecret, redirectUri }) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!resp.ok) {
    console.error('[EMAIL_IA_OAUTH] Intercambio de código fallido', resp.status, await resp.text());
    return null;
  }
  return resp.json(); // { access_token, refresh_token, expires_in, scope, token_type, id_token }
}

async function obtenerEmailDeGoogle(accessToken) {
  const resp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.email || null;
}

async function guardarConfig(supabaseUrl, serviceKey, clientId, refreshToken, gmailAddress) {
  const resp = await fetch(`${supabaseUrl}/rest/v1/client_email_bot_config?client_id=eq.${clientId}`, {
    method: 'PATCH',
    headers: { ...authHeaders(serviceKey), Prefer: 'return=minimal' },
    body: JSON.stringify({ oauth_refresh_token: refreshToken, gmail_address: gmailAddress }),
  });
  return resp.ok;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const params = event.queryStringParameters || {};
  if (params.error) {
    return { statusCode: 200, body: `Conexión cancelada o rechazada por Google: ${params.error}` };
  }

  const { code, state } = params;
  const stateSecret = process.env.EMAIL_IA_OAUTH_STATE_SECRET;
  const googleClientId = '468608076556-ag64c5hbk2cnkrg4acasrf4c4ctr179m.apps.googleusercontent.com';
  const googleClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = 'https://main--chic-salamander-e640e7.netlify.app/.netlify/functions/email-ia-oauth-callback';
  const supabaseUrl = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!code || !state) {
    return { statusCode: 400, body: 'Faltan parámetros code/state en la redirección de Google' };
  }
  if (!stateSecret || !googleClientId || !googleClientSecret || !redirectUri || !supabaseUrl || !serviceKey) {
    return { statusCode: 500, body: 'Falta configuración obligatoria en Netlify (variables OAuth de Google o de Supabase).' };
  }

  const clientId = verificarState(state, stateSecret);
  if (!clientId) {
    return { statusCode: 400, body: 'state inválido o manipulado' };
  }

  const tokens = await intercambiarCodigoPorTokens({ code, googleClientId, googleClientSecret, redirectUri });
  if (!tokens || !tokens.refresh_token) {
    return {
      statusCode: 502,
      body: 'No se pudo obtener el refresh_token de Google. Si ya habías conectado esta cuenta antes, revoca el acceso en https://myaccount.google.com/permissions y vuelve a intentarlo (Google solo manda el refresh_token la primera vez que se concede acceso a una app).',
    };
  }

  const gmailAddress = await obtenerEmailDeGoogle(tokens.access_token);
  const guardado = await guardarConfig(supabaseUrl, serviceKey, clientId, tokens.refresh_token, gmailAddress);
  if (!guardado) {
    return { statusCode: 500, body: 'Se obtuvo el token de Google pero no se pudo guardar en la base de datos.' };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!doctype html><html lang="es"><meta charset="utf-8"><title>Gmail conectado</title><body style="font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;"><h1>Gmail conectado</h1><p>La cuenta <strong>${gmailAddress || ''}</strong> ya está conectada a tu asistente de IA para Correo. Puedes cerrar esta ventana.</p></body></html>`,
  };
};
