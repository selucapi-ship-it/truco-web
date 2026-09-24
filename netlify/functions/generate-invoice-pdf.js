// Genera el PDF de una FACTURA real de TRUCO — founder-exclusiva. Misma
// identidad visual que generate-quote-pdf.js a propósito (T-mark, Playfair
// Display + DM Sans + JetBrains Mono, azul+dorado): el cliente tiene que ver
// el mismo "TRUCOtechnology" en el presupuesto y en la factura, no dos
// documentos que parezcan de empresas distintas.
//
// A diferencia del presupuesto (orientativo, editable, sin numeración legal),
// esto lee de la tabla `facturas` — solo lectura aquí, nunca se crea ni edita
// una factura desde esta función (eso es emitir_factura(), en Supabase, la
// única vía posible: numeración correlativa sin huecos + encadenado por hash,
// ver supabase/migration_facturas.sql). Esta función solo pinta en PDF lo que
// ya quedó grabado de forma inmutable.
//
// RELLENAR antes de que esto funcione de verdad:
//   - SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ya las necesita save-lead.js)
//
// Las 3 tipografías son las mismas que ya usa generate-quote-pdf.js —
// netlify/functions/assets/fonts/ — con el mismo included_files en
// netlify.toml (ya cubre esta función también, mismo directorio de assets).

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

  const facturaId = payload.factura_id ? String(payload.factura_id) : '';
  if (!facturaId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta factura_id' }) };
  }

  try {
    const facturaResp = await fetch(`${supabaseUrl}/rest/v1/facturas?id=eq.${encodeURIComponent(facturaId)}&select=*`, { headers });
    if (!facturaResp.ok) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    }
    const rows = await facturaResp.json();
    const factura = rows[0];
    if (!factura) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'factura_no_encontrada' }) };
    }

    // ── Paleta EXACTA del sitio — idéntica a generate-quote-pdf.js ──
    const navy = rgb(0.086, 0.082, 0.102);
    const gold = rgb(0.851, 0.659, 0.247);
    const blue = rgb(0.184, 0.482, 1.0);
    const offwhite = rgb(0.949, 0.941, 0.918);
    const dark = rgb(0.12, 0.12, 0.15);
    const grey = rgb(0.42, 0.43, 0.48);
    const greyOnDark = rgb(0.68, 0.67, 0.71);
    const greyLine = rgb(0.89, 0.89, 0.91);
    const rowAlt = rgb(0.97, 0.965, 0.955);

    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const fontsDir = path.join(__dirname, 'assets', 'fonts');
    const display = await pdf.embedFont(fs.readFileSync(path.join(fontsDir, 'PlayfairDisplay-Bold.ttf')));
    const body = await pdf.embedFont(fs.readFileSync(path.join(fontsDir, 'DMSans-Regular.ttf')));
    const mono = await pdf.embedFont(fs.readFileSync(path.join(fontsDir, 'JetBrainsMono-Regular.ttf')));

    let page = pdf.addPage([595.28, 841.89]); // A4
    const { width, height } = page.getSize();

    // ── Cabecera: T-mark + wordmark, idéntica al presupuesto y al nav del sitio ──
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

    const numeroTexto = factura.numero_completo;
    const numeroSize = numeroTexto.length > 14 ? 15 : 21;
    page.drawText(numeroTexto, { x: width - 40 - display.widthOfTextAtSize(numeroTexto, numeroSize), y: height - 46, size: numeroSize, font: display, color: gold });
    const etiquetaTexto = tracked(factura.factura_rectificada_id ? 'Factura rectificativa' : 'Factura');
    page.drawText(etiquetaTexto, { x: width - 40 - mono.widthOfTextAtSize(etiquetaTexto, 7.5), y: height - 62, size: 7.5, font: mono, color: greyOnDark });
    const fecha = new Date(factura.fecha_expedicion || factura.created_at || Date.now()).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
    page.drawText(fecha, { x: width - 40 - body.widthOfTextAtSize(fecha, 8.5), y: height - 76, size: 8.5, font: body, color: greyOnDark });

    let y = height - headerH - 34;

    // ── Bloques "De" (TRUCOtechnology) y "Para" (cliente) — en una factura,
    // a diferencia del presupuesto, el NIF y el domicilio del cliente no son
    // opcionales de verdad (art. 6.1 RD 1619/2012 exige identificar a ambas
    // partes), pero como el dato ya viene congelado en la fila no hace falta
    // volver a validar aquí: si falta, es porque se emitió sin él.
    const boxGap = 12;
    const boxW = (width - 80 - boxGap) / 2;
    const deX = 40, paraX = 40 + boxW + boxGap;

    const domicilioLineas = factura.cliente_domicilio ? wrapText(factura.cliente_domicilio, 42) : [];
    const paraLineCount = 1 + 1 + (factura.cliente_nif ? 1 : 0) + domicilioLineas.length + (factura.cliente_email ? 1 : 0);
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
    page.drawText(tracked('Factura a'), { x: paraX + 14, y: py, size: 7, font: mono, color: grey });
    py -= 16;
    page.drawText(factura.cliente_nombre, { x: paraX + 14, y: py, size: 12, font: display, color: dark }); py -= 14;
    if (factura.cliente_nif) { page.drawText('NIF/CIF ' + factura.cliente_nif, { x: paraX + 14, y: py, size: 7.8, font: body, color: grey }); py -= 11; }
    for (const l of domicilioLineas) { page.drawText(l, { x: paraX + 14, y: py, size: 7.8, font: body, color: grey }); py -= 11; }
    if (factura.cliente_email) { page.drawText(factura.cliente_email, { x: paraX + 14, y: py, size: 7.8, font: body, color: grey }); py -= 11; }

    y = boxY - 28;

    // ── Aviso de rectificativa, si aplica — antes de la tabla, bien visible ──
    if (factura.factura_rectificada_id) {
      let numeroRectificada = '';
      try {
        const rectResp = await fetch(`${supabaseUrl}/rest/v1/facturas?id=eq.${encodeURIComponent(factura.factura_rectificada_id)}&select=numero_completo`, { headers });
        if (rectResp.ok) {
          const rectRows = await rectResp.json();
          numeroRectificada = rectRows[0] ? rectRows[0].numero_completo : '';
        }
      } catch (e) { /* si falla, se muestra el aviso sin el número de referencia */ }
      const avisoH = 26;
      page.drawRectangle({ x: 40, y: y - avisoH, width: width - 80, height: avisoH, color: rgb(0.988, 0.949, 0.878) });
      const avisoTexto = 'Esta factura RECTIFICA a la factura ' + (numeroRectificada || '(no encontrada)') + (factura.motivo_rectificacion ? ' — ' + factura.motivo_rectificacion : '');
      page.drawText(avisoTexto.slice(0, 110), { x: 50, y: y - 17, size: 8.5, font: body, color: rgb(0.55, 0.38, 0.06) });
      y -= avisoH + 12;
    }

    // ── Concepto general de la factura ──
    if (factura.concepto) {
      const conceptoLineas = wrapText(factura.concepto, 100);
      for (const l of conceptoLineas) { page.drawText(l, { x: 40, y, size: 9, font: body, color: dark }); y -= 12; }
      y -= 10;
    }

    // ── Tabla de líneas ──
    const colDescX = 54;
    const colPrecioX = width - 54;
    page.drawRectangle({ x: 40, y: y - 22, width: width - 80, height: 22, color: navy });
    page.drawText(tracked('Concepto'), { x: colDescX, y: y - 15, size: 7.5, font: mono, color: offwhite });
    const precioLabel = tracked('Importe (sin IVA)');
    page.drawText(precioLabel, { x: colPrecioX - mono.widthOfTextAtSize(precioLabel, 7.5), y: y - 15, size: 7.5, font: mono, color: offwhite });
    y -= 22;

    const lineas = Array.isArray(factura.lineas) ? factura.lineas : [];
    let filaIndex = 0;
    for (const linea of lineas) {
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
      const precioTexto = linea.precio === 0 ? 'Incluida' : fmtEur(linea.precio);
      const precioFont = esIncluidaVisual ? body : display;
      const precioColor = esIncluidaVisual ? grey : dark;
      const precioSize = esIncluidaVisual ? 8.6 : 10.5;
      page.drawText(precioTexto, { x: colPrecioX - precioFont.widthOfTextAtSize(precioTexto, precioSize), y: y - 14, size: precioSize, font: precioFont, color: precioColor });

      y -= filaAltura;
      if (!esIncluidaVisual) page.drawLine({ start: { x: 40, y }, end: { x: width - 40, y }, thickness: 0.5, color: greyLine });
      filaIndex++;
    }

    // ── Totales (base / IVA / total) — cifras ya definitivas, congeladas en
    // la propia factura, nunca recalculadas aquí ──
    if (y < 140) { page = pdf.addPage([595.28, 841.89]); y = height - 60; }
    y -= 18;
    const base = Number(factura.base_imponible) || 0;
    const tipoIva = Number(factura.tipo_iva) || 21;
    const iva = Number(factura.cuota_iva) || 0;
    const total = Number(factura.total) || 0;
    const totalsX = width - 260;
    const totalsW = width - 40 - totalsX;

    page.drawText('Base imponible', { x: totalsX, y, size: 9.3, font: body, color: grey });
    page.drawText(fmtEur(base), { x: totalsX + totalsW - body.widthOfTextAtSize(fmtEur(base), 9.3), y, size: 9.3, font: body, color: dark });
    y -= 16;
    const ivaLabel = `IVA (${tipoIva}%)`;
    page.drawText(ivaLabel, { x: totalsX, y, size: 9.3, font: body, color: grey });
    page.drawText(fmtEur(iva), { x: totalsX + totalsW - body.widthOfTextAtSize(fmtEur(iva), 9.3), y, size: 9.3, font: body, color: dark });
    y -= 12;

    page.drawRectangle({ x: totalsX - 12, y: y - 28, width: totalsW + 12, height: 32, color: navy });
    const totalLabel = tracked('Total');
    const totalVal = fmtEur(total);
    page.drawText(totalLabel, { x: totalsX, y: y - 18, size: 10, font: mono, color: gold });
    page.drawText(totalVal, { x: totalsX + totalsW - display.widthOfTextAtSize(totalVal, 15), y: y - 19, size: 15, font: display, color: offwhite });
    y -= 48;

    // ── Forma de pago — para quien pague por transferencia en vez de con el
    // enlace de tarjeta, el IBAN tiene que estar en la propia factura o no
    // sabe dónde ingresar. Cuenta fija de TRUCOtechnology, igual en todas
    // las facturas. ──
    if (y < 80) { page = pdf.addPage([595.28, 841.89]); y = height - 60; }
    page.drawText(tracked('Forma de pago'), { x: 40, y, size: 7, font: mono, color: grey });
    y -= 13;
    page.drawText('Transferencia a ES57 0182 1294 1502 0516 4770 (BBVA) · Titular: Jose Luis Robles Capitán', { x: 40, y, size: 8.3, font: body, color: dark });
    y -= 20;

    // ── Notas ──
    if (factura.notas) {
      if (y < 90) { page = pdf.addPage([595.28, 841.89]); y = height - 60; }
      const notaLineas = wrapText(factura.notas, 100);
      for (const l of notaLineas) { page.drawText(l, { x: 40, y, size: 8, font: body, color: grey }); y -= 11; }
      y -= 6;
    }

    // ── Pie de página en todas las hojas — huella de integridad incluida a
    // propósito (no exigida hasta VERI*FACTU, julio 2027, pero ya se calcula
    // y encadena desde el primer día — imprimirla es gratis y dice "esto es
    // software serio" sin necesidad de nada más) ──
    const paginas = pdf.getPages();
    paginas.forEach((p, idx) => {
      const pw = p.getSize().width;
      p.drawLine({ start: { x: 40, y: 46 }, end: { x: pw - 40, y: 46 }, thickness: 0.5, color: greyLine });
      const huellaTxt = 'Huella: ' + (factura.hash_registro || '').slice(0, 24) + '…';
      p.drawText(huellaTxt, { x: 40, y: 32, size: 6.3, font: mono, color: rgb(0.75, 0.74, 0.77) });
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
