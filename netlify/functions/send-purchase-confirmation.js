// Manda al cliente el email de confirmación justo tras un pago confirmado —
// llamada server-a-server desde stripe-webhook.js, paypal-capture-order.js y
// confirm-bank-transfer.js (mismo patrón best-effort que la llamada a
// invite-client.js justo al lado: si esto falla, el pago y el alta en el CRM
// ya están bien, solo se pierde este correo concreto).
//
// Por qué existe: el artículo 23 de la LSSI-CE exige confirmar la aceptación
// del contrato "por correo electrónico u otro medio de comunicación
// electrónica equivalente... en el plazo de las 24 horas siguientes", y la
// Ley 7/1998 de condiciones generales exige que el adherente pueda
// demostrarse que se le facilitó un ejemplar de lo aceptado. Sin este correo,
// el checkbox del Anexo de Autorización de Accesos en pago.html quedaba
// registrado en Supabase pero el cliente nunca recibía su copia — este envío
// (automático, instantáneo) es lo que cierra ese requisito legal.
//
// RELLENAR: reutiliza las mismas SMTP_HOST/PORT/USER/PASS/FROM que ya usa
// send-quote-email.js — nada nuevo que configurar en Netlify.

const nodemailer = require('nodemailer');

function escapeHtmlEmail(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

const CANONICAL_SITE_URL = 'https://trucotechnology.com';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const email = payload.email ? String(payload.email).trim().slice(0, 200) : '';
  const nombre = payload.nombre ? String(payload.nombre).slice(0, 200) : '';
  const planName = payload.planName ? String(payload.planName).slice(0, 200) : 'tu Departamento Tecnológico';
  const amountTotalCents = Number.isFinite(Number(payload.amountTotalCents)) ? Number(payload.amountTotalCents) : null;
  const anexoVersion = payload.anexoVersion ? String(payload.anexoVersion).slice(0, 20) : '';
  const provider = payload.provider ? String(payload.provider).slice(0, 20) : '';
  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta el email' }) };
  }

  const importe = amountTotalCents !== null ? (amountTotalCents / 100).toFixed(2).replace('.', ',') + ' €' : null;
  const metodoPago = { stripe: 'tarjeta (Stripe)', paypal: 'PayPal', transfer: 'transferencia bancaria' }[provider] || 'el método elegido';
  const anexoUrl = `${CANONICAL_SITE_URL}/autorizacion-accesos.html`;
  const portalUrl = `${CANONICAL_SITE_URL}/portal/login.html`;

  try {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 587,
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    const saludo = nombre ? `Hola ${escapeHtmlEmail(nombre)},` : 'Hola,';
    const lineaImporte = importe ? `<li>Importe cobrado: <b>${importe}</b>, vía ${metodoPago}</li>` : '';
    const lineaAnexo = anexoVersion
      ? `<li>Aceptaste el <a href="${anexoUrl}" style="color:#2f7bff;">Anexo de Autorización de Accesos y Tratamiento de Datos</a> (versión ${escapeHtmlEmail(anexoVersion)}) en el momento del pago — puedes consultarlo cuando quieras en ese enlace.</li>`
      : '';

    const htmlFinal = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;">
        <div style="background:#16151a;padding:22px 28px;border-radius:10px 10px 0 0;">
          <span style="color:#ffffff;font-size:19px;font-weight:700;">TRUCO<span style="color:#d9a83f;">technology</span></span>
        </div>
        <div style="background:#ffffff;border:1px solid #e5e5e5;border-top:none;padding:28px;border-radius:0 0 10px 10px;">
          <p style="line-height:1.65;font-size:15px;color:#1a1a1a;margin:0 0 14px;">${saludo}</p>
          <p style="line-height:1.65;font-size:15px;color:#1a1a1a;margin:0 0 14px;">Confirmamos tu contratación de <b>${escapeHtmlEmail(planName)}</b>. Este correo es tu acuse de recibo:</p>
          <ul style="line-height:1.7;font-size:14px;color:#1a1a1a;padding-left:20px;margin:0 0 18px;">
            ${lineaImporte}
            ${lineaAnexo}
          </ul>
          <div style="margin:24px 0;text-align:center;">
            <a href="${portalUrl}" style="background:#2f7bff;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 30px;border-radius:8px;display:inline-block;">Entrar a tu portal de cliente →</a>
          </div>
          <p style="color:#9a9a9a;font-size:12px;line-height:1.5;margin:0;">Nos ponemos en contacto en un máximo de 48 horas hábiles para empezar. Cualquier duda, responde a este correo.</p>
          <p style="color:#9a9a9a;font-size:12px;margin-top:22px;margin-bottom:0;">TRUCO technology — Tu Departamento Tecnológico</p>
        </div>
      </div>
    `;

    const textoFinal = `${nombre ? 'Hola ' + nombre : 'Hola'},\n\nConfirmamos tu contratación de ${planName}.` +
      (importe ? `\nImporte cobrado: ${importe} (${metodoPago}).` : '') +
      (anexoVersion ? `\nAceptaste el Anexo de Autorización de Accesos y Tratamiento de Datos (versión ${anexoVersion}): ${anexoUrl}` : '') +
      `\n\nEntra a tu portal: ${portalUrl}\n\nNos ponemos en contacto en un máximo de 48 horas hábiles.\n\nTRUCO technology`;

    await transporter.sendMail({
      from: SMTP_FROM || SMTP_USER,
      to: email,
      subject: `Confirmación de tu contratación — ${planName}`,
      text: textoFinal,
      html: htmlFinal,
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'send_error', message: e.message }) };
  }
};
