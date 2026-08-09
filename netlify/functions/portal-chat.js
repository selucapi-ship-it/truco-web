// Asistente de IA del portal de clientes — a diferencia de chat-ai.js (el bot
// genérico de ventas de la web pública), este conoce los datos reales del
// cliente que ha iniciado sesión: qué tiene contratado y su historial de
// conversaciones anteriores en el propio portal. Nunca confía en un client_id
// que mande el navegador: siempre verifica el token de sesión contra Supabase
// primero y busca la ficha del cliente a partir de ahí.
//
// RELLENAR antes de que esto funcione de verdad:
//   - GEMINI_API_KEY (ya la necesita chat-ai.js)
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ya las necesita save-lead.js)
//
// El bloque de precios/condiciones de aquí abajo es una copia deliberada del
// mismo bloque en chat-ai.js — este proyecto ya mantiene copias independientes
// en chat-ai.js, agent.py, index.html y pago.html; si cambia algo de precios o
// condiciones, cambiar en las 5 a la vez.
const CATALOG_TEXT = `DATOS REALES DE TRUCO technology (no inventes nada fuera de esto; si no lo sabes, dilo):

QUÉ ES: Departamento Tecnológico externalizado para pymes y autónomos en España. Hay dos formas de entrar:
1) Departamento Tecnológico (Basic™/Lite™/Pro™): cliente directo, con permanencia, web y soluciones completamente gratis.
2) Proyecto sin compromiso (Web Esencial, Web Profesional, Digitaliza tu Empresa): se compra suelto, pagando su precio, sin permanencia.

── DEPARTAMENTO TECNOLÓGICO ──
- Basic™: 69€/mes + IVA. Permanencia mínima 6 meses. Sin web. 1 solución gratis (pool: WhatsApp, IA Web, IA Llamadas, IA Correo, Reservas, Firma Digital, Ciberseguridad Pyme, Automatizaciones banda Simple, TruKi — único escalón con TruKi gratis). Mantiene hasta 2 soluciones en total.
- Lite™: 279€/mes + IVA (o precio de fundador si sigue activa la oferta). Permanencia 12 meses. Web + 2 soluciones gratis (pool: WhatsApp, IA Web, Llamadas, Correo, Reservas, Firma Digital, Ciberseguridad Pyme, Automatizaciones solo banda Simple 350€). TruKi NO entra en este pool, solo en Basic™. Mantiene hasta 3 soluciones en total. Reunión mensual 30 min.
- Pro™: 549€/mes + IVA (o precio de fundador si sigue activa la oferta). Permanencia 12 meses. Web Profesional + 3 soluciones gratis del mismo pool de 8. Mantiene hasta 6 soluciones en total. Reunión mensual 45 min, mayor prioridad en incidencias.
- Pago: solo pago único con 12% de descuento, o financiado con SeQura. Nunca facturación mensual directa.

── SOLUCIONES INDIVIDUALES DE DIGITALIZA (+ IVA) ──
IA para WhatsApp 590€ · IA para Web 350€ · IA para Correo 350€ · IA para Llamadas 690€ (150 llamadas/mes incluidas, exceso 0,50€ + IVA) · Reservas online 350€ · Facturación automática (TruKi) 580€ (+29€/mes de hosting si se contrata suelta, sin Departamento) · Gestión documental desde 400€ · Ciberseguridad Pyme 450€ (hasta 5 puestos, +150€ por cada 5 adicionales) · Firma digital 500€ · Integraciones desde 600€ · Automatizaciones 350/650/1.200€ según complejidad · CRM desde 950€.

CONDICIONES GENERALES:
- Garantía de Ajuste TRUCO™: se ajusta lo que haga falta sin coste durante la implantación. Incidencias técnicas siempre sin coste.
- Límite de uso IA (WhatsApp/Web/Correo): 1.000 interacciones/mes por solución, exceso 0,02€ + IVA/interacción.
- Dominio y hosting siempre a nombre y coste del cliente.
- Auditoría de servicios: reunión de revisión de lo contratado, se agenda desde el propio panel del portal.`;

function buildSystemInstruction(client, solutions) {
  const nombre = client.nombre || 'este cliente';
  const negocio = client.negocio ? ` (${client.negocio})` : '';
  const plan = client.plan_key || 'sin plan registrado';
  const solLines = solutions.length
    ? solutions.map(s => `- ${s.solution_name}${s.is_free ? ' (incluida gratis en su plan)' : ''}`).join('\n')
    : '(ninguna solución de Digitaliza registrada todavía)';

  return `Eres el asistente del Portal de Clientes de TRUCO technology, hablando en privado con un cliente real ya identificado — no un visitante anónimo de la web. Respondes en español, cercano, profesional, como alguien del propio departamento tecnológico que ya conoce a este cliente. Nunca actúes como si no supieras quién es.

DATOS DE ESTE CLIENTE (úsalos para personalizar tu respuesta, no los repitas literalmente salvo que pregunte por ellos):
- Nombre: ${nombre}${negocio}
- Plan contratado: ${plan}
- Soluciones activas:
${solLines}

${CATALOG_TEXT}

REGLAS DE RESPUESTA:
1. Responde solo con datos reales de arriba. Nunca inventes precios, plazos o garantías.
2. Sé breve pero completo — 3-4 frases o un par de puntos clave, no un documento.
3. Si pregunta por soluciones que NO tiene contratadas, puedes mencionar el precio del catálogo, pero deja claro que para contratarla debe ir a digitaliza.html o pago.html — tú no gestionas compras desde aquí.
4. Si quiere agendar una revisión/auditoría de sus servicios, dile que use el botón "Agendar una auditoría" del propio panel.
5. Si la pregunta es genuinamente imposible de responder con esta información (asesoría legal/fiscal personalizada, algo fuera de TRUCO), responde EXACTAMENTE empezando con "[NO_SE_RESPONDER]" seguido de una frase breve. No uses ese texto en ningún otro caso.`;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!apiKey || !supabaseUrl || !serviceKey) {
    return { statusCode: 200, body: JSON.stringify({ text: '', unresolved: true, reason: 'not_configured' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const userToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!userToken) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Falta sesión' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const message = (payload.message || '').trim();
  const history = Array.isArray(payload.history) ? payload.history.slice(-10) : [];
  if (!message) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing message' }) };
  }

  // apikey siempre es la clave del proyecto (service role vale, tiene más
  // privilegio del necesario pero es válida); Authorization es el token de
  // sesión del propio cliente, el que estamos verificando — nunca la clave
  // de servicio, con independencia del formato de clave del proyecto.
  const verifyResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${userToken}` },
  }).catch(() => null);
  if (!verifyResp || !verifyResp.ok) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Sesión inválida' }) };
  }
  const authUser = await verifyResp.json();
  const authUserId = authUser && authUser.id;
  if (!authUserId) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Sesión inválida' }) };
  }

  const serviceHeaders = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    serviceHeaders.Authorization = `Bearer ${serviceKey}`;
  }

  try {
    const clientResp = await fetch(
      `${supabaseUrl}/rest/v1/clients?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=*`,
      { headers: serviceHeaders }
    );
    const clients = clientResp.ok ? await clientResp.json() : [];
    const client = clients[0];
    if (!client) {
      return { statusCode: 200, body: JSON.stringify({ text: '', unresolved: true, reason: 'client_not_found' }) };
    }

    const [solsResp, historyResp] = await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/client_solutions?client_id=eq.${client.id}&select=*`, { headers: serviceHeaders }),
      fetch(
        `${supabaseUrl}/rest/v1/interactions?client_id=eq.${client.id}&source=eq.portal&nota=not.is.null&order=created_at.desc&limit=6&select=nota,created_at`,
        { headers: serviceHeaders }
      ),
    ]);
    const solutions = solsResp.ok ? await solsResp.json() : [];
    const recentPortalHistory = historyResp.ok ? await historyResp.json() : [];

    const systemInstruction = buildSystemInstruction(client, solutions);

    // El historial reciente del portal se manda como turnos de conversación
    // pasados para que la IA "recuerde" — mismo patrón que whatsapp_recent_history.
    const memoryContents = recentPortalHistory
      .slice()
      .reverse()
      .flatMap(h => {
        const parts = String(h.nota || '').split('\n---\n');
        return parts.length === 2
          ? [{ role: 'user', parts: [{ text: parts[0].slice(0, 800) }] }, { role: 'model', parts: [{ text: parts[1].slice(0, 800) }] }]
          : [];
      });

    const contents = [
      ...memoryContents,
      ...history.map(h => ({ role: h.role === 'bot' ? 'model' : 'user', parts: [{ text: String(h.text || '').slice(0, 1000) }] })),
      { role: 'user', parts: [{ text: message.slice(0, 1000) }] },
    ];

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents,
          generationConfig: { temperature: 0.6, maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );

    if (!resp.ok) {
      return { statusCode: 200, body: JSON.stringify({ text: '', unresolved: true, reason: 'api_error' }) };
    }
    const data = await resp.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    if (!rawText) {
      return { statusCode: 200, body: JSON.stringify({ text: '', unresolved: true, reason: 'empty_response' }) };
    }

    const finalText = rawText.replace('[NO_SE_RESPONDER]', '').trim();
    const unresolved = rawText.includes('[NO_SE_RESPONDER]');

    // Registramos el intercambio como una única interacción (pregunta + respuesta
    // separadas por '\n---\n') para poder reconstruir turnos de conversación la
    // próxima vez, igual que hace el separador anterior al leerlo.
    fetch(`${supabaseUrl}/rest/v1/interactions`, {
      method: 'POST',
      headers: { ...serviceHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ client_id: client.id, source: 'portal', nota: `${message.slice(0, 800)}\n---\n${finalText.slice(0, 800)}` }),
    }).catch(() => {});

    return { statusCode: 200, body: JSON.stringify({ text: finalText, unresolved }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ text: '', unresolved: true, reason: 'exception' }) };
  }
};
