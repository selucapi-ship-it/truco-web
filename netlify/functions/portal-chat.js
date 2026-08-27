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

QUÉ ES: Departamento Tecnológico externalizado para pymes y autónomos en España — es lo único que vendemos. Hay 4 escalones (Start™, Basic™, Lite™ y Pro™): en los 4, el primer año va pagado por adelantado (de una vez o con SeQura) y eso es lo que permite que la web/automatizaciones vayan instaladas completamente gratis. Start™ es el punto de entrada, solo automatización, sin web. Basic™, Lite™ y Pro™ ya incluyen web, con un número creciente de automatizaciones gratis. No existe ninguna vía de compra suelta — Web Esencial ya no existe como opción, y Web Profesional y Digitaliza tu Empresa son hoy solo páginas informativas, no productos aparte.

── LOS 4 DEPARTAMENTOS ──
- Start™ (el punto de entrada): 89€/mes + IVA estándar (precio de fundador 69€/mes + IVA para los 10 primeros clientes, si sigue activa la oferta y quedan plazas). Sin web. 1 automatización gratis (pool: WhatsApp, IA Web, IA Correo, Reservas, TruKi). Firma Digital no entra en el pool gratis pero SÍ se puede añadir pagando. IA Llamadas, Ciberseguridad Pyme y Flujos automáticos a medida NO están disponibles en Start™ de ninguna forma, ni pagando — exclusivas desde Lite™ en adelante. Mantiene hasta 2 automatizaciones en total.
- Basic™: 169€/mes + IVA estándar (precio de fundador 149€/mes + IVA para los 10 primeros clientes, si sigue activa la oferta y quedan plazas). Web Profesional que ya incluye de fábrica chat + agenda de citas, igual que Pro™, + 1 automatización gratis más (pool: WhatsApp, IA Correo, TruKi — IA Web y Reservas no entran porque ya vienen incluidas en la web). Firma Digital se puede añadir pagando. Igual que en Start™: IA Llamadas, Ciberseguridad Pyme y Flujos automáticos a medida NO disponibles, ni pagando. Mantiene hasta 2 automatizaciones en total.
- Lite™: 279€/mes + IVA estándar (precio de fundador 229€/mes + IVA si sigue activa la oferta y quedan plazas — sin cambio respecto a antes). Web: la del cliente reacondicionada, o una Web Profesional nueva si no tiene ninguna (ya no existe Web Esencial). + 2 automatizaciones gratis (pool de 7: WhatsApp, IA Correo, Reservas, TruKi, IA Llamadas —exclusiva desde Lite™ en adelante, ya no está en Start™ ni Basic™, ni pagando—, Firma Digital, IA Web). Mantiene hasta 3 automatizaciones en total. Reunión mensual 30 min.
- Pro™: 549€/mes + IVA estándar (precio de fundador 449€/mes + IVA si sigue activa la oferta y quedan plazas — sin cambio respecto a antes). Web Profesional que ya incluye de fábrica chat + agenda de citas (por eso IA para tu Web y Reservas no están en su pool de elegir, ya las tiene gratis) + 3 automatizaciones gratis a elegir de un pool de 6 (WhatsApp, Llamadas, Correo, Firma Digital, Ciberseguridad, Flujos automáticos a medida (banda Simple)). Mantiene hasta 6 automatizaciones en total. Reunión mensual 45 min, mayor prioridad en incidencias.
- IMPORTANTE: IA Llamadas, Ciberseguridad Pyme, Flujos automáticos a medida, CRM, Integraciones y Gestión documental SOLO se pueden tener desde Lite™ en adelante — en Start™ y Basic™ no están disponibles ni pagando el precio de catálogo completo. Ciberseguridad Pyme y Flujos automáticos a medida además SOLO son gratis en Pro™ (en Lite™ se pagan aparte si no están en el pool elegido). TruKi no tiene esta restricción — está en el pool gratis de Start™, Basic™ y Lite™, y disponible pagando en Pro™.
- La oferta de fundador (cuando esté activa) puede aplicar a cualquiera de los 4 escalones, cada uno con su propio cupo — no sabes si sigue activa ni cuántas plazas quedan en cada uno, cambia en tiempo real.
- Pago: solo pago único con 12% de descuento, o financiado con SeQura. Nunca facturación mensual directa.
- Al terminar el primer año: el cliente sigue mes a mes si quiere, sin más compromiso, o se lo lleva todo — incluido el código fuente de su web, en un pen drive personalizado.

── AUTOMATIZACIONES INDIVIDUALES (+ IVA, se instalan siempre dentro de un Departamento, nunca sueltas) ──
IA para WhatsApp 590€ (agenda citas en el calendario) · IA para Web 350€ (agenda citas en el calendario, igual que WhatsApp) · IA para Correo 350€ · IA para Llamadas 690€ (Oferta Lanzamiento 2026, precio normal 890€ — 150 llamadas/mes incluidas, exceso 0,50€ + IVA) · Reservas online 350€ (botón de reserva directa; se combina con WhatsApp/Web/Llamadas o funciona sola) · Facturación automática (TruKi) 580€ (+29€/mes de hosting si se contrata suelta, sin Departamento) · Gestión documental desde 400€ · Ciberseguridad Pyme 450€ (hasta 5 puestos, +150€ por cada 5 adicionales) · Firma digital 500€ · Integraciones desde 600€ · Flujos automáticos a medida 350/650/1.200€ según complejidad · CRM desde 950€.

CONDICIONES GENERALES:
- Garantía de Ajuste TRUCO™: se ajusta lo que haga falta sin coste durante la implantación. Incidencias técnicas siempre sin coste.
- Límite de uso IA (WhatsApp/Web/Correo): 1.000 interacciones/mes por automatización, exceso 0,02€ + IVA/interacción.
- Dominio y hosting siempre a nombre y coste del cliente.
- Auditoría de servicios: reunión de revisión de lo contratado, se agenda desde el propio panel del portal.`;

function buildSystemInstruction(client, solutions) {
  const nombre = client.nombre || 'este cliente';
  const negocio = client.negocio ? ` (${client.negocio})` : '';
  const plan = client.plan_key || 'sin plan registrado';
  const solLines = solutions.length
    ? solutions.map(s => `- ${s.solution_name}${s.is_free ? ' (incluida gratis en su plan)' : ''}`).join('\n')
    : '(ninguna automatización registrada todavía)';

  return `Eres el asistente del Portal de Clientes de TRUCO technology, hablando en privado con un cliente real ya identificado — no un visitante anónimo de la web. Respondes en español, cercano, profesional, como alguien del propio departamento tecnológico que ya conoce a este cliente. Nunca actúes como si no supieras quién es.

DATOS DE ESTE CLIENTE (úsalos para personalizar tu respuesta, no los repitas literalmente salvo que pregunte por ellos):
- Nombre: ${nombre}${negocio}
- Plan contratado: ${plan}
- Automatizaciones activas:
${solLines}

${CATALOG_TEXT}

REGLAS DE RESPUESTA:
1. Responde solo con datos reales de arriba. Nunca inventes precios, plazos o garantías.
2. Sé breve pero completo — 3-4 frases o un par de puntos clave, no un documento.
3. Si pregunta por automatizaciones que NO tiene contratadas, puedes mencionar el precio del catálogo, pero deja claro que para contratarla debe ir a digitaliza.html o pago.html — tú no gestionas compras desde aquí.
4. Si quiere agendar una revisión/auditoría de sus servicios, dile que use el botón "Agendar una auditoría" del propio panel.
5. Si la pregunta es algo genuinamente fuera del ámbito de TRUCO — charla casual, opinión personal, cultura general, insultos, bromas, o cualquier tema sin relación con su negocio o sus servicios — responde EXACTAMENTE empezando con "[FUERA_DE_TEMA]" seguido de una frase breve y respetuosa tipo "Lo siento, pero ese tema no corresponde a TRUCOtechnology", sin ofrecer nada más y sin invitar a agendar nada.
6. Si la pregunta SÍ es sobre su negocio o sus servicios pero es genuinamente imposible de responder con esta información (asesoría legal/fiscal muy personalizada, un caso demasiado específico), responde EXACTAMENTE empezando con "[NO_SE_RESPONDER]" seguido de una frase breve y amable, invitando siempre a agendar una revisión con el equipo para resolverlo ahí — nunca dejes la respuesta en un simple "no puedo ayudarte". No uses ninguno de estos dos textos en ningún otro caso.`;
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

    const isOffTopic = rawText.includes('[FUERA_DE_TEMA]');
    const isUnanswerable = rawText.includes('[NO_SE_RESPONDER]');
    const finalText = rawText.replace('[FUERA_DE_TEMA]', '').replace('[NO_SE_RESPONDER]', '').trim();
    const unresolved = isOffTopic || isUnanswerable;
    const reason = isOffTopic ? 'off_topic' : (isUnanswerable ? 'ai_could_not_answer' : undefined);

    // Registramos el intercambio como una única interacción (pregunta + respuesta
    // separadas por '\n---\n') para poder reconstruir turnos de conversación la
    // próxima vez, igual que hace el separador anterior al leerlo.
    fetch(`${supabaseUrl}/rest/v1/interactions`, {
      method: 'POST',
      headers: { ...serviceHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({ client_id: client.id, source: 'portal', nota: `${message.slice(0, 800)}\n---\n${finalText.slice(0, 800)}` }),
    }).catch(() => {});

    return { statusCode: 200, body: JSON.stringify({ text: finalText, unresolved, reason }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ text: '', unresolved: true, reason: 'exception' }) };
  }
};
