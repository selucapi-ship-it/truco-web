-- =============================================================================
-- MIGRACIÓN — Panel "TruKi": registro de instancias, uso remoto y baja remota
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase del sitio
-- PRINCIPAL de TRUCO (no el de un cliente de TruKi) → pegar todo → Run.
-- Requiere migration_monstruo_overhaul.sql y migration_client_access_control.sql
-- ya aplicadas (usa is_founder(), clients, client_solutions).
--
-- Cada cliente de TruKi tiene su propio proyecto Supabase aislado — esta
-- migración NO toca sus datos. Solo crea, aquí en el sitio principal, un
-- registro ligero de "qué instancias de TruKi existen, cómo llamarlas, y qué
-- resumen de uso han reportado" — las facturas de verdad nunca salen de la
-- instancia de cada cliente.
--
-- Idempotente a propósito, mismo criterio que las migraciones anteriores.
-- =============================================================================

create extension if not exists pgcrypto;

-- =============================================================================
-- 1) truki_instances — una fila por cliente con TruKi.
-- =============================================================================
create table if not exists truki_instances (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  netlify_site_id text,
  netlify_site_url text,
  supabase_project_ref text,
  supabase_url text,
  master_secret text not null,
  status text not null default 'provisioning' check (status in ('provisioning','active','suspended','failed')),
  provisioning_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists truki_instances_client_idx on truki_instances(client_id);

-- =============================================================================
-- 2) truki_usage_snapshots — foto del estado actual de uso de cada instancia,
--    se sobrescribe en cada reporte (no histórico — para eso ya está
--    truki_events dentro de cada instancia).
-- =============================================================================
create table if not exists truki_usage_snapshots (
  instance_id uuid primary key references truki_instances(id) on delete cascade,
  facturas_mes int not null default 0,
  presupuestos_mes int not null default 0,
  facturas_total int not null default 0,
  presupuestos_total int not null default 0,
  errores_7d int not null default 0,
  ultimo_error text,
  ultimo_error_at timestamptz,
  reported_at timestamptz not null default now()
);

-- =============================================================================
-- 3) RLS — solo el founder puede leer esto desde el navegador. Las escrituras
--    (registrar instancia, guardar un reporte de uso, cambiar de estado) pasan
--    siempre por Netlify Functions con service_role, nunca directas desde el
--    cliente — igual que el resto de tablas sensibles del sitio principal.
-- =============================================================================
alter table truki_instances enable row level security;
drop policy if exists "founder read truki_instances" on truki_instances;
create policy "founder read truki_instances" on truki_instances for select using (is_founder());

alter table truki_usage_snapshots enable row level security;
drop policy if exists "founder read truki_usage_snapshots" on truki_usage_snapshots;
create policy "founder read truki_usage_snapshots" on truki_usage_snapshots for select using (is_founder());

-- =============================================================================
-- 4) truki_register_instance() — registra (o actualiza) la instancia de un
--    cliente que YA existe hoy, sin tener que escribir SQL a mano. Genera el
--    master_secret aquí mismo (no hay que inventarse "algo aleatorio seguro")
--    y lo devuelve una única vez para pegarlo como TRUKI_MASTER_SECRET en las
--    variables de entorno de Netlify de esa instancia.
-- =============================================================================
create or replace function truki_register_instance(
  p_client_id uuid, p_netlify_site_url text, p_supabase_url text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_secret text; v_id uuid;
begin
  if not is_founder() then
    raise exception 'Solo el founder puede registrar una instancia de TruKi';
  end if;

  v_secret := encode(gen_random_bytes(24), 'hex');

  insert into truki_instances (client_id, netlify_site_url, supabase_url, master_secret, status)
  values (p_client_id, p_netlify_site_url, p_supabase_url, v_secret, 'active')
  on conflict (client_id) do update set
    netlify_site_url = excluded.netlify_site_url,
    supabase_url = excluded.supabase_url,
    master_secret = excluded.master_secret,
    status = 'active',
    provisioning_error = null,
    updated_at = now()
  returning id into v_id;

  insert into client_solutions (client_id, solution_key, solution_name, price_eur, is_free)
  values (p_client_id, 'truki', 'Facturación automática (TruKi)', 580, false)
  on conflict (client_id, solution_key) do nothing;

  return jsonb_build_object('instance_id', v_id, 'master_secret', v_secret);
end;
$$;
revoke all on function truki_register_instance(uuid, text, text) from public, anon;
grant execute on function truki_register_instance(uuid, text, text) to authenticated;

-- =============================================================================
-- 5) founder_truki_overview() — todas las instancias + su cliente + su último
--    reporte de uso, en un único jsonb. Mismo patrón que founder_dashboard_stats().
-- =============================================================================
create or replace function founder_truki_overview() returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare v_result jsonb;
begin
  if not is_founder() then
    raise exception 'Solo el founder puede ver esto';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'instance_id', ti.id,
    'client_id', ti.client_id,
    'nombre', c.nombre,
    'negocio', c.negocio,
    'email', c.email,
    'telefono', c.telefono,
    'netlify_site_url', ti.netlify_site_url,
    'status', ti.status,
    'provisioning_error', ti.provisioning_error,
    'created_at', ti.created_at,
    'facturas_mes', coalesce(u.facturas_mes, 0),
    'presupuestos_mes', coalesce(u.presupuestos_mes, 0),
    'facturas_total', coalesce(u.facturas_total, 0),
    'presupuestos_total', coalesce(u.presupuestos_total, 0),
    'errores_7d', coalesce(u.errores_7d, 0),
    'ultimo_error', u.ultimo_error,
    'ultimo_error_at', u.ultimo_error_at,
    'reported_at', u.reported_at
  ) order by ti.created_at desc), '[]'::jsonb)
  into v_result
  from truki_instances ti
  join clients c on c.id = ti.client_id
  left join truki_usage_snapshots u on u.instance_id = ti.id;

  return v_result;
end;
$$;
revoke all on function founder_truki_overview() from public, anon;
grant execute on function founder_truki_overview() to authenticated;

-- =============================================================================
-- FIN — prueba de humo:
--   1. Como founder: sb.rpc('truki_register_instance', {...}) sobre un cliente
--      de prueba debe devolver { instance_id, master_secret }.
--   2. sb.rpc('founder_truki_overview') debe devolver esa instancia con
--      contadores en 0 (aún no ha reportado nada).
--   3. Un colaborador sin ser founder: ambas llamadas deben fallar con la
--      excepción explícita.
-- =============================================================================
