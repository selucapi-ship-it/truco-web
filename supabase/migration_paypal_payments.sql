-- Añade PayPal como segunda pasarela de pago real, en paralelo a Stripe (no
-- lo sustituye — founder decidió 2026-09-13 mantener seQura en paralelo por
-- si aprueba más adelante, y PayPal como la vía que SÍ está lista ya mismo
-- porque no exige aprobación previa del negocio, solo verificación de
-- identidad del titular de la cuenta).
--
-- Diseño: create-paypal-order.js NO puede meter toda la información del
-- carrito (plan, tier, soluciones, referido...) dentro de la orden de
-- PayPal — a diferencia de Stripe, la API de Orders v2 no tiene un bolsillo
-- de metadata libre grande, solo custom_id (127 caracteres, insuficiente
-- para el array de soluciones). Por eso esa información se guarda en
-- paypal_pending_orders, indexada por el id de la orden de PayPal, y se
-- recupera en paypal-capture-order.js al confirmar el pago — mismo papel
-- que session.metadata cumple en el flujo de Stripe.

create table if not exists paypal_pending_orders (
  order_id text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
alter table paypal_pending_orders enable row level security;
-- Sin políticas: solo la tocan las Functions con service_role (igual que
-- "payments" — nunca se lee ni se escribe desde el navegador ni con la clave
-- pública). Filas de más de un día son intentos de pago abandonados/nunca
-- completados; limpiarlas a mano de vez en cuando no es urgente.
revoke all on paypal_pending_orders from public, anon, authenticated;
grant select, insert, delete on paypal_pending_orders to service_role;

-- payments: columnas de Stripe se quedan tal cual (no se toca nada de lo que
-- ya funciona); se añaden las de PayPal + un "provider" para saber de un
-- vistazo en el panel de admin de qué pasarela vino cada cobro.
alter table payments add column if not exists provider text not null default 'stripe';
alter table payments add column if not exists paypal_order_id text unique;
alter table payments add column if not exists paypal_capture_id text;

-- confirm_client_purchase(): misma función, con dos parámetros NUEVOS al
-- final (p_paypal_order_id, p_paypal_capture_id), ambos opcionales — la
-- llamada que ya hace stripe-webhook.js sigue funcionando exactamente igual
-- sin tocarla, esos dos simplemente quedan NULL y el ledger sigue guardando
-- provider='stripe' como hasta ahora.
--
-- Postgres identifica una función por nombre + tipos de argumentos: añadir
-- parámetros cambia esa firma, así que hace falta borrar la versión de 13
-- argumentos antes de crear la de 15 o quedan las dos coexistiendo (una de
-- ellas sin usar y confundiendo a quien mire pg_proc después).
drop function if exists confirm_client_purchase(text, text, text, text, text, int, int, jsonb, boolean, text, text, text, int);
create or replace function confirm_client_purchase(
  p_email text, p_nombre text default null, p_plan_key text default null,
  p_plan_type text default null, p_arranque_tier text default null,
  p_permanencia_meses int default null, p_gift_period_days int default null,
  p_solutions jsonb default null, p_is_founder boolean default false,
  p_stripe_session_id text default null, p_stripe_payment_intent_id text default null,
  p_stripe_customer_id text default null, p_amount_total_cents int default null,
  p_paypal_order_id text default null, p_paypal_capture_id text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_client_id uuid; v_sol jsonb; v_provider text;
begin
  v_provider := case when p_paypal_order_id is not null then 'paypal' else 'stripe' end;

  insert into clients (email, nombre, status, plan_key, plan_type, arranque_tier, permanencia_meses, gift_period_days, contract_started_at, is_founder)
  values (p_email, p_nombre, 'cliente', p_plan_key, p_plan_type, p_arranque_tier, p_permanencia_meses, p_gift_period_days, now(), p_is_founder)
  on conflict (email) do update set status='cliente', nombre=coalesce(excluded.nombre,clients.nombre),
    plan_key=excluded.plan_key, plan_type=excluded.plan_type, arranque_tier=excluded.arranque_tier,
    permanencia_meses=excluded.permanencia_meses, gift_period_days=excluded.gift_period_days,
    contract_started_at=now(), renewal_reminder_sent_at=null, updated_at=now(),
    is_founder = clients.is_founder or excluded.is_founder
  returning id into v_client_id;

  insert into interactions (client_id, source, nota)
  values (v_client_id, 'checkout', 'Pago confirmado por ' || initcap(v_provider) || ' — plan: ' || coalesce(p_plan_key, '(sin clave)'));

  if p_solutions is not null and jsonb_typeof(p_solutions) = 'array' then
    delete from client_solutions where client_id = v_client_id;
    delete from client_automations where client_id = v_client_id;
    for v_sol in select * from jsonb_array_elements(p_solutions) loop
      insert into client_solutions (client_id, solution_key, solution_name, price_eur, is_free)
      values (v_client_id, v_sol->>'key', coalesce(v_sol->>'name', v_sol->>'key'),
              nullif(v_sol->>'price','')::numeric, coalesce((v_sol->>'free')::boolean, false))
      on conflict (client_id, solution_key) do nothing;

      insert into client_automations (client_id, solution_key, status)
      values (v_client_id, v_sol->>'key', 'pending')
      on conflict (client_id, solution_key) do nothing;
    end loop;
  end if;

  -- Ledger de pago: rama Stripe intacta; rama PayPal nueva, mismo "on
  -- conflict do nothing" por si la página de retorno se recarga y se llama
  -- dos veces a capture-order con la misma orden ya capturada.
  if p_stripe_session_id is not null and p_amount_total_cents is not null then
    insert into payments (client_id, provider, stripe_checkout_session_id, stripe_payment_intent_id,
      stripe_customer_id, amount_total_cents, status, plan_key, arranque_tier, is_founder_price)
    values (v_client_id, 'stripe', p_stripe_session_id, p_stripe_payment_intent_id,
      p_stripe_customer_id, p_amount_total_cents, 'completed', p_plan_key, p_arranque_tier, p_is_founder)
    on conflict (stripe_checkout_session_id) do nothing;
  elsif p_paypal_order_id is not null and p_amount_total_cents is not null then
    insert into payments (client_id, provider, paypal_order_id, paypal_capture_id,
      amount_total_cents, status, plan_key, arranque_tier, is_founder_price)
    values (v_client_id, 'paypal', p_paypal_order_id, p_paypal_capture_id,
      p_amount_total_cents, 'completed', p_plan_key, p_arranque_tier, p_is_founder)
    on conflict (paypal_order_id) do nothing;
  end if;

  return v_client_id;
end;
$$;
revoke all on function confirm_client_purchase(text, text, text, text, text, int, int, jsonb, boolean, text, text, text, int, text, text) from public, anon, authenticated;
grant execute on function confirm_client_purchase(text, text, text, text, text, int, int, jsonb, boolean, text, text, text, int, text, text) to service_role;

-- Prueba de humo (ejecutar a mano tras aplicar la migración):
-- 1. select confirm_client_purchase('prueba-paypal@ejemplo.com', 'Prueba PayPal', 'arranque-start',
--      'arranque', 'start', 12, null, '[]'::jsonb, false, null, null, null, 5900, 'ORDER_TEST_1', 'CAPTURE_TEST_1');
--    -- debe devolver un uuid y crear la fila en clients + una fila en payments con provider='paypal'.
-- 2. select * from payments where provider = 'paypal' order by created_at desc limit 1;
--    -- confirmar paypal_order_id/paypal_capture_id rellenos y stripe_* en NULL.
