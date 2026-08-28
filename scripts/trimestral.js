#!/usr/bin/env node
'use strict';

// Genera los documentos espejo del Modelo 130/303 y el aviso de revisión
// trimestral, en local, sin presentar nada ante Hacienda.
//
// Uso:
//   node scripts/trimestral.js --modo=aviso   [--fecha=YYYY-MM-DD]
//   node scripts/trimestral.js --modo=generar [--fecha=YYYY-MM-DD]
//
// --fecha es opcional, solo para pruebas (simula qué día es hoy). Sin ella
// usa la fecha real del sistema. Fuera de abril/julio/octubre/enero no hace
// nada, para que la tarea programada pueda dispararse en falso sin efecto.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// ── .env casero (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) ──────────────────
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv(path.join(__dirname, '..', '.env'));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY. Crea un .env en la raíz del repo con SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (ver cabecera de este fichero).');
  process.exit(1);
}

function authHeaders() {
  const h = { 'Content-Type': 'application/json', apikey: SERVICE_KEY };
  // Claves nuevas (sb_secret_...) solo van en "apikey"; las antiguas (JWT
  // service_role) necesitan además "Authorization: Bearer" — mismo criterio
  // que netlify/functions/save-lead.js.
  if (!SERVICE_KEY.startsWith('sb_secret_') && !SERVICE_KEY.startsWith('sb_publishable_')) {
    h.Authorization = `Bearer ${SERVICE_KEY}`;
  }
  return h;
}

async function rpc(fn, body) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`${fn} → ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function select(table, query) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: authHeaders() });
  if (!resp.ok) throw new Error(`${table} → ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ── argumentos ───────────────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
if (!['aviso', 'generar'].includes(args.modo)) {
  console.error('Uso: node trimestral.js --modo=aviso|generar [--fecha=YYYY-MM-DD]');
  process.exit(1);
}
const modo = args.modo;
const hoy = args.fecha ? new Date(`${args.fecha}T00:00:00`) : new Date();

// ── qué trimestre toca declarar según el mes de hoy ─────────────────────
// mes JS 0-based: enero=0, abril=3, julio=6, octubre=9.
// Enero declara el T4 del año ANTERIOR — el T4 se archiva en la carpeta del
// año que cubre, no del año en que se genera (decisión confirmada).
const MES_A_TRIMESTRE = { 3: [1, 0], 6: [2, 0], 9: [3, 0], 0: [4, -1] };
const mapeo = MES_A_TRIMESTRE[hoy.getMonth()];
if (!mapeo) {
  console.log(`Hoy (${hoy.toISOString().slice(0, 10)}) no es un mes de presentación (abril/julio/octubre/enero). No se hace nada.`);
  process.exit(0);
}
const [trimestre, deltaAnio] = mapeo;
const anio = hoy.getFullYear() + deltaAnio;

const carpeta = path.join(__dirname, '..', 'TRIMESTRALES', String(anio), `trimestre${trimestre}`);
fs.mkdirSync(carpeta, { recursive: true });

// Igual que fmtEuro() en founding-offer.js: toLocaleString('es-ES') en Node/ICU
// no agrupa los miles en números de 4 cifras (4000 -> "4000,00" en vez de
// "4.000,00"), así que se formatea a mano en vez de fiarse del locale.
function eur(cents) {
  const n = cents / 100;
  const partes = Math.abs(n).toFixed(2).split('.');
  const conMiles = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (n < 0 ? '-' : '') + conMiles + ',' + partes[1] + ' €';
}

function mesesDelTrimestre() {
  const meses = [];
  for (let i = 0; i < 3; i++) {
    const m = (trimestre - 1) * 3 + i;
    const inicio = new Date(anio, m, 1);
    const fin = new Date(anio, m + 1, 0);
    meses.push({
      inicio: inicio.toISOString().slice(0, 10),
      fin: fin.toISOString().slice(0, 10),
      etiqueta: inicio.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }),
    });
  }
  return meses;
}

// ── PDF "documento espejo" ─────────────────────────────────────────────
function wrapText(text, font, size, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function dibujarDocumento(titulo, avisos, filas, salida) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const marginX = 50;
  let y = 800;

  page.drawText('TRUCO technology — documento de apoyo, NO el formulario oficial de la AEAT', {
    x: marginX, y, size: 8, font, color: rgb(0.55, 0.12, 0.12),
  });
  y -= 16;
  page.drawText(titulo, { x: marginX, y, size: 16, font: fontBold });
  y -= 22;

  for (const aviso of avisos) {
    for (const linea of wrapText(aviso, font, 9, 495)) {
      page.drawText(linea, { x: marginX, y, size: 9, font, color: rgb(0.35, 0.35, 0.35) });
      y -= 12;
    }
    y -= 4;
  }
  y -= 10;
  page.drawLine({ start: { x: marginX, y }, end: { x: 545, y }, thickness: 1, color: rgb(0.7, 0.7, 0.7) });
  y -= 24;

  for (const fila of filas) {
    if (fila.separador) {
      y -= 6;
      page.drawLine({ start: { x: marginX, y }, end: { x: 545, y }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });
      y -= 16;
      continue;
    }
    page.drawText(`Casilla ${fila.casilla}`, { x: marginX, y, size: 9, font: fontBold, color: rgb(0.62, 0.46, 0.1) });
    for (const linea of wrapText(fila.concepto, font, 10, 300)) {
      page.drawText(linea, { x: marginX + 68, y, size: 10, font });
      y -= 13;
    }
    page.drawText(fila.valor, { x: 460, y: y + 13, size: 10, font: fontBold });
    y -= 8;
  }

  fs.writeFileSync(salida, await doc.save());
}

async function generarModelo130(r) {
  const avisos = [
    'Casillas y numeración citadas de guías públicas de la AEAT — verifica cada número contra el formulario real en la Sede Electrónica antes de copiar; puede variar entre ejercicios.',
    'La casilla de retenciones e ingresos a cuenta practicados no está registrada en este sistema hoy. Si alguna factura tuya llevó retención de IRPF, revísalo a mano y réstalo del resultado.',
  ];
  const filas = [
    { casilla: '01', concepto: 'Ingresos computables (acumulado del año)', valor: eur(r.ingresos_netos_acumulados_cents) },
    { casilla: '02', concepto: 'Gastos fiscalmente deducibles (acumulado)', valor: eur(r.gastos_deducibles_acumulados_cents) },
    { separador: true },
    { casilla: '03', concepto: 'Rendimiento neto (01 - 02)', valor: eur(r.rendimiento_neto_acumulado_cents) },
    { casilla: '04', concepto: '20% de la casilla 03', valor: eur(r.pago_fraccionado_20pct_acumulado_cents) },
    { separador: true },
    { casilla: '05', concepto: 'Pagos fraccionados de trimestres anteriores (a restar)', valor: `- ${eur(r.pagos_fraccionados_declarados_previos_cents)}` },
    { casilla: '06', concepto: 'Retenciones practicadas (a restar) — no registrado, revisar a mano', valor: '0,00 €*' },
    { separador: true },
    { casilla: '07', concepto: 'Resultado (a ingresar si es positivo)', valor: eur(r.pago_fraccionado_pendiente_130_cents) },
  ];
  await dibujarDocumento(`Modelo 130 — T${trimestre} ${anio}`, avisos, filas, path.join(carpeta, 'Modelo-130.pdf'));
}

async function generarModelo303(r) {
  const avisos = [
    'Casillas y numeración citadas de guías públicas de la AEAT — verifica cada número contra el formulario real en la Sede Electrónica antes de copiar; puede variar entre ejercicios.',
    'Se asume que todas tus operaciones van al tipo general (21%). Si tienes algo a tipo reducido o superreducido, ajusta a mano en las casillas correspondientes del formulario real.',
  ];
  const filas = [
    { casilla: '01/03', concepto: 'Base imponible — IVA devengado, tipo general 21%', valor: eur(r.base_devengada_cents) },
    { casilla: '03', concepto: 'Cuota — IVA devengado, tipo general 21%', valor: eur(r.iva_devengado_cents) },
    { casilla: '27', concepto: 'Total cuota IVA devengado', valor: eur(r.iva_devengado_cents) },
    { separador: true },
    { casilla: '28/29', concepto: 'Base y cuota — IVA deducible en operaciones interiores', valor: `${eur(r.base_deducible_cents)} / ${eur(r.iva_deducible_cents)}` },
    { casilla: '45', concepto: 'Total a deducir', valor: eur(r.iva_deducible_cents) },
    { separador: true },
    { casilla: '46/71', concepto: 'Resultado (devengado - deducible)', valor: eur(r.resultado_303_cents) },
  ];
  await dibujarDocumento(`Modelo 303 — T${trimestre} ${anio}`, avisos, filas, path.join(carpeta, 'Modelo-303.pdf'));
}

// ── Aviso de revisión (día 1) ────────────────────────────────────────────
async function generarAviso(resumen) {
  const meses = mesesDelTrimestre();
  const lineas = [];
  lineas.push(`AVISO DE REVISIÓN — Trimestre ${trimestre} de ${anio}`);
  lineas.push(`Generado: ${new Date().toLocaleString('es-ES')}`);
  lineas.push('');
  lineas.push(`Ingresos del trimestre: ${eur(resumen.base_devengada_cents)} (base) + ${eur(resumen.iva_devengado_cents)} IVA`);
  lineas.push(`Gastos deducibles del trimestre: ${eur(resumen.base_deducible_cents)} (base) + ${eur(resumen.iva_deducible_cents)} IVA`);
  lineas.push(`Resultado Modelo 303 (estimado): ${eur(resumen.resultado_303_cents)}`);
  lineas.push(`Pendiente Modelo 130 (estimado): ${eur(resumen.pago_fraccionado_pendiente_130_cents)}`);
  lineas.push('');

  const templates = await select('fiscal_expense_templates', 'activo=eq.true&select=id,concepto,periodicidad,proxima_renovacion');
  const gastosConTemplate = await select(
    'fiscal_expenses',
    `template_id=not.is.null&fecha=gte.${meses[0].inicio}&fecha=lte.${meses[2].fin}&select=template_id,fecha`
  );

  lineas.push('GASTOS FIJOS — revisa si falta aplicar alguno:');
  let huecosGastos = 0;
  for (const mes of meses) {
    for (const t of templates) {
      const aplica = t.periodicidad === 'mensual' || !t.proxima_renovacion
        || (t.proxima_renovacion >= mes.inicio && t.proxima_renovacion <= mes.fin);
      if (!aplica) continue;
      const yaAplicado = gastosConTemplate.some((g) => g.template_id === t.id && g.fecha >= mes.inicio && g.fecha <= mes.fin);
      if (!yaAplicado) {
        lineas.push(`  ✕ "${t.concepto}" no tiene gasto aplicado en ${mes.etiqueta}`);
        huecosGastos++;
      }
    }
  }
  if (!huecosGastos) lineas.push('  ✓ Todo aplicado, nada pendiente.');
  lineas.push('');

  const clientesDomiciliados = await select('clients', 'domiciliacion_activa=eq.true&select=id,nombre');
  const ingresos = await select(
    'fiscal_income',
    `fecha=gte.${meses[0].inicio}&fecha=lte.${meses[2].fin}&anulado=eq.false&select=client_id,fecha`
  );

  lineas.push('COBROS RECURRENTES — clientes con domiciliación activa sin ingreso registrado:');
  if (!clientesDomiciliados.length) {
    lineas.push('  (no tienes ningún cliente con domiciliación activa todavía)');
  } else {
    let huecosCobros = 0;
    for (const mes of meses) {
      for (const c of clientesDomiciliados) {
        const tieneIngreso = ingresos.some((i) => i.client_id === c.id && i.fecha >= mes.inicio && i.fecha <= mes.fin);
        if (!tieneIngreso) {
          lineas.push(`  ✕ ${c.nombre} sin ingreso registrado en ${mes.etiqueta}`);
          huecosCobros++;
        }
      }
    }
    if (!huecosCobros) lineas.push('  ✓ Todo registrado, nada pendiente.');
  }

  fs.writeFileSync(path.join(carpeta, 'AVISO-revision.txt'), lineas.join('\n'), 'utf8');
  console.log(`Aviso escrito en ${path.join(carpeta, 'AVISO-revision.txt')}`);

  try {
    const mensaje = `Revisa gastos e ingresos del trimestre ${trimestre} de ${anio} antes del dia 8. Ver TRIMESTRALES\\${anio}\\trimestre${trimestre}\\AVISO-revision.txt`;
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$n = New-Object System.Windows.Forms.NotifyIcon',
      '$n.Icon = [System.Drawing.SystemIcons]::Information',
      '$n.Visible = $true',
      "$n.BalloonTipTitle = 'TRUCO - Revision trimestral'",
      `$n.BalloonTipText = '${mensaje.replace(/'/g, "''")}'`,
      '$n.ShowBalloonTip(15000)',
      'Start-Sleep -Seconds 1',
    ].join('; ');
    execSync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
  } catch (e) {
    console.error('No se pudo lanzar la notificación de Windows (el aviso en el .txt sí se ha guardado):', e.message);
  }
}

// ── principal ────────────────────────────────────────────────────────────
(async () => {
  console.log(`Trimestre ${trimestre} de ${anio} — modo ${modo}`);
  const resumen = await rpc('founder_fiscal_resumen', { p_anio: anio, p_trimestre: trimestre });
  if (modo === 'generar') {
    await generarModelo130(resumen);
    await generarModelo303(resumen);
    console.log(`Documentos generados en ${carpeta}`);
  } else {
    await generarAviso(resumen);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
