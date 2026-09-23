// GOOGLE_SERVICE_ACCOUNT_JSON_B64 vive en Supabase (tabla app_secrets) en vez
// de en las variables de entorno de Netlify — es, con diferencia, el valor
// más pesado (~2.4KB) de todos, y sacarlo de ahí es lo que deja hueco de
// sobra para el resto sin superar el límite de 4KB que Netlify impone en
// modo de compatibilidad con AWS Lambda a las funciones "clásicas" (ver
// memoria netlify-env-vars-4kb-lambda-limit). Cache en memoria del proceso
// para no pedirlo a Supabase en cada invocación — dura mientras el
// contenedor de la función siga caliente entre llamadas.
const SUPABASE_URL = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';

let _cached = null;

function authHeaders(key) {
  const h = { apikey: key };
  if (!key.startsWith('sb_secret_') && !key.startsWith('sb_publishable_')) {
    h.Authorization = `Bearer ${key}`;
  }
  return h;
}

async function getServiceAccountB64() {
  if (_cached) return _cached;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return null;
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/app_secrets?select=value&key=eq.google_service_account_json_b64`,
      { headers: authHeaders(serviceKey) }
    );
    if (!resp.ok) return null;
    const rows = await resp.json();
    _cached = rows && rows[0] ? rows[0].value : null;
    return _cached;
  } catch (e) {
    return null;
  }
}

module.exports = { getServiceAccountB64 };
