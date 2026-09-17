// Crea un pedido "pendiente de transferencia" — tercera vía de pago junto a
// Stripe (tarjeta) y PayPal. A diferencia de esas dos, aquí no hay
// confirmación automática: el cliente transfiere a mano con el código de
// referencia que le damos, y el founder lo confirma en el panel de admin en
// cuanto lo ve entrar en su banco (ver confirm-bank-transfer.js). Mismo
// espíritu que "Cobros recurrentes" en admin/panel.html — el banco no avisa
// solo al sistema, así que hace falta un botón humano.
//
// Mismo blindaje de precio que create-checkout.js/create-paypal-order.js:
// se recalcula el mínimo legítimo con los datos en vivo de Supabase antes de
// aceptar el importe recibido.

const webpush = require('web-push');

const SUPABASE_URL = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_dMe9-l4q9RvLgdUFRY3gWA_iIMilsXX';
const PERMANENCIA_MESES = 12;
const FREE_SOLS_POR_TIER = { start: 1, basic: 1, lite: 2, pro: 3 };
const ARRANQUE_TIERS_VALIDOS = Object.keys(FREE_SOLS_POR_TIER);

// TRUCO recibe el 12% de descuento igual que en pago único con tarjeta: es
// un pago único real y, a diferencia de tarjeta/PayPal, no tiene ninguna
// comisión de procesador — no hay ningún motivo de coste para tratarla peor.
async function precioMinimoLegitimo(arranqueTier, solutionKeys, foundingClaimed) {
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
  const [tiersResp, spotsResp, solResp] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/tier_config_effective?select=tier,founder_price_eur,standard_price_eur`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/founding_spots?select=tier,spots_left`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/solutions_catalog_effective?select=solution_key,price_eur`, { headers }),
  ]);
  if (!tiersResp.ok) return null;
  const tiers = await tiersResp.json();
  const spots = spotsResp.ok ? await spotsResp.json() : [];
  const solutions = solResp.ok ? await solResp.json() : [];
  const tierRow = Array.isArray(tiers) ? tiers.find(t => t.tier === arranqueTier) : null;
  if (!tierRow) return null;
  const spotsLeft = Array.isArray(spots) ? (spots.find(s => s.tier === arranqueTier)?.spots_left ?? 0) : 0;
  const usaFundador = foundingClaimed && Number(spotsLeft) > 0;
  const monthly = Number(usaFundador ? tierRow.founder_price_eur : tierRow.standard_price_eur);
  if (!Number.isFinite(monthly)) return null;

  const keysRecibidas = (Array.isArray(solutionKeys) ? solutionKeys : [])
    .map(s => s && typeof s === 'object' ? s.key : s)
    .filter(k => typeof k === 'string' && k);
  const maxGratis = FREE_SOLS_POR_TIER[arranqueTier] || 0;
  let gratisRestantes = maxGratis;
  const extraTotal = keysRecibidas.reduce((sum, key, i) => {
    const original = solutionKeys[i];
    const reclamaGratis = !!(original && typeof original === 'object' && original.free);
    if (reclamaGratis && gratisRestantes > 0) {
      gratisRestantes -= 1;
      return sum;
    }
    const sol = solutions.find(s => s.solution_key === key);
    return sum + (sol ? Number(sol.price_eur) || 0 : 0);
  }, 0);

  const totBase = monthly * PERMANENCIA_MESES;
  const tras12pct = Math.round(totBase * 0.88 * 100) / 100;
  const baseImponible = tras12pct + extraTotal;
  const iva = baseImponible * 0.21;
  return baseImponible + iva;
}

// Avisa a ANTONIA de que ha entrado una transferencia pendiente — a
// diferencia de "conversaciones nuevas"/"cobros"/"leads" (que la campana del
// panel y el resumen diario cuentan en vivo contra su propia condición),
// esto sí es un evento puntual real que merece un aviso inmediato: hay
// dinero en camino que alguien tiene que confirmar a mano en cuanto entre en
// el banco. Mismo patrón que registrarAviso() en antonia-vigilancia.js:
// siempre queda en antonia_avisos (para que la voz lo cuente en el "buenos
// días" aunque esté en no molestar), y solo se manda también por Telegram si
// el modo no molestar no está activo ahora mismo. Best-effort: si esto falla,
// el pedido ya se ha guardado bien y el founder lo verá igualmente en el
// panel — nunca debe tumbar la respuesta al cliente.
async function avisarNuevaTransferencia(supabaseUrl, headers, referenceCode, amountCents, customerName, customerEmail) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const allowedId = process.env.ANTONIA_TELEGRAM_ALLOWED_ID;
    let noMolestar = false;
    try {
      const estadoResp = await fetch(`${supabaseUrl}/rest/v1/antonia_estado?id=eq.global&select=no_molestar_hasta`, { headers });
      if (estadoResp.ok) {
        const [estado] = await estadoResp.json();
        noMolestar = !!(estado && estado.no_molestar_hasta && new Date(estado.no_molestar_hasta) > new Date());
      }
    } catch (e) { /* si falla, se asume que no está en no molestar */ }

    const importe = (amountCents / 100).toFixed(2).replace('.', ',') + ' €';
    const mensaje = `💶 Nueva transferencia pendiente: ${importe} de ${customerName || customerEmail} (ref. ${referenceCode}). Actívala en el panel en cuanto la veas entrar en el banco.`;

    await fetch(`${supabaseUrl}/rest/v1/antonia_avisos`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ tipo: 'transferencia_pendiente', mensaje, enviado_telegram: !noMolestar }),
    });

    if (!noMolestar) {
      if (botToken && allowedId) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: allowedId, text: mensaje }),
        });
      }
      await enviarPush(supabaseUrl, headers, 'ANTONIA', mensaje);
    }
  } catch (e) {
    console.error('[TRANSFER] fallo avisando a ANTONIA (no crítico)', e.message);
  }
}

// Envía un aviso push (Web Push / VAPID) a los navegadores donde Jose haya
// activado los avisos en antonia-app (antonia-truco.netlify.app) — el mismo
// aviso que ya recibe por Telegram, pero llega también con el móvil
// bloqueado o Telegram cerrado. Best-effort: nunca debe tumbar el resto del
// aviso si esto falla. Borra las suscripciones que el navegador de destino
// ya da por caducadas (404/410 del propio servicio push).
async function enviarPush(supabaseUrl, headers, titulo, cuerpo) {
  const vapidPublic = 'BKa8VEwzL4AfIErzW9j6A6KA_61YmwpjBiV1-J4SgQHfjhRUrmyiCIz9mrV_ZkUqM0-dTiD2GJxWa9d297nmjag';
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = 'mailto:trucotechnology@gmail.com';
  if (!vapidPublic || !vapidPrivate || !vapidSubject) return;
  let subs = [];
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/antonia_push_subscriptions?select=id,endpoint,p256dh,auth`, { headers });
    if (resp.ok) subs = await resp.json();
  } catch (e) {
    console.error('[ANTONIA_PUSH] fallo leyendo suscripciones', e.message);
    return;
  }
  if (!Array.isArray(subs) || !subs.length) return;

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  const payload = JSON.stringify({ title: titulo, body: cuerpo, url: '/' });

  await Promise.all(subs.map(async (s) => {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(subscription, payload);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        try {
          await fetch(`${supabaseUrl}/rest/v1/antonia_push_subscriptions?id=eq.${s.id}`, { method: 'DELETE', headers });
        } catch (e2) { /* se reintentará solo cuando llegue el próximo aviso */ }
      } else {
        console.error('[ANTONIA_PUSH] fallo enviando', e.message);
      }
    }
  }));
}

function generarCodigoReferencia() {
  // Sin caracteres ambiguos (0/O, 1/I/L) para que sea fácil de copiar a mano
  // en el concepto de la transferencia sin errores de transcripción.
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let codigo = '';
  for (let i = 0; i < 6; i++) codigo += alfabeto[Math.floor(Math.random() * alfabeto.length)];
  return 'TRUCO-' + codigo;
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

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const amountCents = Math.round(Number(payload.amountCents));
  const customerEmail = payload.customerEmail ? String(payload.customerEmail).slice(0, 200) : undefined;
  const customerName = payload.customerName ? String(payload.customerName).slice(0, 200) : undefined;
  const planKey = payload.planKey ? String(payload.planKey).slice(0, 100) : '';
  const arranqueTier = payload.arranqueTier ? String(payload.arranqueTier).slice(0, 20) : '';
  const founding = payload.founding === true;
  const solutions = Array.isArray(payload.solutions) ? payload.solutions : [];
  const refCode = payload.refCode ? String(payload.refCode).slice(0, 20) : '';
  const consumeReferralCredit = payload.consumeReferralCredit ? String(payload.consumeReferralCredit).slice(0, 100) : '';
  const planName = payload.name ? String(payload.name).slice(0, 250) : '';
  const anexoAceptado = payload.anexoAceptado === true;
  const anexoVersion = payload.anexoVersion ? String(payload.anexoVersion).slice(0, 20) : '';

  if (!Number.isFinite(amountCents) || amountCents < 50 || !customerEmail) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Datos de pago incompletos' }) };
  }
  if (!anexoAceptado || !anexoVersion) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta aceptar el Anexo de Autorización de Accesos' }) };
  }
  if (!ARRANQUE_TIERS_VALIDOS.includes(arranqueTier)) {
    console.error(`create-bank-transfer-order: tier inválido recibido: ${JSON.stringify(arranqueTier)}`);
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta el tipo de plan' }) };
  }
  try {
    const minimo = await precioMinimoLegitimo(arranqueTier, solutions, founding);
    if (minimo !== null && amountCents < Math.round(minimo * 100) - 2) {
      console.error(`create-bank-transfer-order: importe sospechoso — recibido ${amountCents}c, mínimo esperado ${Math.round(minimo * 100)}c, tier ${arranqueTier}`);
      return { statusCode: 400, body: JSON.stringify({ error: 'El importe no coincide con el precio real del plan' }) };
    }
  } catch (e) {
    console.error('create-bank-transfer-order: fallo al validar el precio mínimo, se deja pasar:', e.message);
  }

  const headers = { 'Content-Type': 'application/json', apikey: serviceKey };
  if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${serviceKey}`;
  }

  let referenceCode = generarCodigoReferencia();
  try {
    // Reintenta una vez si por pura casualidad el código ya existiera (es de
    // 6 caracteres sobre un alfabeto de 32 — la colisión es rarísima, pero
    // la columna es unique así que hay que cubrirlo).
    for (let intento = 0; intento < 2; intento++) {
      const insertResp = await fetch(`${supabaseUrl}/rest/v1/bank_transfer_orders`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          reference_code: referenceCode,
          payload: {
            email: customerEmail, nombre: customerName, planKey, arranqueTier, founding,
            solutions, refCode, consumeReferralCredit, amountTotalCents: amountCents, planName,
            anexoAceptado, anexoVersion,
          },
        }),
      });
      if (insertResp.ok) {
        await avisarNuevaTransferencia(supabaseUrl, headers, referenceCode, amountCents, customerName, customerEmail);
        return {
          statusCode: 200,
          body: JSON.stringify({
            ok: true,
            referenceCode,
            amountCents,
            iban: 'ES57 0182 1294 1502 0516 4770',
            titular: 'TRUCOtechnology (Jose Luis Robles Capitán)',
            planName,
          }),
        };
      }
      const errText = await insertResp.text();
      if (insertResp.status === 409 || /duplicate/i.test(errText)) {
        referenceCode = generarCodigoReferencia();
        continue;
      }
      console.error('[TRANSFER] fallo guardando el pedido pendiente', insertResp.status, errText);
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'supabase_error' }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'reference_collision' }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'exception', message: err.message }) };
  }
};
