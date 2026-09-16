// Genera el enlace de conexión OAuth de Gmail para un cliente de "IA para
// Correo" — el cliente pulsa este enlace, inicia sesión con SU PROPIO
// Gmail (decisión ya tomada, ver migration_client_email_bot_config.sql), y
// Google le redirige de vuelta a email-ia-oauth-callback.js con un código
// que esa función cambia por un refresh_token guardado en
// client_email_bot_config.
//
// Mismo patrón de "backend compartido, una función para todos los
// clientes" que whatsapp-client-webhook.js / client-web-widget-chat.js /
// client-booking.js — nunca se despliega código nuevo por cliente.
//
// SIN PROBAR TODAVÍA — necesita una app de OAuth real en Google Cloud
// Console (Client ID + Client Secret de un OAuth Client tipo "Web
// application", con la API de Gmail habilitada). Hasta que existan
// GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET /
// EMAIL_IA_OAUTH_STATE_SECRET / EMAIL_IA_OAUTH_REDIRECT_URI en Netlify,
// esta función devuelve un 500 explicando qué falta en vez de fallar en
// silencio.
//
// Uso: GET /.netlify/functions/email-ia-oauth-start?client_id=<uuid> — con
// el client_id real de la fila en la tabla `clients`. Redirige (302) a la
// pantalla de consentimiento de Google.

const crypto = require('crypto');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

function firmarState(clientId, secret) {
  const hmac = crypto.createHmac('sha256', secret).update(clientId).digest('hex');
  return `${clientId}.${hmac}`;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const clientId = (event.queryStringParameters || {}).client_id;
  if (!clientId) {
    return { statusCode: 400, body: 'Falta el parámetro client_id' };
  }

  const googleClientId = '468608076556-ag64c5hbk2cnkrg4acasrf4c4ctr179m.apps.googleusercontent.com';
  const stateSecret = process.env.EMAIL_IA_OAUTH_STATE_SECRET;
  const redirectUri = 'https://main--chic-salamander-e640e7.netlify.app/.netlify/functions/email-ia-oauth-callback';
  if (!googleClientId || !stateSecret || !redirectUri) {
    return {
      statusCode: 500,
      body: 'Falta configurar EMAIL_IA_OAUTH_STATE_SECRET en Netlify.',
    };
  }

  const state = firmarState(clientId, stateSecret);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', googleClientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent'); // fuerza que Google mande refresh_token siempre, no solo la primera vez
  url.searchParams.set('state', state);

  return { statusCode: 302, headers: { Location: url.toString() }, body: '' };
};
