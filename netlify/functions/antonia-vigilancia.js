// ANTONIA — vigilancia proactiva del calendario (personal + profesional).
// Función programada (ver netlify.toml): se ejecuta sola cada 15 minutos, sin
// que nadie la llame, y compara el estado actual de ambas agendas contra la
// última vez que se ejecutó (guardado en la tabla antonia_calendar_snapshot).
// Si detecta que un evento que antes existía ha desaparecido o se ha marcado
// como cancelado, o que un invitado ha rechazado una cita ya confirmada,
// avisa a Jose por Telegram de inmediato — sin que él tenga que preguntar.
//
// Esto es justo la mitad "empuja" de ANTONIA: el asistente de voz (LiveKit)
// es la mitad "responde cuando le preguntas"; esta función es la que se
// entera sola de que algo ha cambiado y lo cuenta.
//
// RELLENAR en Netlify antes de que esto funcione (los 3 primeros ya deberían
// existir por telegram-antonia.js; los 2 de agenda son nuevos, ver
// antonia-agent/.env.local para el mismo patrón):
//   - TELEGRAM_BOT_TOKEN, ANTONIA_TELEGRAM_ALLOWED_ID, GOOGLE_SERVICE_ACCOUNT_JSON_B64
//   - GOOGLE_CALENDAR_ID_PROFESIONAL (o GOOGLE_CALENDAR_ID, el mismo de siempre)
//   - GOOGLE_CALENDAR_ID_PERSONAL (nuevo — el calendario personal de Jose,
//     compartido con el service account con permiso de ver detalles)
// Ya existentes y reutilizadas sin cambios: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

const crypto = require('crypto');

const VENTANA_DIAS = 14; // cuántos días hacia adelante se vigilan

function authHeaders(key) {
  const h = { 'Content-Type': 'application/json', apikey: key };
  if (!key.startsWith('sb_secret_') && !key.startsWith('sb_publishable_')) {
    h.Authorization = `Bearer ${key}`;
  }
  return h;
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Mismo patrón exacto que telegram-antonia.js, pero con permiso de lectura
// normal (no readonly) porque el service account ya lo necesita en scope
// completo para que ANTONIA (la de voz) pueda también escribir citas.
async function getGoogleAccessToken() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  if (!raw) return null;
  const sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = base64url(signer.sign(sa.private_key));
  const jwt = `${header}.${claim}.${signature}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  if (!resp.ok) {
    console.error('[ANTONIA-VIGILANCIA] getGoogleAccessToken fallo', resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  return data.access_token || null;
}

async function fetchEventosAgenda(token, calendarId) {
  const now = new Date();
  const hasta = new Date(now.getTime() + VENTANA_DIAS * 24 * 60 * 60 * 1000);
  // showDeleted:true para que los eventos cancelados sigan apareciendo con
  // status "cancelled" en vez de desaparecer sin más del listado — así
  // podemos distinguir "cancelado de verdad" de "todavía no ha llegado a la
  // ventana de 14 días".
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
    + `?timeMin=${now.toISOString()}&timeMax=${hasta.toISOString()}&singleEvents=true&showDeleted=true&maxResults=250`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    console.error('[ANTONIA-VIGILANCIA] fetchEventosAgenda fallo', calendarId, resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  return data.items || [];
}

function formatearFechaEs(iso) {
  if (!iso) return 'sin fecha';
  const d = new Date(iso);
  return d.toLocaleString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
}

async function enviarTelegram(botToken, chatId, texto) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto.slice(0, 4000) }),
    });
  } catch (e) {
    console.error('[ANTONIA-VIGILANCIA] error enviando a Telegram', e.message);
  }
}

// Punto único por el que pasa CUALQUIER novedad detectada: siempre queda
// guardada en antonia_avisos (para que ANTONIA la cuente por voz en el
// próximo "buenos días", aunque esté en modo no molestar), y solo se manda
// también por Telegram si el modo no molestar no está activo ahora mismo.
async function registrarAviso({ supabaseUrl, snapshotHeaders, botToken, allowedId, noMolestar, tipo, mensaje, agenda }) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/antonia_avisos`, {
      method: 'POST',
      headers: { ...snapshotHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ tipo, mensaje, agenda: agenda || null, enviado_telegram: !noMolestar }),
    });
  } catch (e) {
    console.error('[ANTONIA-VIGILANCIA] error guardando aviso', e.message);
  }
  if (!noMolestar) {
    await enviarTelegram(botToken, allowedId, mensaje);
  }
}

exports.handler = async function () {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const allowedId = process.env.ANTONIA_TELEGRAM_ALLOWED_ID;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!botToken || !allowedId || !supabaseUrl || !supabaseKey) {
    console.error('[ANTONIA-VIGILANCIA] faltan variables de entorno obligatorias');
    return { statusCode: 200, body: 'ok' };
  }

  const token = await getGoogleAccessToken();
  if (!token) {
    console.error('[ANTONIA-VIGILANCIA] no se pudo obtener token de Google');
    return { statusCode: 200, body: 'ok' };
  }

  const CALENDARIOS = {
    profesional: process.env.GOOGLE_CALENDAR_ID_PROFESIONAL || process.env.GOOGLE_CALENDAR_ID,
    personal: process.env.GOOGLE_CALENDAR_ID_PERSONAL,
  };

  // ¿Es la primera vez que se ejecuta esto? Si la tabla está vacía del todo,
  // nos limitamos a guardar el estado inicial sin avisar de nada — si no,
  // la primera ejecución avisaría de "cancelado" por cada evento que Google
  // Calendar ya tenía marcado como tal desde antes de existir esta función.
  const snapshotHeaders = authHeaders(supabaseKey);
  let esPrimeraEjecucion = false;
  try {
    const check = await fetch(`${supabaseUrl}/rest/v1/antonia_calendar_snapshot?select=id&limit=1`, { headers: snapshotHeaders });
    if (check.ok) {
      const rows = await check.json();
      esPrimeraEjecucion = rows.length === 0;
    }
  } catch (e) {
    console.error('[ANTONIA-VIGILANCIA] error comprobando si es la primera ejecucion', e.message);
  }

  // Modo "no molestar": si Jose se lo ha pedido a ANTONIA por voz o Telegram,
  // esta función sigue detectando y guardando todo con normalidad, pero no
  // manda nada por Telegram hasta que pase la hora indicada.
  let noMolestar = false;
  try {
    const estadoResp = await fetch(`${supabaseUrl}/rest/v1/antonia_estado?id=eq.global&select=no_molestar_hasta`, { headers: snapshotHeaders });
    if (estadoResp.ok) {
      const [estado] = await estadoResp.json();
      noMolestar = !!(estado?.no_molestar_hasta && new Date(estado.no_molestar_hasta) > new Date());
    }
  } catch (e) {
    console.error('[ANTONIA-VIGILANCIA] error comprobando modo no molestar', e.message);
  }
  const aviso = (tipo, mensaje, agenda) => registrarAviso({ supabaseUrl, snapshotHeaders, botToken, allowedId, noMolestar, tipo, mensaje, agenda });

  for (const [nombreAgenda, calendarId] of Object.entries(CALENDARIOS)) {
    if (!calendarId) continue; // esta agenda no está configurada todavía

    const eventos = await fetchEventosAgenda(token, calendarId);
    if (eventos === null) continue; // fallo puntual, se reintenta en la siguiente ejecución

    // Snapshot anterior de ESTA agenda
    let anteriores = [];
    try {
      const resp = await fetch(
        `${supabaseUrl}/rest/v1/antonia_calendar_snapshot?select=*&calendar=eq.${nombreAgenda}`,
        { headers: snapshotHeaders }
      );
      if (resp.ok) anteriores = await resp.json();
    } catch (e) {
      console.error('[ANTONIA-VIGILANCIA] error leyendo snapshot anterior', nombreAgenda, e.message);
    }
    const anterioresPorId = new Map(anteriores.map((a) => [a.event_id, a]));

    const idsVistosAhora = new Set();
    const upserts = [];

    for (const ev of eventos) {
      idsVistosAhora.add(ev.id);
      const antes = anterioresPorId.get(ev.id);
      const declinedAhora = (ev.attendees || [])
        .filter((a) => a.responseStatus === 'declined')
        .map((a) => a.email || a.displayName || 'un invitado');

      if (!esPrimeraEjecucion) {
        // 1) Cancelación explícita de Google (status "cancelled")
        if (ev.status === 'cancelled' && (!antes || antes.status !== 'cancelled')) {
          await aviso(
            'cancelacion',
            `❌ Se ha cancelado en tu agenda ${nombreAgenda}: "${antes?.summary || ev.summary || '(sin título)'}"` +
            (antes?.start_time ? ` — estaba para el ${formatearFechaEs(antes.start_time)}.` : '.'),
            nombreAgenda
          );
        }
        // 2) Alguien ha rechazado una cita que antes tenía todo confirmado
        if (ev.status !== 'cancelled') {
          const nuevosRechazos = declinedAhora.filter((email) => !(antes?.attendees_declined || []).includes(email));
          if (nuevosRechazos.length && antes) {
            await aviso(
              'rechazo',
              `⚠️ ${nuevosRechazos.join(', ')} ha rechazado la cita "${ev.summary || '(sin título)'}" ` +
              `de tu agenda ${nombreAgenda}, prevista para el ${formatearFechaEs(ev.start?.dateTime || ev.start?.date)}.`,
              nombreAgenda
            );
          }
        }
      }

      upserts.push({
        id: `${nombreAgenda}:${ev.id}`,
        calendar: nombreAgenda,
        event_id: ev.id,
        status: ev.status,
        summary: ev.summary || null,
        start_time: ev.start?.dateTime || ev.start?.date || null,
        attendees_declined: declinedAhora,
        updated_at: new Date().toISOString(),
      });
    }

    // 3) Eventos que estaban en el snapshot anterior y ya ni siquiera
    // aparecen en la respuesta de Google (borrados del todo, no solo
    // marcados como cancelados) — se tratan igual que una cancelación.
    if (!esPrimeraEjecucion) {
      for (const antes of anteriores) {
        if (!idsVistosAhora.has(antes.event_id) && antes.status !== 'cancelled') {
          await aviso(
            'cancelacion',
            `❌ Ha desaparecido de tu agenda ${nombreAgenda}: "${antes.summary || '(sin título)'}"` +
            (antes.start_time ? ` — estaba para el ${formatearFechaEs(antes.start_time)}.` : '.'),
            nombreAgenda
          );
        }
      }
    }

    // Guarda el snapshot nuevo de esta agenda (upsert por id)
    if (upserts.length) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/antonia_calendar_snapshot`, {
          method: 'POST',
          headers: { ...snapshotHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(upserts),
        });
      } catch (e) {
        console.error('[ANTONIA-VIGILANCIA] error guardando snapshot', nombreAgenda, e.message);
      }
    }
    // Limpia del snapshot los eventos que ya no existen, para no arrastrarlos para siempre
    const idsFuera = anteriores.filter((a) => !idsVistosAhora.has(a.event_id)).map((a) => a.id);
    if (idsFuera.length) {
      try {
        await fetch(
          `${supabaseUrl}/rest/v1/antonia_calendar_snapshot?id=in.(${idsFuera.map((id) => `"${id}"`).join(',')})`,
          { method: 'DELETE', headers: snapshotHeaders }
        );
      } catch (e) {
        console.error('[ANTONIA-VIGILANCIA] error limpiando snapshot', nombreAgenda, e.message);
      }
    }
  }

  return { statusCode: 200, body: 'ok' };
};
