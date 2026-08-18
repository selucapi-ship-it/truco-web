-- =============================================================================
-- MIGRACIÓN — Panel profesional: fecha de baja, reactivación y estadísticas
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase (pegar todo → Run).
-- Requiere migration_monstruo_overhaul.sql y migration_client_access_control.sql
-- ya aplicadas (usa is_founder(), deactivate_client(), confirm_client_purchase()
-- de 13 argumentos, payments, client_solutions, usage_events, solutions_catalog).
--
-- Idempotente a propósito, mismo criterio que las migraciones anteriores de
-- esta noche.
-- =============================================================================


-- =============================================================================
-- 1) clients.baja_at — fecha exacta de la última baja. Se limpia sola si el
--    cliente vuelve a pagar (ver confirm_client_purchase más abajo).
-- =============================================================================
alter table clients add column if not exists baja_at timestamptz;


-- =============================================================================
-- 2) deactivate_client() — mismo cuerpo que ya existe, añade baja_at = now().
--    Misma firma (p_client_id uuid) — create or replace basta, sin drop.
-- =============================================================================
create or replace function deactivate_client(p_client_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_founder() then
    raise exception 'Solo el founder puede dar de baja a un cliente';
  end if;
  update clients set status = 'baja', baja_at = now(), updated_at = now() where id = p_client_id;
end;
$$;
revoke all on function deactivate_client(uuid) from public, anon;
grant execute on function deactivate_client(uuid) to authenticated;


-- =============================================================================
-- 3) reactivate_client() — simétrica a deactivate_client(), founder-exclusiva.
--    Deshace una baja a mano, sin depender de un nuevo pago por Stripe.
-- =============================================================================
create or replace function reactivate_client(p_client_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_founder() then
    raise exception 'Solo el founder puede reactivar a un cliente';
  end if;
  update clients set status = 'cliente', baja_at = null, updated_at = now() where id = p_client_id;
end;
$$;
revoke all on function reactivate_client(uuid) from public, anon;
grant execute on function reactivate_client(uuid) to authenticated;


-- =============================================================================
-- 4) confirm_client_purchase() — mismo cuerpo de siempre (13 args), único
--    cambio: baja_at = null en la rama de conflicto, porque un cliente que
--    paga de nuevo deja de estar "de baja" — mismo criterio que ya aplica a
--    renewal_reminder_sent_at. Misma firma, sin drop.
-- =============================================================================
create or replace function confirm_client_purchase(
  p_email text, p_nombre text default null, p_plan_key text default null,
  p_plan_type text default null, p_arranque_tier text default null,
  p_permanencia_meses int default null, p_gift_period_days int default null,
  p_solutions jsonb default null, p_is_founder boolean default false,
  p_stripe_session_id text default null, p_stripe_payment_intent_id text default null,
  p_stripe_customer_id text default null, p_amount_total_cents int default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_client_id uuid; v_sol jsonb;
begin
  insert into clients (email, nombre, status, plan_key, plan_type, arranque_tier, permanencia_meses, gift_period_days, contract_started_at, is_founder)
  values (p_email, p_nombre, 'cliente', p_plan_key, p_plan_type, p_arranque_tier, p_permanencia_meses, p_gift_period_days, now(), p_is_founder)
  on conflict (email) do update set status='cliente', nombre=coalesce(excluded.nombre,clients.nombre),
    plan_key=excluded.plan_key, plan_type=excluded.plan_type, arranque_tier=excluded.arranque_tier,
    permanencia_meses=excluded.permanencia_meses, gift_period_days=excluded.gift_period_days,
    contract_started_at=now(), renewal_reminder_sent_at=null, baja_at=null, updated_at=now(),
    is_founder = clients.is_founder or excluded.is_founder
  returning id into v_client_id;

  insert into interactions (client_id, source, nota)
  values (v_client_id, 'checkout', 'Pago confirmado por Stripe — plan: ' || coalesce(p_plan_key, '(sin clave)'));

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
    insert into payments (client_id, stripe_checkout_session_id, stripe_payment_intent_id,
      stripe_customer_id, amount_total_cents, status, plan_key, arranque_tier, is_founder_price)
    values (v_client_id, p_stripe_session_id, p_stripe_payment_intent_id,
      p_stripe_customer_id, p_amount_total_cents, 'completed', p_plan_key, p_arranque_tier, p_is_founder)
    on conflict (stripe_checkout_session_id) do nothing;
  end if;

  return v_client_id;
end;
$$;
revoke all on function confirm_client_purchase(text, text, text, text, text, int, int, jsonb, boolean, text, text, text, int) from public, anon, authenticated;
grant execute on function confirm_client_purchase(text, text, text, text, text, int, int, jsonb, boolean, text, text, text, int) to service_role;


-- =============================================================================
-- 5) founder_dashboard_stats() — agregado único para la pestaña Estadísticas,
--    founder-exclusivo, mismo patrón que founder_weekly_digest(). Todo el
--    cálculo pesado se hace en el servidor, el navegador solo pinta jsonb.
-- =============================================================================
create or replace function founder_dashboard_stats() returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare v_result jsonb;
begin
  if not is_founder() then
    raise exception 'Solo el founder puede ver las estadísticas';
  end if;

  select jsonb_build_object(
    'total_clientes', (select count(*) from clients),

    'por_status', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (select status, count(*) n from clients group by status) s
    ),

    'por_tier', (
      select coalesce(jsonb_object_agg(arranque_tier, n), '{}'::jsonb)
      from (select arranque_tier, count(*) n from clients where arranque_tier is not null group by arranque_tier) s
    ),

    'por_sector', (
      select coalesce(jsonb_object_agg(coalesce(tipo, '(sin sector)'), n), '{}'::jsonb)
      from (select tipo, count(*) n from clients group by tipo) s
    ),

    'altas_por_mes', (
      select coalesce(jsonb_agg(jsonb_build_object('mes', to_char(mes, 'YYYY-MM'), 'n', n) order by mes), '[]'::jsonb)
      from (
        select date_trunc('month', contract_started_at) mes, count(*) n
        from clients where contract_started_at is not null
        group by 1
      ) s
    ),

    'bajas_por_mes', (
      select coalesce(jsonb_agg(jsonb_build_object('mes', to_char(mes, 'YYYY-MM'), 'n', n) order by mes), '[]'::jsonb)
      from (
        select date_trunc('month', baja_at) mes, count(*) n
        from clients where baja_at is not null
        group by 1
      ) s
    ),

    'ingresos_totales_cents', (
      select coalesce(sum(amount_total_cents), 0) from payments where status = 'completed'
    ),

    'ingresos_por_mes', (
      select coalesce(jsonb_agg(jsonb_build_object('mes', to_char(mes, 'YYYY-MM'), 'total_cents', total) order by mes), '[]'::jsonb)
      from (
        select date_trunc('month', created_at) mes, sum(amount_total_cents) total
        from payments where status = 'completed'
        group by 1
      ) s
    ),

    'ingresos_por_tier', (
      select coalesce(jsonb_object_agg(coalesce(arranque_tier, '(sin tier)'), total), '{}'::jsonb)
      from (
        select arranque_tier, sum(amount_total_cents) total
        from payments where status = 'completed'
        group by arranque_tier
      ) s
    ),

    'proximas_renovaciones', (
      select coalesce(jsonb_agg(jsonb_build_object('nombre', r.nombre, 'negocio', r.negocio, 'fecha', r.renewal_date)), '[]'::jsonb)
      from clients_due_for_renewal(30) r
    )
  ) into v_result;

  return v_result;
end;
$$;
revoke all on function founder_dashboard_stats() from public, anon;
grant execute on function founder_dashboard_stats() to authenticated;


-- =============================================================================
-- FIN — prueba de humo:
--   1. Como founder: sb.rpc('founder_dashboard_stats') debe devolver el jsonb
--      completo con los clientes/pagos de prueba que ya existen.
--   2. deactivate_client() sobre un cliente de prueba → confirmar baja_at
--      relleno; reactivate_client() sobre el mismo → confirmar baja_at=null
--      y status='cliente'.
--   3. Un colaborador sin ser founder intenta sb.rpc('founder_dashboard_stats')
--      → debe fallar con la excepción explícita.
-- =============================================================================
