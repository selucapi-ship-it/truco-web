// Guarda la conversación completa del chat de la web (lo que pregunta el
// visitante y lo que se le contesta), con su nombre y su IP, para poder
// revisarla en el panel. La IP se toma de la cabecera de Netlify, nunca del
// cuerpo de la petición.
const { getClientIp, getUserAgent, rpc, notifyTelegram } = require('./lib/chat-guard');

// Los mensajes del bot llevan etiquetas HTML propias (<b>, <a>) que en el panel
// se leerían como ruido: se quitan. Lo que escribe el visitante se guarda tal
// cual (puede ser un intento de inyección que interesa ver); el panel siempre
// lo muestra escapado.
function cleanText(t, isBot) {
  let s = String(t || '');
  if (isBot) s = s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  return s.trim().slice(0, 2000);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const sessionId = String(payload.session_id || '').trim().slice(0, 100);
  if (!sessionId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing session_id' }) };

  const msgs = (Array.isArray(payload.messages) ? payload.messages : []).slice(0, 12)
    .map(m => ({
      role: m && m.role === 'user' ? 'user' : 'bot',
      text: cleanText(m && m.text, !(m && m.role === 'user')),
      via: ['ai', 'local', 'sistema'].includes(m && m.via) ? m.via : 'local'
    }))
    .filter(m => m.text);
  if (!msgs.length) return { statusCode: 200, body: JSON.stringify({ ok: true, added: 0 }) };

  const nombre = payload.nombre ? String(payload.nombre).slice(0, 60) : null;

  const out = await rpc('chat_log_messages', {
    p_session: sessionId,
    p_ip: getClientIp(event),
    p_ua: getUserAgent(event),
    p_nombre: nombre,
    p_msgs: msgs
  });

  if (out && out.alert_similar) {
    await notifyTelegram(`⚠️ Chat web: alguien con una IP parecida a una que bloqueaste acaba de escribir.\nNombre: ${nombre || 'sin nombre'}\nIP: ${out.ip || '?'}\nRevísalo en el panel → Conversaciones del chat.`);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: !!out }) };
};
