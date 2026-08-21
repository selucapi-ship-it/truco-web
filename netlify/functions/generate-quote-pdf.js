// Genera el PDF de un presupuesto comercial de TRUCO — founder-exclusiva.
// Devuelve el PDF en base64 para que el panel lo descargue, lo previsualice
// o lo adjunte al correo (send-quote-email.js). Documento propio, con la
// misma paleta de marca que el resto del sitio (fondo marino oscuro + dorado)
// — no lleva numeración legal ni hash como las facturas de TruKi, es una
// oferta comercial.
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

    // ── Paleta de marca (misma que el resto del sitio: marino oscuro + dorado) ──
    const navy = rgb(0.067, 0.086, 0.165);       // #11162a
    const navyLight = rgb(0.102, 0.129, 0.251);  // banda inferior del header
    const gold = rgb(0.878, 0.663, 0.290);       // #e0a94a
    const dark = rgb(0.09, 0.09, 0.13);
    const grey = rgb(0.42, 0.43, 0.48);
    const greyLine = rgb(0.89, 0.89, 0.91);
    const rowAlt = rgb(0.965, 0.96, 0.94);
    const white = rgb(1, 1, 1);

    const pdf = await PDFDocument.create();
    let page = pdf.addPage([595.28, 841.89]); // A4
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const { width, height } = page.getSize();

    // ── Cabecera de marca ──
    const headerH = 108;
    page.drawRectangle({ x: 0, y: height - headerH, width, height: headerH, color: navy });
    page.drawRectangle({ x: 0, y: height - headerH, width, height: 4, color: gold });

    page.drawText('TRUCO', { x: 40, y: height - 46, size: 22, font: fontBold, color: white });
    page.drawText('technology', { x: 40 + fontBold.widthOfTextAtSize('TRUCO', 22) + 5, y: height - 46, size: 22, font, color: gold });
    page.drawText('Tu Departamento Tecnológico', { x: 40, y: height - 66, size: 9, font, color: rgb(0.7, 0.72, 0.8) });

    const numeroTexto = 'P' + String(quote.numero).padStart(4, '0');
    page.drawText(numeroTexto, { x: width - 40 - fontBold.widthOfTextAtSize(numeroTexto, 20), y: height - 44, size: 20, font: fontBold, color: gold });
    const etiquetaTexto = 'PRESUPUESTO';
    page.drawText(etiquetaTexto, { x: width - 40 - font.widthOfTextAtSize(etiquetaTexto, 9), y: height - 58, size: 9, font, color: rgb(0.7, 0.72, 0.8) });
    const fecha = new Date(quote.created_at || Date.now()).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
    page.drawText(fecha, { x: width - 40 - font.widthOfTextAtSize(fecha, 9), y: height - 72, size: 9, font, color: rgb(0.7, 0.72, 0.8) });

    let y = height - headerH - 34;

    // ── Bloque "Para" ──
    const paraBoxY = y - 58;
    page.drawRectangle({ x: 40, y: paraBoxY, width: width - 80, height: 58, color: rgb(0.975, 0.972, 0.965) });
    page.drawRectangle({ x: 40, y: paraBoxY, width: 3, height: 58, color: gold });
    let py = y - 16;
    page.drawText('PRESUPUESTO PARA', { x: 54, y: py, size: 7.5, font: fontBold, color: grey });
    py -= 16;
    if (quote.negocio) { page.drawText(quote.negocio, { x: 54, y: py, size: 12, font: fontBold, color: dark }); py -= 14; }
    const contactoLinea = [quote.nombre_contacto, quote.email_contacto, quote.telefono].filter(Boolean).join('   ·   ');
    if (contactoLinea) page.drawText(contactoLinea, { x: 54, y: py, size: 9, font, color: grey });

    y = paraBoxY - 30;

    // ── Tabla de líneas ──
    const colDescX = 54;
    const colPrecioX = width - 54;
    page.drawRectangle({ x: 40, y: y - 22, width: width - 80, height: 22, color: navy });
    page.drawText('CONCEPTO', { x: colDescX, y: y - 15, size: 8, font: fontBold, color: white });
    const precioLabel = 'PRECIO (SIN IVA)';
    page.drawText(precioLabel, { x: colPrecioX - font.widthOfTextAtSize(precioLabel, 8), y: y - 15, size: 8, font: fontBold, color: white });
    y -= 22;

    const lineas = Array.isArray(quote.lineas) ? quote.lineas : [];
    let filaIndex = 0;
    for (const linea of lineas) {
      const desc = wrapText(linea.descripcion || '', 78);
      const filaAltura = Math.max(22, desc.length * 13 + 8);

      if (y - filaAltura < 90) {
        page = pdf.addPage([595.28, 841.89]);
        y = height - 60;
      }

      if (filaIndex % 2 === 1) {
        page.drawRectangle({ x: 40, y: y - filaAltura, width: width - 80, height: filaAltura, color: rowAlt });
      }

      let textY = y - 15;
      for (const l of desc) {
        page.drawText(l, { x: colDescX, y: textY, size: 9.5, font, color: dark });
        textY -= 13;
      }
      const precioTexto = linea.precio === 0 ? 'Incluida' : (linea.precio ? (linea.es_desde ? 'desde ' : '') + fmtEur(linea.precio) : 'A consultar');
      page.drawText(precioTexto, { x: colPrecioX - fontBold.widthOfTextAtSize(precioTexto, 9.5), y: y - 15, size: 9.5, font: fontBold, color: dark });

      y -= filaAltura;
      page.drawLine({ start: { x: 40, y }, end: { x: width - 40, y }, thickness: 0.5, color: greyLine });
      filaIndex++;
    }

    // ── Totales (base / IVA / total) ──
    if (y < 170) { page = pdf.addPage([595.28, 841.89]); y = height - 60; }
    y -= 18;
    const base = Number(quote.total_estimado) || 0;
    const iva = base * 0.21;
    const total = base + iva;
    const totalsX = width - 260;
    const totalsW = width - 40 - totalsX;

    page.drawText('Base imponible', { x: totalsX, y, size: 9.5, font, color: grey });
    page.drawText(fmtEur(base), { x: totalsX + totalsW - font.widthOfTextAtSize(fmtEur(base), 9.5), y, size: 9.5, font, color: dark });
    y -= 16;
    page.drawText('IVA (21%)', { x: totalsX, y, size: 9.5, font, color: grey });
    page.drawText(fmtEur(iva), { x: totalsX + totalsW - font.widthOfTextAtSize(fmtEur(iva), 9.5), y, size: 9.5, font, color: dark });
    y -= 12;

    page.drawRectangle({ x: totalsX - 12, y: y - 26, width: totalsW + 12, height: 30, color: navy });
    const totalLabel = 'TOTAL';
    const totalVal = fmtEur(total);
    page.drawText(totalLabel, { x: totalsX, y: y - 17, size: 12, font: fontBold, color: gold });
    page.drawText(totalVal, { x: totalsX + totalsW - fontBold.widthOfTextAtSize(totalVal, 14), y: y - 18, size: 14, font: fontBold, color: white });
    y -= 46;

    // ── Notas / condiciones ──
    if (y < 90) { page = pdf.addPage([595.28, 841.89]); y = height - 60; }
    const notaLineas = wrapText(
      (quote.notas ? quote.notas + ' ' : '') +
      'Presupuesto orientativo, válido 30 días desde la fecha de emisión. Los importes marcados como "desde" pueden variar según el alcance final acordado en la auditoría previa.',
      100
    );
    for (const l of notaLineas) {
      page.drawText(l, { x: 40, y, size: 8, font, color: grey });
      y -= 11;
    }

    // ── Pie de página en todas las hojas ──
    const paginas = pdf.getPages();
    paginas.forEach((p, idx) => {
      const pw = p.getSize().width;
      p.drawLine({ start: { x: 40, y: 46 }, end: { x: pw - 40, y: 46 }, thickness: 0.5, color: greyLine });
      p.drawText('TRUCO technology — Tu Departamento Tecnológico', { x: 40, y: 32, size: 7.5, font, color: grey });
      const pageTxt = (idx + 1) + ' / ' + paginas.length;
      p.drawText(pageTxt, { x: pw - 40 - font.widthOfTextAtSize(pageTxt, 7.5), y: 32, size: 7.5, font, color: grey });
    });

    const pdfBytes = await pdf.save();
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

    return { statusCode: 200, body: JSON.stringify({ ok: true, pdf_base64: pdfBase64 }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception', message: e.message }) };
  }
};
