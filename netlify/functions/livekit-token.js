const { AccessToken } = require('livekit-server-sdk');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !livekitUrl) {
    return { statusCode: 200, body: JSON.stringify({ error: 'LiveKit no configurado' }) };
  }

  const roomName = 'truco-agent-' + Math.random().toString(36).slice(2, 10);
  const identity = 'visitante-' + Math.random().toString(36).slice(2, 8);

  const at = new AccessToken(apiKey, apiSecret, { identity, ttl: '10m' });
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });

  const token = await at.toJwt();

  return {
    statusCode: 200,
    body: JSON.stringify({ token, url: livekitUrl, room: roomName }),
  };
};
