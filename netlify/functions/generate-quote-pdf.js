// Genera el PDF de un presupuesto comercial de TRUCO — founder-exclusiva.
// Devuelve el PDF en base64 para que el panel lo descargue o lo adjunte al
// correo (send-quote-email.js). Mismo motor (pdf-lib) que ya usa TruKi para
// sus facturas/presupuestos, pero un documento propio y más simple: no lleva
// numeración legal ni hash, es solo una oferta comercial.
//
// RELLENAR antes de que esto funcione de verdad:
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ya las necesita save-lead.js)

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

function wrapText(text, maxChars) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let current = '';
  for (const w of words) {
    const next = current ? current + ' ' + w : w;
    if (next.length > maxChars) {
      if (current) lines.push(current);
      current = w;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function fmtEur(n) {
  return Number(n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
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

  const quoteId = payload.quote_id ? String(payload.quote_id) : '';
  if (!quoteId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta quote_id' }) };
  }

  try {
    const quoteResp = await fetch(`${supabaseUrl}/rest/v1/quotes?id=eq.${encodeURIComponent(quoteId)}&select=*`, { headers });
    if (!quoteResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    }
    const rows = await quoteResp.json();
    const quote = rows[0];
    if (!quote) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'presupuesto_no_encontrado' }) };
    }

    const pdf = await PDFDocument.create();
    const page = pdf.addPage([595.28, 841.89]); // A4
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const { width } = page.getSize();
    const gold = rgb(0.85, 0.66, 0.24);
    const dark = rgb(0.09, 0.09, 0.13);
    const grey = rgb(0.4, 0.4, 0.45);
    let y = 780;

    page.drawText('TRUCO', { x: 40, y, size: 20, font: fontBold, color: dark });
    page.drawText('technology', { x: 40 + fontBold.widthOfTextAtSize('TRUCO', 20) + 4, y, size: 20, font, color: gold });
    y -= 16;
    page.drawText('Tu Departamento Tecnológico', { x: 40, y, size: 9, font, color: grey });

    page.drawText('PRESUPUESTO', { x: width - 40 - fontBold.widthOfTextAtSize('PRESUPUESTO', 16), y: 780, size: 16, font: fontBold, color: dark });
    const fecha = new Date(quote.created_at || Date.now()).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
    page.drawText(fecha, { x: width - 40 - font.widthOfTextAtSize(fecha, 9), y: 780 - 16, size: 9, font, color: grey });

    y -= 40;
    page.drawLine({ start: { x: 40, y }, end: { x: width - 40, y }, thickness: 1, color: rgb(0.85, 0.85, 0.87) });
    y -= 24;

    page.drawText('Para', { x: 40, y, size: 8, font: fontBold, color: grey });
    y -= 14;
    if (quote.negocio) { page.drawText(quote.negocio, { x: 40, y, size: 11, font: fontBold, color: dark }); y -= 14; }
    if (quote.nombre_contacto) { page.drawText(quote.nombre_contacto, { x: 40, y, size: 10, font, color: dark }); y -= 13; }
    if (quote.email_contacto) { page.drawText(quote.email_contacto, { x: 40, y, size: 9, font, color: grey }); y -= 12; }
    if (quote.telefono) { page.drawText(quote.telefono, { x: 40, y, size: 9, font, color: grey }); y -= 12; }

    y -= 20;
    page.drawText('DESCRIPCIÓN', { x: 40, y, size: 8, font: fontBold, color: grey });
    page.drawText('PRECIO', { x: width - 40 - 60, y, size: 8, font: fontBold, color: grey });
    y -= 10;
    page.drawLine({ start: { x: 40, y }, end: { x: width - 40, y }, thickness: 1, color: rgb(0.85, 0.85, 0.87) });
    y -= 18;

    const lineas = Array.isArray(quote.lineas) ? quote.lineas : [];
    for (const linea of lineas) {
      const desc = wrapText(linea.descripcion || '', 70);
      for (const l of desc) {
        page.drawText(l, { x: 40, y, size: 10, font, color: dark });
        y -= 13;
      }
      const precioTexto = linea.precio ? (linea.es_desde ? 'desde ' : '') + fmtEur(linea.precio) : 'A consultar';
      page.drawText(precioTexto, { x: width - 40 - font.widthOfTextAtSize(precioTexto, 10), y: y + 13, size: 10, font, color: dark });
      y -= 8;
      if (y < 100) { y = 780; pdf.addPage([595.28, 841.89]); }
    }

    y -= 12;
    page.drawLine({ start: { x: 40, y }, end: { x: width - 40, y }, thickness: 1, color: rgb(0.85, 0.85, 0.87) });
    y -= 22;
    const totalTexto = 'Total estimado: ' + fmtEur(quote.total_estimado);
    page.drawText(totalTexto, { x: width - 40 - fontBold.widthOfTextAtSize(totalTexto, 12), y, size: 12, font: fontBold, color: dark });

    y -= 40;
    const notaLineas = wrapText(
      (quote.notas ? quote.notas + ' ' : '') +
      'Presupuesto orientativo, válido 30 días desde la fecha de emisión. Los importes marcados como "desde" pueden variar según el alcance final acordado.',
      95
    );
    for (const l of notaLineas) {
      page.drawText(l, { x: 40, y, size: 8, font, color: grey });
      y -= 11;
    }

    const pdfBytes = await pdf.save();
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

    return { statusCode: 200, body: JSON.stringify({ ok: true, pdf_base64: pdfBase64 }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception', message: e.message }) };
  }
};
