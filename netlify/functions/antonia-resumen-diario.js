// ANTONIA — resumen diario de negocio por Telegram.
// Función programada (ver netlify.toml): una vez al día manda al founder un
// único mensaje con las mismas 4 categorías que la campana de avisos del
// panel (admin/panel.html) — conversaciones nuevas, transferencias
// pendientes de confirmar, cobros de domiciliación pendientes del mes y
// leads nuevos sin contactar — para que se entere aunque ese día no llegue a
// abrir el panel. Respeta el modo "no molestar" igual que antonia-vigilancia.js.
//
// Cada número se recalcula en vivo contra su propia condición de "pendiente"
// (igual que hace el panel), salvo "conversaciones nuevas" — igual que allí,
// no tiene un estado de "resuelta", así que se cuenta desde la última vez
// que este mismo resumen se envió (antonia_estado.ultimo_resumen_negocio_at).
// Deliberadamente NO comparte ese contador con panel_notification_state: que
// Jose haya mirado el panel no significa que ya se lo hayan contado por
// Telegram, y al revés — cada canal cuenta lo suyo desde que ÉL lo consumió
// por ese canal.
//
// RELLENAR en Netlify: ya existentes, reutilizadas sin cambios —
// TELEGRAM_BOT_TOKEN, ANTONIA_TELEGRAM_ALLOWED_ID, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.

function authHeaders(key) {
  const h = { 'Content-Type': 'application/json', apikey: key };
  if (!key.startsWith('sb_secret_') && !key.startsWith('sb_publishable_')) {
    h.Authorization = `Bearer ${key}`;
  }
  return h;
}

// Los 3 conteos de abajo son pequeños por naturaleza (conversaciones desde
// ayer, transferencias pendientes, leads sin contactar) — basta con pedir
// solo el id de cada fila y contar el array, sin depender de Content-Range.
async function contarFilas(url, headers) {
  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) return 0;
    const rows = await resp.json();
    return Array.isArray(rows) ? rows.length : 0;
  } catch (e) {
    console.error('[ANTONIA-RESUMEN] fallo contando filas', url, e.message);
    return 0;
  }
}

function contarConversacionesNuevas(supabaseUrl, headers, desde) {
  const url = `${supabaseUrl}/rest/v1/interactions?select=id&source=in.(chat,voice)&created_at=gt.${encodeURIComponent(desde)}`;
  return contarFilas(url, headers);
}

function contarTransferenciasPendientes(supabaseUrl, headers) {
  return contarFilas(`${supabaseUrl}/rest/v1/bank_transfer_orders?select=id&status=eq.pendiente`, headers);
}

function contarLeadsNuevos(supabaseUrl, headers) {
  return contarFilas(`${supabaseUrl}/rest/v1/clients?select=id&status=eq.nuevo`, headers);
}

// Misma condición de "pendiente" que countCobrosPendientes() en
// admin/panel.html: cliente activo con domiciliación activa que todavía no
// tiene un pago de tipo "domiciliacion-...-AAAA-MM" registrado este mes.
async function contarCobrosPendientes(supabaseUrl, headers) {
  try {
    const now = new Date();
    const anio = now.getFullYear(), mes = now.getMonth() + 1;
    const sufijo = '-' + anio + '-' + String(mes).padStart(2, '0');
    const [domResp, pagosResp] = await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/clients?select=id&domiciliacion_activa=eq.true&status=eq.cliente`, { headers }),
      fetch(`${supabaseUrl}/rest/v1/payments?select=client_id,stripe_checkout_session_id&stripe_checkout_session_id=like.domiciliacion-*${sufijo}`, { headers }),
    ]);
    if (!domResp.ok) return 0;
    const clientesDom = await domResp.json();
    const pagosDelMes = pagosResp.ok ? await pagosResp.json() : [];
    const yaClientIds = new Set((pagosDelMes || []).map((p) => p.client_id));
    return (clientesDom || []).filter((c) => !yaClientIds.has(c.id)).length;
  } catch (e) {
    console.error('[ANTONIA-RESUMEN] fallo contando cobros', e.message);
    return 0;
  }
}

exports.handler = async function () {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const allowedId = process.env.ANTONIA_TELEGRAM_ALLOWED_ID;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!botToken || !allowedId || !supabaseUrl || !supabaseKey) {
    console.error('[ANTONIA-RESUMEN] faltan variables de entorno obligatorias');
    return { statusCode: 200, body: 'ok' };
  }
  const headers = authHeaders(supabaseKey);

  let noMolestar = false;
  let ultimoResumenAt = null;
  try {
    const estadoResp = await fetch(`${supabaseUrl}/rest/v1/antonia_estado?id=eq.global&select=no_molestar_hasta,ultimo_resumen_negocio_at`, { headers });
    if (estadoResp.ok) {
      const [estado] = await estadoResp.json();
      noMolestar = !!(estado && estado.no_molestar_hasta && new Date(estado.no_molestar_hasta) > new Date());
      ultimoResumenAt = estado && estado.ultimo_resumen_negocio_at;
    }
  } catch (e) {
    console.error('[ANTONIA-RESUMEN] fallo leyendo antonia_estado', e.message);
  }
  // Primera vez que corre esta función: cuenta solo las últimas 24h, no todo
  // el histórico de conversaciones desde siempre.
  const desde = ultimoResumenAt || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [conversaciones, transferencias, cobros, leads] = await Promise.all([
    contarConversacionesNuevas(supabaseUrl, headers, desde),
    contarTransferenciasPendientes(supabaseUrl, headers),
    contarCobrosPendientes(supabaseUrl, headers),
    contarLeadsNuevos(supabaseUrl, headers),
  ]);

  const piezas = [];
  if (conversaciones > 0) piezas.push(`💬 ${conversaciones === 1 ? '1 conversación nueva' : conversaciones + ' conversaciones nuevas'} en el chat/voz.`);
  if (transferencias > 0) piezas.push(`💶 ${transferencias} transferencia${transferencias === 1 ? '' : 's'} sin confirmar.`);
  if (leads > 0) piezas.push(`🆕 ${leads} lead${leads === 1 ? '' : 's'} nuevo${leads === 1 ? '' : 's'} sin contactar.`);
  if (cobros > 0) piezas.push(`🏦 ${cobros} cobro${cobros === 1 ? '' : 's'} de domiciliación pendiente${cobros === 1 ? '' : 's'} este mes.`);

  const mensaje = piezas.length
    ? `Buenos días — así está tu panel hoy:\n${piezas.join('\n')}`
    : 'Buenos días — nada pendiente de revisar en el panel hoy.';

  try {
    await fetch(`${supabaseUrl}/rest/v1/antonia_avisos`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ tipo: 'resumen_diario', mensaje, enviado_telegram: !noMolestar }),
    });
  } catch (e) {
    console.error('[ANTONIA-RESUMEN] fallo guardando aviso', e.message);
  }

  if (!noMolestar) {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: allowedId, text: mensaje }),
      });
    } catch (e) {
      console.error('[ANTONIA-RESUMEN] fallo enviando a Telegram', e.message);
    }
  }

  try {
    await fetch(`${supabaseUrl}/rest/v1/antonia_estado`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id: 'global', ultimo_resumen_negocio_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.error('[ANTONIA-RESUMEN] fallo actualizando ultimo_resumen_negocio_at', e.message);
  }

  return { statusCode: 200, body: 'ok' };
};
