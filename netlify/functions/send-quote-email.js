// Envía un presupuesto (PDF adjunto) por correo al contacto — founder-
// exclusiva. Mismo patrón que truki-send-email.js: SMTP genérico vía
// nodemailer, no atado a ningún proveedor concreto.
//
// RELLENAR antes de que esto funcione de verdad:
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ya las necesita save-lead.js)
//   - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (opcional) — el
//     sitio principal no tiene esto configurado todavía (es distinto del SMTP
//     de cada instancia de TruKi); hace falta darlo de alta la primera vez
//     que se quiera mandar un presupuesto por email.
//
// El enlace de pago de Stripe puede superar los 200-300 caracteres. Mandado
// como texto plano puro, muchos clientes de correo (y el propio protocolo
// SMTP, que envuelve líneas largas de texto plano en ~76 caracteres) parten
// esa URL en dos líneas — al pulsarla o copiarla queda cortada o con un
// salto de línea en medio, es decir, corrompida. La solución no es acortar
// la URL (la genera Stripe, no la controlamos) sino no mandarla nunca como
// texto plano suelto: aquí va dentro de un botón real <a href="..."> en la
// versión HTML del correo, que no sufre ese envoltorio de línea porque el
// href es un atributo, no texto que se vaya a partir visualmente.
const nodemailer = require('nodemailer');

function escapeHtmlEmail(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!supabaseUrl || !serviceKey || !SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  const headers = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const userToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  let authorized = false;
  if (userToken) {
    try {
      const verifyResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${userToken}` }
      });
      if (verifyResp.ok) {
        const authUser = await verifyResp.json();
        if (authUser && authUser.id) {
          const roleResp = await fetch(
            `${supabaseUrl}/rest/v1/staff_roles?user_id=eq.${encodeURIComponent(authUser.id)}&select=role`,
            { headers }
          );
          if (roleResp.ok) {
            const roleRows = await roleResp.json();
            authorized = Array.isArray(roleRows) && roleRows.some(r => r.role === 'founder');
          }
        }
      }
    } catch (e) {
      // authorized se queda en false
    }
  }
  if (!authorized) {
    return { statusCode: 403, body: JSON.stringify({ error: 'No autorizado' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const destinatario = (payload.destinatario || '').trim();
  const adjuntoBase64 = payload.pdf_base64;
  const asunto = (payload.asunto || 'Presupuesto — TRUCO technology').slice(0, 200);
  const mensaje = (payload.mensaje || 'Adjunto el presupuesto solicitado. Cualquier duda, respondemos encantados.').slice(0, 2000);
  const enlacePago = payload.enlace_pago ? String(payload.enlace_pago).slice(0, 500) : '';
  if (!destinatario || !adjuntoBase64) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta destinatario o el PDF' }) };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 587,
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });

    const textoFinal = mensaje + (enlacePago ? `\n\nPara aceptarlo y pagar de forma segura, copia y pega este enlace en tu navegador:\n${enlacePago}` : '');

    const botonPago = enlacePago ? `
      <div style="margin:26px 0;text-align:center;">
        <a href="${enlacePago}" style="background:#d9a83f;color:#11162a;text-decoration:none;font-weight:700;font-size:15px;padding:14px 30px;border-radius:8px;display:inline-block;">Aceptar y pagar de forma segura →</a>
      </div>
      <p style="color:#8a8a8a;font-size:12px;line-height:1.5;">Si el botón no funciona, copia y pega este enlace en tu navegador:<br><a href="${enlacePago}" style="color:#2f7bff;word-break:break-all;">${enlacePago}</a></p>
    ` : '';

    const htmlFinal = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;">
        <div style="background:#11162a;padding:22px 28px;border-radius:10px 10px 0 0;">
          <span style="color:#ffffff;font-size:19px;font-weight:700;">TRUCO<span style="color:#d9a83f;">technology</span></span>
        </div>
        <div style="background:#ffffff;border:1px solid #e5e5e5;border-top:none;padding:28px;border-radius:0 0 10px 10px;">
          <p style="white-space:pre-line;line-height:1.65;font-size:15px;color:#1a1a1a;margin:0;">${escapeHtmlEmail(mensaje)}</p>
          ${botonPago}
          <p style="color:#9a9a9a;font-size:12px;margin-top:26px;margin-bottom:0;">TRUCO technology — Tu Departamento Tecnológico</p>
        </div>
      </div>
    `;

    await transporter.sendMail({
      from: SMTP_FROM || SMTP_USER,
      to: destinatario,
      subject: asunto,
      text: textoFinal,
      html: htmlFinal,
      attachments: [{
        filename: 'presupuesto-truco.pdf',
        content: Buffer.from(adjuntoBase64, 'base64'),
        contentType: 'application/pdf'
      }]
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'send_error' }) };
  }
};
