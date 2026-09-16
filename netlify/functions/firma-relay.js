// "Firma Digital" (producto independiente) — relay del protocolo trifásico
// de AutoFirma / Cliente@firma. Reimplementa en Node, en UN único endpoint
// (op=check|put|get), el mismo contrato HTTP que exponen los dos servicios
// oficiales del gobierno (StorageService.java + RetrieveService.java,
// repositorio ctt-gob-es/clienteafirma, módulos afirma-signature-storage y
// afirma-signature-retriever) — mismo protocolo ya usado y verificado en
// truki-firma-relay.js. Se duplica aquí (en vez de compartir función) para
// que este producto viva en el proyecto Supabase PRINCIPAL, no en el de
// TruKi, y así se pueda vender a un cliente que no usa TruKi en absoluto.
//
// Flujo: la web sube el documento a firmar (op=put, id aleatorio) → la app
// AutoFirma (escritorio) o Cliente@firma (móvil, DNIe por NFC o certificado
// propio) lo recoge (op=get, se borra al leerlo) → firma en el propio
// dispositivo, la clave privada nunca sale de él → sube el resultado de
// vuelta (op=put, otro id) → la web lo recoge (op=get).
//
// Sin autenticación de sesión, a propósito: la app llama a esta URL
// directamente, no como usuario logueado. La seguridad es la misma que usa
// el servicio oficial — id aleatorio no adivinable, lectura de un solo uso,
// caducidad corta. Nunca debe pasar por aquí un certificado ni una clave
// privada, solo el documento o la firma en tránsito.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const EXPIRATION_MS = 15 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_DAT_LENGTH = 8 * 1024 * 1024;

function supabaseHeaders(serviceKey) {
  const headers = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }
  return headers;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const supabaseUrl = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { statusCode: 500, headers: CORS, body: 'ERROR: no configurado' };
  }
  const headers = supabaseHeaders(serviceKey);

  let params = event.queryStringParameters || {};
  if (event.httpMethod === 'POST' && event.body) {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    try {
      params = { ...params, ...Object.fromEntries(new URLSearchParams(raw)) };
    } catch (e) { /* cuerpo no parseable, se ignora, queda solo la querystring */ }
  }

  const op = params.op;

  if (op === 'check') {
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' }, body: 'OK' };
  }

  await fetch(`${supabaseUrl}/rest/v1/firma_temp?created_at=lt.${new Date(Date.now() - EXPIRATION_MS).toISOString()}`,
    { method: 'DELETE', headers }).catch(() => {});

  if (op === 'put') {
    const id = params.id;
    const dat = params.dat;
    if (!id || !ID_RE.test(id) || typeof dat !== 'string' || !dat.length) {
      return { statusCode: 400, headers: CORS, body: 'ERR-02: parámetros inválidos' };
    }
    if (dat.length > MAX_DAT_LENGTH) {
      return { statusCode: 400, headers: CORS, body: 'ERR-05: documento demasiado grande' };
    }
    try {
      const resp = await fetch(`${supabaseUrl}/rest/v1/firma_temp`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ id, dat })
      });
      if (!resp.ok) {
        return { statusCode: 500, headers: CORS, body: 'ERR-03: fallo al guardar' };
      }
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' }, body: 'OK' };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: 'ERR-04: excepción' };
    }
  }

  if (op === 'get') {
    const id = params.id;
    if (!id || !ID_RE.test(id)) {
      return { statusCode: 400, headers: CORS, body: 'ERR-02: id inválido' };
    }
    try {
      const resp = await fetch(`${supabaseUrl}/rest/v1/firma_temp?id=eq.${encodeURIComponent(id)}&select=dat`, { headers });
      if (!resp.ok) {
        return { statusCode: 500, headers: CORS, body: 'ERR-03: fallo al leer' };
      }
      const [row] = await resp.json();
      if (!row) {
        return { statusCode: 404, headers: CORS, body: 'ERR-06: no encontrado o caducado' };
      }
      await fetch(`${supabaseUrl}/rest/v1/firma_temp?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers }).catch(() => {});
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' }, body: row.dat };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: 'ERR-04: excepción' };
    }
  }

  return { statusCode: 400, headers: CORS, body: 'ERR-01: operación desconocida' };
};
