// Utilidades compartidas por las funciones del chat: IP del visitante, llamadas
// a las funciones SQL de control de abuso (service_role) y aviso por Telegram.
const SUPABASE_URL = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';

function getClientIp(event) {
  const h = event.headers || {};
  const direct = h['x-nf-client-connection-ip'] || h['client-ip'];
  if (direct) return String(direct).trim().slice(0, 64);
  const fwd = h['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim().slice(0, 64);
  return null;
}

function getUserAgent(event) {
  const h = event.headers || {};
  return String(h['user-agent'] || '').slice(0, 300) || null;
}

async function rpc(name, args) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return null;
  const headers = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST', headers, body: JSON.stringify(args)
    });
    if (!resp.ok) {
      console.error('[chat-guard] rpc', name, resp.status);
      return null;
    }
    return await resp.json();
  } catch (e) {
    console.error('[chat-guard] rpc', name, e && e.message);
    return null;
  }
}

async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ANTONIA_TELEGRAM_ALLOWED_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3500) })
    });
  } catch (e) { /* un aviso fallido nunca debe romper el chat */ }
}

module.exports = { getClientIp, getUserAgent, rpc, notifyTelegram };
