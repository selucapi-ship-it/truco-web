// Genera el PDF de un presupuesto comercial de TRUCO — founder-exclusiva.
// Devuelve el PDF en base64 para que el panel lo descargue, lo previsualice
// o lo adjunte al correo (send-quote-email.js). Documento propio, con la
// MISMA identidad visual del sitio (no una aproximación): T-mark con borde
// dorado, "TRUCO" + "technology" en azul (igual que .nav-brand span en el
// CSS del sitio), Playfair Display para titulares/cifras, DM Sans para el
// cuerpo, JetBrains Mono para las etiquetas técnicas — no lleva numeración
// legal ni hash como las facturas de TruKi, es una oferta comercial.
//
// RELLENAR antes de que esto funcione de verdad:
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ya las necesita save-lead.js)
//
// Las 3 tipografías viven en netlify/functions/assets/fonts/ (Playfair
// Display Bold, DM Sans Regular, JetBrains Mono Regular — descargadas de
// Google Fonts, licencia OFL) y se embeben en el PDF vía @pdf-lib/fontkit.
// netlify.toml tiene un included_files específico para esta función, sin
// eso el bundle de producción no las llevaría dentro.

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

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

// Etiquetas cortas tipo "eyebrow" (DE, PARA, TOTAL...) — imita el tracking
// ancho que .page-tag/.nav-sub usan en CSS, que pdf-lib no soporta de forma
// nativa. Solo se usa en textos cortos: en uno largo desbordaría la caja.
function tracked(text) {
  return text.toUpperCase().split('').join(' ');
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const supabaseUrl = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
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

    // ── Paleta EXACTA del sitio (variables CSS de autorizacion-accesos.html /
    // terminos.html / index.html: --bg, --gold, --blue, --white, --grey) ──
    const navy = rgb(0.086, 0.082, 0.102);        // #16151a — --bg
    const gold = rgb(0.851, 0.659, 0.247);        // #d9a83f — --gold
    const blue = rgb(0.184, 0.482, 1.0);          // #2f7bff — --blue
    const offwhite = rgb(0.949, 0.941, 0.918);    // #f2f0ea — --white
    const dark = rgb(0.12, 0.12, 0.15);
    const grey = rgb(0.42, 0.43, 0.48);
    const greyOnDark = rgb(0.68, 0.67, 0.71);     // grey legible sobre navy
    const greyLine = rgb(0.89, 0.89, 0.91);
    const rowAlt = rgb(0.97, 0.965, 0.955);
    const goldTint = rgb(0.988, 0.949, 0.878);
    const goldDeep = rgb(0.55, 0.38, 0.06);

    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const fontsDir = path.join(__dirname, 'assets', 'fonts');
    const display = await pdf.embedFont(fs.readFileSync(path.join(fontsDir, 'PlayfairDisplay-Bold.ttf')));
    const body = await pdf.embedFont(fs.readFileSync(path.join(fontsDir, 'DMSans-Regular.ttf')));
    const mono = await pdf.embedFont(fs.readFileSync(path.join(fontsDir, 'JetBrainsMono-Regular.ttf')));

    let page = pdf.addPage([595.28, 841.89]); // A4
    const { width, height } = page.getSize();

    // ── Cabecera: T-mark + wordmark, idéntico al nav del sitio ──
    const headerH = 112;
    page.drawRectangle({ x: 0, y: height - headerH, width, height: headerH, color: navy });
    page.drawRectangle({ x: 0, y: height - headerH, width, height: 4, color: gold });

    const markSize = 32, markX = 40, markY = height - 46 - markSize + 8;
    page.drawRectangle({ x: markX, y: markY, width: markSize, height: markSize, borderColor: gold, borderWidth: 1.4 });
    const tW = display.widthOfTextAtSize('T', 17);
    page.drawText('T', { x: markX + (markSize - tW) / 2, y: markY + 9, size: 17, font: display, color: gold });

    const wordX = markX + markSize + 11;
    page.drawText('TRUCO', { x: wordX, y: height - 46, size: 19, font: display, color: offwhite });
    page.drawText('technology', { x: wordX + display.widthOfTextAtSize('TRUCO', 19) + 3, y: height - 46, size: 19, font: display, color: blue });
    page.drawText('Tu Departamento Tecnológico', { x: wordX, y: height - 63, size: 8.5, font: body, color: greyOnDark });

    const numeroTexto = 'P' + String(quote.numero).padStart(4, '0');
    page.drawText(numeroTexto, { x: width - 40 - display.widthOfTextAtSize(numeroTexto, 21), y: height - 46, size: 21, font: display, color: gold });
    const etiquetaTexto = tracked('Presupuesto');
    page.drawText(etiquetaTexto, { x: width - 40 - mono.widthOfTextAtSize(etiquetaTexto, 7.5), y: height - 62, size: 7.5, font: mono, color: greyOnDark });
    const fecha = new Date(quote.created_at || Date.now()).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
    page.drawText(fecha, { x: width - 40 - body.widthOfTextAtSize(fecha, 8.5), y: height - 76, size: 8.5, font: body, color: greyOnDark });

    let y = height - headerH - 34;

    // ── Bloques "De" (TRUCOtechnology) y "Para" (cliente), lado a lado —
    // acento dorado en "De" y azul en "Para", los dos colores de marca. La
    // caja "Para" crece según los datos del cliente que haya (NIF/domicilio
    // son opcionales), así que ambas cajas se dimensionan a la más alta.
    const boxGap = 12;
    const boxW = (width - 80 - boxGap) / 2;
    const deX = 40, paraX = 40 + boxW + boxGap;

    const domicilioLineas = quote.cliente_domicilio ? wrapText(quote.cliente_domicilio, 42) : [];
    const paraLineCount = 1 + (quote.negocio ? 1 : 0) + (quote.cliente_nif ? 1 : 0) + domicilioLineas.length + (quote.nombre_contacto ? 1 : 0) + ([quote.email_contacto, quote.telefono].filter(Boolean).length ? 1 : 0);
    const deLineCount = 3;
    const boxH = Math.max(58, Math.max(paraLineCount, deLineCount) * 12.5 + 20);
    const boxY = y - boxH;

    page.drawRectangle({ x: deX, y: boxY, width: boxW, height: boxH, color: rgb(0.975, 0.972, 0.965) });
    page.drawRectangle({ x: deX, y: boxY, width: 3, height: boxH, color: gold });
    let dy = y - 15;
    page.drawText(tracked('De'), { x: deX + 14, y: dy, size: 7, font: mono, color: grey });
    dy -= 15;
    page.drawText('TRUCOtechnology', { x: deX + 14, y: dy, size: 11, font: display, color: dark });
    dy -= 13;
    page.drawText('Jose Luis Robles Capitán · NIF 48523326L', { x: deX + 14, y: dy, size: 7.8, font: body, color: grey });
    dy -= 11;
    page.drawText('departamento@trucotechnology.com · +34 868 29 04 50', { x: deX + 14, y: dy, size: 7.8, font: body, color: grey });

    page.drawRectangle({ x: paraX, y: boxY, width: boxW, height: boxH, color: rgb(0.975, 0.972, 0.965) });
    page.drawRectangle({ x: paraX, y: boxY, width: 3, height: boxH, color: blue });
    let py = y - 15;
    page.drawText(tracked('Presupuesto para'), { x: paraX + 14, y: py, size: 7, font: mono, color: grey });
    py -= 16;
    if (quote.negocio) { page.drawText(quote.negocio, { x: paraX + 14, y: py, size: 12, font: display, color: dark }); py -= 14; }
    if (quote.cliente_nif) { page.drawText('NIF/CIF ' + quote.cliente_nif, { x: paraX + 14, y: py, size: 7.8, font: body, color: grey }); py -= 11; }
    for (const l of domicilioLineas) { page.drawText(l, { x: paraX + 14, y: py, size: 7.8, font: body, color: grey }); py -= 11; }
    if (quote.nombre_contacto) { page.drawText(quote.nombre_contacto, { x: paraX + 14, y: py, size: 9, font: body, color: dark }); py -= 12; }
    const contactoLinea = [quote.email_contacto, quote.telefono].filter(Boolean).join('   ·   ');
    if (contactoLinea) page.drawText(contactoLinea, { x: paraX + 14, y: py, size: 7.8, font: body, color: grey });

    y = boxY - 28;

    // ── Tabla de líneas ──
    const colDescX = 54;
    const colPrecioX = width - 54;
    page.drawRectangle({ x: 40, y: y - 22, width: width - 80, height: 22, color: navy });
    page.drawText(tracked('Concepto'), { x: colDescX, y: y - 15, size: 7.5, font: mono, color: offwhite });
    const precioLabel = tracked('Precio (sin IVA)');
    page.drawText(precioLabel, { x: colPrecioX - mono.widthOfTextAtSize(precioLabel, 7.5), y: y - 15, size: 7.5, font: mono, color: offwhite });
    y -= 22;

    const lineas = Array.isArray(quote.lineas) ? quote.lineas : [];
    let filaIndex = 0;
    for (const linea of lineas) {
      // Las líneas incluidas gratis (feature del Departamento, o automatización
      // ya cubierta) se muestran indentadas y en gris con un punto — así se lee
      // de un vistazo qué es "lo que se paga" y qué es "lo que ya trae de
      // serie", en vez de una lista plana donde todo pesa lo mismo.
      const esIncluidaVisual = !!(linea.es_feature || linea.es_incluida);
      const indent = esIncluidaVisual ? 14 : 0;
      const desc = wrapText((esIncluidaVisual ? '• ' : '') + (linea.descripcion || ''), esIncluidaVisual ? 92 : 82);
      const filaAltura = Math.max(20, desc.length * 12 + 8);

      if (y - filaAltura < 90) {
        page = pdf.addPage([595.28, 841.89]);
        y = height - 60;
      }

      if (!esIncluidaVisual && filaIndex % 2 === 1) {
        page.drawRectangle({ x: 40, y: y - filaAltura, width: width - 80, height: filaAltura, color: rowAlt });
      }

      let textY = y - 14;
      for (const l of desc) {
        page.drawText(l, {
          x: colDescX + indent, y: textY,
          size: esIncluidaVisual ? 8.6 : 9.3,
          font: body,
          color: esIncluidaVisual ? grey : dark,
        });
        textY -= esIncluidaVisual ? 11.5 : 13;
      }
      const precioTexto = linea.precio === 0 ? 'Incluida' : (linea.precio ? (linea.es_desde ? 'desde ' : '') + fmtEur(linea.precio) : 'A consultar');
      const precioFont = esIncluidaVisual ? body : display;
      const precioColor = esIncluidaVisual ? grey : dark;
      const precioSize = esIncluidaVisual ? 8.6 : 10.5;
      page.drawText(precioTexto, { x: colPrecioX - precioFont.widthOfTextAtSize(precioTexto, precioSize), y: y - 14, size: precioSize, font: precioFont, color: precioColor });

      y -= filaAltura;
      if (!esIncluidaVisual) page.drawLine({ start: { x: 40, y }, end: { x: width - 40, y }, thickness: 0.5, color: greyLine });
      filaIndex++;
    }

    // ── Totales (subtotal / descuento / base / IVA / total) ──
    if (y < 190) { page = pdf.addPage([595.28, 841.89]); y = height - 60; }
    y -= 18;
    const subtotalLineas = lineas.reduce((s, l) => s + (Number(l.precio) || 0), 0);
    const base = Number(quote.total_estimado) || 0;
    const descuentoPct = Number(quote.descuento_pct) || 0;
    // total_estimado ya viene con el descuento aplicado desde el panel — aquí
    // solo se recalcula el importe del descuento para poder mostrarlo como
    // línea propia, resaltada, en vez de que desaparezca dentro de la base.
    const descuentoImporte = Math.max(0, subtotalLineas - base);
    const iva = base * 0.21;
    const total = base + iva;
    const totalsX = width - 260;
    const totalsW = width - 40 - totalsX;

    if (descuentoPct > 0 && descuentoImporte > 0.005) {
      page.drawText('Subtotal', { x: totalsX, y, size: 9.3, font: body, color: grey });
      page.drawText(fmtEur(subtotalLineas), { x: totalsX + totalsW - body.widthOfTextAtSize(fmtEur(subtotalLineas), 9.3), y, size: 9.3, font: body, color: dark });
      y -= 16;

      // Importe en su propia fila (con la etiqueta "Descuento X%") y el motivo
      // debajo, en su línea propia — así un motivo largo nunca puede chocar
      // con el importe, sea cual sea su longitud.
      const motivoLineas = quote.descuento_motivo ? wrapText(quote.descuento_motivo, 46) : [];
      const descBoxH = 18 + motivoLineas.length * 11 + 6;
      page.drawRectangle({ x: totalsX - 12, y: y - descBoxH + 4, width: totalsW + 12, height: descBoxH, color: goldTint });
      page.drawRectangle({ x: totalsX - 12, y: y - descBoxH + 4, width: 3, height: descBoxH, color: gold });
      const descLabelTxt = `Descuento ${descuentoPct}%`;
      const descImporteTxt = '-' + fmtEur(descuentoImporte);
      page.drawText(descLabelTxt, { x: totalsX, y: y - 9, size: 9.5, font: display, color: goldDeep });
      page.drawText(descImporteTxt, { x: totalsX + totalsW - display.widthOfTextAtSize(descImporteTxt, 9.5), y: y - 9, size: 9.5, font: display, color: goldDeep });
      let motivoY = y - 21;
      for (const l of motivoLineas) {
        page.drawText(l, { x: totalsX, y: motivoY, size: 7.8, font: body, color: goldDeep });
        motivoY -= 11;
      }
      y -= descBoxH + 6;
    }

    page.drawText('Base imponible', { x: totalsX, y, size: 9.3, font: body, color: grey });
    page.drawText(fmtEur(base), { x: totalsX + totalsW - body.widthOfTextAtSize(fmtEur(base), 9.3), y, size: 9.3, font: body, color: dark });
    y -= 16;
    page.drawText('IVA (21%)', { x: totalsX, y, size: 9.3, font: body, color: grey });
    page.drawText(fmtEur(iva), { x: totalsX + totalsW - body.widthOfTextAtSize(fmtEur(iva), 9.3), y, size: 9.3, font: body, color: dark });
    y -= 12;

    page.drawRectangle({ x: totalsX - 12, y: y - 28, width: totalsW + 12, height: 32, color: navy });
    const totalLabel = tracked('Total');
    const totalVal = fmtEur(total);
    page.drawText(totalLabel, { x: totalsX, y: y - 18, size: 10, font: mono, color: gold });
    page.drawText(totalVal, { x: totalsX + totalsW - display.widthOfTextAtSize(totalVal, 15), y: y - 19, size: 15, font: display, color: offwhite });
    y -= 48;

    // ── Notas / condiciones ──
    if (y < 90) { page = pdf.addPage([595.28, 841.89]); y = height - 60; }
    const notaLineas = wrapText(
      (quote.notas ? quote.notas + ' ' : '') +
      'Presupuesto orientativo, válido 30 días desde la fecha de emisión. Los importes marcados como "desde" pueden variar según el alcance final acordado en la auditoría previa.',
      100
    );
    for (const l of notaLineas) {
      page.drawText(l, { x: 40, y, size: 8, font: body, color: grey });
      y -= 11;
    }

    // ── Pie de página en todas las hojas — con el eslogan, el toque de marca
    // que aparece en toda la web (ver [[brand-slogan-paga-una-vez]]) ──
    const paginas = pdf.getPages();
    paginas.forEach((p, idx) => {
      const pw = p.getSize().width;
      p.drawLine({ start: { x: 40, y: 46 }, end: { x: pw - 40, y: 46 }, thickness: 0.5, color: greyLine });
      p.drawText('TRUCOtechnology · Paga una vez, olvídate 365 días', { x: 40, y: 32, size: 7.3, font: mono, color: grey });
      const pageTxt = (idx + 1) + ' / ' + paginas.length;
      p.drawText(pageTxt, { x: pw - 40 - mono.widthOfTextAtSize(pageTxt, 7.3), y: 32, size: 7.3, font: mono, color: grey });
    });

    const pdfBytes = await pdf.save();
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

    return { statusCode: 200, body: JSON.stringify({ ok: true, pdf_base64: pdfBase64 }) };
  } catch (e) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception', message: e.message }) };
  }
};
