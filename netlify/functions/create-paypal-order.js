// Crea una orden de pago de PayPal — sustituye al aviso de "te escribimos
// por WhatsApp para cerrar la financiación con SeQura" que había antes en el
// modo "Fracciona" de pago.html. PayPal no exige una aprobación previa del
// NEGOCIO como sí hacían Scalapay/seQura (evalúan al comprador en cada
// operación, no a TRUCO como empresa), así que puede estar en producción ya
// mismo — ver [[n8n-hosting-decision-and-payment-backup]] para el porqué.
// SeQura no se descarta: sigue esperando respuesta en paralelo, y si
// aprueba, se añade como opción extra sin tocar esto.
//
// Mismo patrón de seguridad que create-checkout.js (Stripe): antes de crear
// la orden, se recalcula el precio MÍNIMO legítimo para el tier con los
// datos en vivo de Supabase y se rechaza si el importe recibido queda por
// debajo — así no se puede manipular la petición desde las herramientas de
// desarrollador del navegador para pagar de menos.
//
// La API de Orders v2 de PayPal no tiene un bolsillo de metadata libre y
// grande como Stripe (solo custom_id, 127 caracteres) — así que el plan, las
// soluciones elegidas, el email, etc. se guardan en paypal_pending_orders,
// indexados por el id de la orden, y se recuperan en
// paypal-capture-order.js al confirmar el pago tras el redirect de vuelta.
//
// RELLENAR en Netlify antes de que esto funcione de verdad:
//   - PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (de developer.paypal.com,
//     modo Live → Apps & Credentials → tu app)
//   - PAYPAL_API_BASE (opcional — por defecto https://api-m.paypal.com,
//     el entorno real; solo se cambiaría a
//     https://api-m.sandbox.paypal.com para probar con una cuenta de
//     pruebas antes de aceptar cobros reales)
// Ya existentes y reutilizadas sin cambios: SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.

const SUPABASE_URL = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_dMe9-l4q9RvLgdUFRY3gWA_iIMilsXX';
const PERMANENCIA_MESES = 12;
const FREE_SOLS_POR_TIER = { start: 1, basic: 1, lite: 2, pro: 3 };
const ARRANQUE_TIERS_VALIDOS = Object.keys(FREE_SOLS_POR_TIER);

// Idéntica a la de create-checkout.js — misma fórmula, mismo blindaje contra
// precios manipulados. Duplicada a propósito: cada Function de Netlify es un
// archivo independiente en este proyecto (sin módulos compartidos entre
// funciones), igual que ya ocurre entre create-checkout.js y
// create-quote-checkout.js.
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

async function obtenerTokenPaypal(apiBase, clientId, secret) {
  const resp = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!resp.ok) {
    console.error('[PAYPAL] fallo obteniendo token', resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  return data.access_token || null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  const apiBase = process.env.PAYPAL_API_BASE || 'https://api-m.paypal.com';
  if (!clientId || !secret) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const name = payload.name ? String(payload.name).slice(0, 250) : null;
  const description = payload.description ? String(payload.description).slice(0, 120) : undefined;
  const amountCents = Math.round(Number(payload.amountCents));
  const customerEmail = payload.customerEmail ? String(payload.customerEmail).slice(0, 200) : undefined;
  const customerName = payload.customerName ? String(payload.customerName).slice(0, 200) : undefined;
  const planKey = payload.planKey ? String(payload.planKey).slice(0, 100) : '';
  const arranqueTier = payload.arranqueTier ? String(payload.arranqueTier).slice(0, 20) : '';
  const founding = payload.founding === true;
  const solutions = Array.isArray(payload.solutions) ? payload.solutions : [];
  const refCode = payload.refCode ? String(payload.refCode).slice(0, 20) : '';
  const consumeReferralCredit = payload.consumeReferralCredit ? String(payload.consumeReferralCredit).slice(0, 100) : '';

  if (!name || !Number.isFinite(amountCents) || amountCents < 50) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Datos de pago incompletos' }) };
  }

  if (!ARRANQUE_TIERS_VALIDOS.includes(arranqueTier)) {
    console.error(`create-paypal-order: intento de pago sin un tier válido — arranqueTier recibido: ${JSON.stringify(arranqueTier)}`);
    return { statusCode: 400, body: JSON.stringify({ error: 'Falta el tipo de plan' }) };
  }
  try {
    const minimo = await precioMinimoLegitimo(arranqueTier, solutions, founding);
    if (minimo !== null && amountCents < Math.round(minimo * 100) - 2) {
      console.error(`create-paypal-order: importe sospechoso — recibido ${amountCents}c, mínimo esperado ${Math.round(minimo * 100)}c, tier ${arranqueTier}`);
      return { statusCode: 400, body: JSON.stringify({ error: 'El importe no coincide con el precio real del plan' }) };
    }
  } catch (e) {
    console.error('create-paypal-order: fallo al validar el precio mínimo, se deja pasar el pago:', e.message);
  }

  const origin = event.headers.origin || ('https://' + event.headers.host);

  try {
    const token = await obtenerTokenPaypal(apiBase, clientId, secret);
    if (!token) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'paypal_auth_error' }) };
    }

    const orderResp = await fetch(`${apiBase}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            description: description || name,
            amount: { currency_code: 'EUR', value: (amountCents / 100).toFixed(2) },
          },
        ],
        application_context: {
          brand_name: 'TRUCOtechnology',
          locale: 'es-ES',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: origin + '/paypal-return.html',
          cancel_url: origin + '/pago.html?cancelado=1',
        },
      }),
    });

    if (!orderResp.ok) {
      console.error('[PAYPAL] fallo creando la orden', orderResp.status, await orderResp.text());
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'paypal_error' }) };
    }

    const order = await orderResp.json();
    const approveLink = Array.isArray(order.links) ? order.links.find(l => l.rel === 'approve') : null;
    if (!order.id || !approveLink) {
      return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'paypal_no_approve_link' }) };
    }

    // Guarda lo que confirm_client_purchase necesitará al capturar el pago
    // tras el redirect de vuelta — ver cabecera del archivo.
    const supabaseUrl = 'https://oxdopzvbrxdsjvzxmpxy.supabase.co';
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && serviceKey) {
      const headers = { 'Content-Type': 'application/json', apikey: serviceKey, Prefer: 'return=minimal' };
      if (!serviceKey.startsWith('sb_secret_') && !serviceKey.startsWith('sb_publishable_')) {
        headers.Authorization = `Bearer ${serviceKey}`;
      }
      await fetch(`${supabaseUrl}/rest/v1/paypal_pending_orders`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          order_id: order.id,
          payload: {
            email: customerEmail, nombre: customerName, planKey, arranqueTier, founding,
            solutions, refCode, consumeReferralCredit, amountTotalCents: amountCents,
          },
        }),
      });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, url: approveLink.href }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, reason: 'paypal_error', message: err.message }) };
  }
};
