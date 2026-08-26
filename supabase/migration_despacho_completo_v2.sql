-- =============================================================================
-- MIGRACIÓN — "Despacho completo" v2: las 3 recomendaciones de la re-auditoría
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase (pegar todo → Run).
-- Requiere migration_monstruo_overhaul.sql, migration_despacho_completo.sql,
-- migration_fiscalidad.sql, migration_fiscalidad_v2.sql, migration_pricing_offers.sql
-- y migration_quotes.sql ya aplicadas.
--
-- Qué añade:
--   1) Auditoría también sobre Fiscalidad, Contrataciones y Precios/Presupuestos
--      — hoy audit_log no veía nada de eso (ver migration_monstruo_overhaul.sql:504-547).
--   2) Limpieza de la arquitectura vieja de TruKi ("un Supabase por cliente",
--      migration_truki_control.sql) — sustituida por el proyecto compartido
--      "Truki Oficial" que usan truki-overview.js y compañía; cero código vivo
--      la sigue llamando.
--   3) MRR real y churn en founder_dashboard_stats() — usando los pagos reales
--      de domiciliación que ya registra log_domiciliacion_payment().
--
-- Idempotente a propósito, mismo criterio que las migraciones anteriores.
-- =============================================================================


-- =============================================================================
-- 1) Auditoría — cubrir Fiscalidad, Contrataciones y Precios/Presupuestos
-- =============================================================================
drop trigger if exists audit_fiscal_income on fiscal_income;
create trigger audit_fiscal_income after insert or update or delete on fiscal_income
  for each row execute function audit_row_change();

drop trigger if exists audit_fiscal_expenses on fiscal_expenses;
create trigger audit_fiscal_expenses after insert or update or delete on fiscal_expenses
  for each row execute function audit_row_change();

drop trigger if exists audit_fiscal_expense_templates on fiscal_expense_templates;
create trigger audit_fiscal_expense_templates after insert or update or delete on fiscal_expense_templates
  for each row execute function audit_row_change(); -- las "contrataciones" que paga el founder cada mes

drop trigger if exists audit_pricing_offers on pricing_offers;
create trigger audit_pricing_offers after insert or update or delete on pricing_offers
  for each row execute function audit_row_change();

drop trigger if exists audit_quotes on quotes;
create trigger audit_quotes after insert or update or delete on quotes
  for each row execute function audit_row_change();


-- =============================================================================
-- 2) Limpieza — arquitectura vieja de TruKi ("un Supabase por cliente")
-- =============================================================================
-- Sustituida por el proyecto Supabase COMPARTIDO "Truki Oficial" que usan
-- truki-overview.js / truki-client-detail.js / truki-client-action.js /
-- truki-client-create.js. Nada llama ya a truki_register_instance() ni a
-- founder_truki_overview() (panel.html no las referencia salvo un comentario
-- histórico), ni a las Functions truki-remote-manage.js / truki-usage-intake.js
-- (borradas en este mismo cambio). Se borran en orden: función que depende de
-- las tablas -> tabla hija -> tabla padre.
drop function if exists founder_truki_overview();
drop function if exists truki_register_instance(uuid, text, text);
drop table if exists truki_usage_snapshots;
drop table if exists truki_instances;


-- =============================================================================
-- 3) MRR real y churn — founder_dashboard_stats()
-- =============================================================================
-- mrr_potencial_cents: lo que DEBERÍA entrar cada mes según los clientes con
-- domiciliación activa hoy (mismo cálculo que "sugerido" en loadCobros() del
-- panel: precio del Departamento si tiene arranque_tier, si no la suma de sus
-- soluciones sueltas no gratuitas) — usa tier_config_effective, que ya
-- incorpora ofertas activas de pricing_offers.
-- mrr_cobrado_mes_cents: lo que YA se ha marcado como cobrado este mes de
-- verdad, vía log_domiciliacion_payment() (mismo mecanismo que usa Cobros).
-- bajas_ultimos_3_meses / clientes_activos_ahora: cifras crudas para que el
-- panel calcule una tasa de baja aproximada — sin inventar una fórmula
-- artificialmente precisa sobre una base de datos todavía pequeña.
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
    ),

    'mrr_potencial_cents', (
      select coalesce(sum(
        case
          when c.arranque_tier is not null then
            coalesce((select round(tce.founder_price_eur * 100) from tier_config_effective tce where tce.tier = c.arranque_tier), 0)
          else
            coalesce((select round(sum(cs.price_eur) * 100) from client_solutions cs where cs.client_id = c.id and cs.is_free = false), 0)
        end
      ), 0)::bigint
      from clients c
      where c.domiciliacion_activa = true and c.status = 'cliente'
    ),

    'mrr_cobrado_mes_cents', (
      select coalesce(sum(amount_total_cents), 0)
      from payments
      where status = 'completed'
        and stripe_checkout_session_id like 'domiciliacion-%'
        and created_at >= date_trunc('month', now())
    ),

    'bajas_ultimos_3_meses', (
      select count(*) from clients where baja_at >= now() - interval '3 months'
    ),

    'clientes_activos_ahora', (select count(*) from clients where status = 'cliente')
  ) into v_result;

  return v_result;
end;
$$;
revoke all on function founder_dashboard_stats() from public, anon;
grant execute on function founder_dashboard_stats() to authenticated;


-- =============================================================================
-- FIN — prueba de humo:
--   1. Cambiar un gasto fijo (Contrataciones) o una oferta de precio, abrir
--      Auditoría y filtrar por esa tabla → debe aparecer la fila.
--   2. select * from truki_instances; -- debe fallar con "no existe" (tabla borrada).
--   3. sb.rpc('founder_dashboard_stats') como founder → confirmar que trae
--      mrr_potencial_cents, mrr_cobrado_mes_cents, bajas_ultimos_3_meses y
--      clientes_activos_ahora sin error.
-- =============================================================================
