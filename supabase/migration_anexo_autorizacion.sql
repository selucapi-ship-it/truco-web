-- ── ACEPTACIÓN DEL ANEXO DE AUTORIZACIÓN DE ACCESOS Y TRATAMIENTO DE DATOS ──
--
-- Registra, junto a cada pago, que el cliente aceptó el Anexo de Autorización
-- de Accesos y Tratamiento de Datos (autorizacion-accesos.html) en el momento
-- de contratar — checkbox obligatorio en pago.html, validado también en
-- servidor (create-checkout.js/create-paypal-order.js/create-bank-transfer-order.js
-- rechazan la petición si no viene marcado). No basta con el checkbox en sí:
-- lo que prueba la aceptación de verdad es esta fila en "payments" con quién,
-- cuándo y qué versión del documento aceptó — ver LSSI-CE art. 23 y Ley
-- 7/1998 de condiciones generales (el adherente debe poder demostrarse que
-- se le facilitó un ejemplar accesible antes de aceptar).

alter table payments add column if not exists anexo_aceptado boolean not null default false;
alter table payments add column if not exists anexo_version text;

-- DROP necesario: se añaden 2 parámetros nuevos al final — Postgres identifica
-- las funciones por su firma completa (mismo motivo que en
-- migration_bank_transfer_orders.sql).
drop function if exists public.confirm_client_purchase(text, text, text, text, text, integer, integer, jsonb, boolean, text, text, text, integer, text, text, text);

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
  p_transfer_reference text default null,
  p_anexo_aceptado boolean default false,
  p_anexo_version text default null
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
      stripe_customer_id, amount_total_cents, status, plan_key, arranque_tier, is_founder_price,
      anexo_aceptado, anexo_version)
    values (v_client_id, 'stripe', p_stripe_session_id, p_stripe_payment_intent_id,
      p_stripe_customer_id, p_amount_total_cents, 'completed', p_plan_key, p_arranque_tier, p_is_founder,
      p_anexo_aceptado, p_anexo_version)
    on conflict (stripe_checkout_session_id) do nothing;
  elsif p_paypal_order_id is not null and p_amount_total_cents is not null then
    insert into payments (client_id, provider, paypal_order_id, paypal_capture_id,
      amount_total_cents, status, plan_key, arranque_tier, is_founder_price,
      anexo_aceptado, anexo_version)
    values (v_client_id, 'paypal', p_paypal_order_id, p_paypal_capture_id,
      p_amount_total_cents, 'completed', p_plan_key, p_arranque_tier, p_is_founder,
      p_anexo_aceptado, p_anexo_version)
    on conflict (paypal_order_id) do nothing;
  elsif p_transfer_reference is not null and p_amount_total_cents is not null then
    insert into payments (client_id, provider, transfer_reference,
      amount_total_cents, status, plan_key, arranque_tier, is_founder_price,
      anexo_aceptado, anexo_version)
    values (v_client_id, 'transfer', p_transfer_reference,
      p_amount_total_cents, 'completed', p_plan_key, p_arranque_tier, p_is_founder,
      p_anexo_aceptado, p_anexo_version)
    on conflict (transfer_reference) do nothing;
  end if;

  return v_client_id;
end;
$function$;

revoke all on function public.confirm_client_purchase(text, text, text, text, text, integer, integer, jsonb, boolean, text, text, text, integer, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.confirm_client_purchase(text, text, text, text, text, integer, integer, jsonb, boolean, text, text, text, integer, text, text, text, boolean, text) to service_role;

-- Prueba de humo (comentada — descomentar para probar a mano en el SQL Editor):
-- select confirm_client_purchase('prueba-anexo@ejemplo.com', 'Prueba Anexo', 'arranque-start',
--   'arranque', 'start', 12, null, null, false, null, null, null, 88165,
--   null, null, null, true, '2026-09-17');
-- select id, provider, anexo_aceptado, anexo_version from payments where client_id in
--   (select id from clients where email = 'prueba-anexo@ejemplo.com');
-- Limpieza tras probar:
-- delete from clients where email = 'prueba-anexo@ejemplo.com';
