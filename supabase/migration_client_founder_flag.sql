-- Guarda si un cliente compró a precio de fundador, para poder enseñárselo
-- en su portal (corona + precio de fundador congelado para siempre). Hasta
-- ahora ese dato solo vivía de paso en stripe-webhook.js (para decrementar
-- founding_spots) y nunca se guardaba en la ficha del cliente.
-- Ejecutar una sola vez en Supabase (SQL Editor → pegar → Run).
-- Requiere migration_client_portal.sql ya aplicada.

alter table clients add column if not exists is_founder boolean not null default false;

-- Añade p_is_founder a confirm_client_purchase (llamada desde
-- netlify/functions/stripe-webhook.js). Una vez marcado fundador, una
-- renovación NO founder no debe desmarcarlo — por eso usa coalesce contra el
-- valor ya guardado en vez de sobreescribir siempre con el nuevo valor.
-- "create or replace" NO sustituye una función existente si la lista de
-- parámetros no coincide exactamente (Postgres las trata como sobrecargas
-- distintas) — sin este drop explícito de la firma antigua (sin
-- p_is_founder), quedarían dos confirm_client_purchase compitiendo y
-- cualquier referencia sin argumentos (como el revoke/grant de abajo)
-- fallaría con "function name is not unique".
drop function if exists confirm_client_purchase(text, text, text, text, text, int, int, jsonb);
create or replace function confirm_client_purchase(
  p_email text, p_nombre text default null, p_plan_key text default null,
  p_plan_type text default null, p_arranque_tier text default null,
  p_permanencia_meses int default null, p_gift_period_days int default null,
  p_solutions jsonb default null, p_is_founder boolean default false
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_client_id uuid; v_sol jsonb;
begin
  insert into clients (email, nombre, status, plan_key, plan_type, arranque_tier, permanencia_meses, gift_period_days, contract_started_at, is_founder)
  values (p_email, p_nombre, 'cliente', p_plan_key, p_plan_type, p_arranque_tier, p_permanencia_meses, p_gift_period_days, now(), p_is_founder)
  on conflict (email) do update set status='cliente', nombre=coalesce(excluded.nombre,clients.nombre),
    plan_key=excluded.plan_key, plan_type=excluded.plan_type, arranque_tier=excluded.arranque_tier,
    permanencia_meses=excluded.permanencia_meses, gift_period_days=excluded.gift_period_days,
    contract_started_at=now(), renewal_reminder_sent_at=null, updated_at=now(),
    is_founder = clients.is_founder or excluded.is_founder
  returning id into v_client_id;

  insert into interactions (client_id, source, nota)
  values (v_client_id, 'checkout', 'Pago confirmado por Stripe — plan: ' || coalesce(p_plan_key, '(sin clave)'));

  if p_solutions is not null and jsonb_typeof(p_solutions) = 'array' then
    delete from client_solutions where client_id = v_client_id; -- evita arrastrar soluciones de un tier anterior en una renovación
    for v_sol in select * from jsonb_array_elements(p_solutions) loop
      insert into client_solutions (client_id, solution_key, solution_name, price_eur, is_free)
      values (v_client_id, v_sol->>'key', coalesce(v_sol->>'name', v_sol->>'key'),
              nullif(v_sol->>'price','')::numeric, coalesce((v_sol->>'free')::boolean, false))
      on conflict (client_id, solution_key) do nothing;
    end loop;
  end if;
  return v_client_id;
end;
$$;
revoke all on function confirm_client_purchase(text, text, text, text, text, int, int, jsonb, boolean) from public, anon, authenticated;
grant execute on function confirm_client_purchase(text, text, text, text, text, int, int, jsonb, boolean) to service_role;
