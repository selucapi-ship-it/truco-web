-- ── TRANSFERENCIA BANCARIA COMO MÉTODO DE PAGO ──
--
-- Tercera vía de pago en pago.html, junto a Stripe (tarjeta) y PayPal.
-- A diferencia de esas dos, aquí NO hay confirmación automática al instante
-- — el cliente transfiere a mano y el founder confirma manualmente en el
-- panel de admin en cuanto lo ve en su banco (mismo espíritu que "Cobros
-- recurrentes", que ya existía para la domiciliación bancaria: el banco no
-- avisa solo al sistema, así que hay un botón para marcarlo).
--
-- Por qué SÍ lleva el mismo 12% de descuento que el pago único con tarjeta:
-- es un pago único real, y además no tiene NINGUNA comisión de procesador
-- (Stripe cobra 1,5%+0,25€, PayPal 2,9%+0,35€) — tratarla peor que la
-- tarjeta no tendría ninguna justificación de coste real.

create table if not exists bank_transfer_orders (
  id uuid primary key default gen_random_uuid(),
  reference_code text not null unique,
  payload jsonb not null,
  status text not null default 'pendiente' check (status in ('pendiente','confirmado','cancelado')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

-- Mismo patrón que paypal_pending_orders: RLS activado, cero políticas ⇒
-- solo la service_role (usada por las Netlify Functions) puede leer/escribir.
-- Nadie con la clave pública (anon), expuesta en el propio pago.html, puede
-- ver ni tocar estos pedidos pendientes directamente.
alter table bank_transfer_orders enable row level security;

alter table payments add column if not exists transfer_reference text unique;

-- DROP necesario: cambia la lista de parámetros (se añade uno nuevo al
-- final), y Postgres identifica a las funciones por su firma completa —
-- sin el DROP se quedaría la versión de 15 parámetros huérfana sin uso.
drop function if exists public.confirm_client_purchase(text, text, text, text, text, integer, integer, jsonb, boolean, text, text, text, integer, text, text);

create or replace function public.confirm_client_purchase(
  p_email text,
  p_nombre text default null,
  p_plan_key text default null,
  p_plan_type text default null,
  p_arranque_tier text default null,
  p_permanencia_meses integer default null,
  p_gift_period_days integer default null,
  p_solutions jsonb default null,
  p_is_founder boolean default false,
  p_stripe_session_id text default null,
  p_stripe_payment_intent_id text default null,
  p_stripe_customer_id text default null,
  p_amount_total_cents integer default null,
  p_paypal_order_id text default null,
  p_paypal_capture_id text default null,
  p_transfer_reference text default null
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_client_id uuid; v_sol jsonb; v_provider text;
begin
  v_provider := case
    when p_paypal_order_id is not null then 'paypal'
    when p_transfer_reference is not null then 'transfer'
    else 'stripe'
  end;

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
  elsif p_transfer_reference is not null and p_amount_total_cents is not null then
    insert into payments (client_id, provider, transfer_reference,
      amount_total_cents, status, plan_key, arranque_tier, is_founder_price)
    values (v_client_id, 'transfer', p_transfer_reference,
      p_amount_total_cents, 'completed', p_plan_key, p_arranque_tier, p_is_founder)
    on conflict (transfer_reference) do nothing;
  end if;

  return v_client_id;
end;
$function$;
