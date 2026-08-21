-- =============================================================================
-- MIGRACIÓN — Departamento en el alta manual + datos de domiciliación/cobro
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase del sitio
-- PRINCIPAL de TRUCO → pegar todo → Run.
-- Requiere migration_manual_client_signup.sql ya aplicada (create_client_manual).
--
-- Dos cosas:
--   1) create_client_manual() ahora acepta también el Departamento
--      (arranque_tier: start/basic/lite/pro) al dar de alta.
--   2) Nuevos campos en `clients` para saber si un cliente tiene domiciliado
--      el cobro (IBAN, titular, si está activa) — founder-exclusivo para
--      editar, igual que el resto de acciones económicas del panel.
--
-- Idempotente a propósito, mismo criterio que las migraciones anteriores.
-- =============================================================================

-- =============================================================================
-- 1) create_client_manual() — añade p_arranque_tier (mismo nombre de función,
--    argumentos nuevos con default → hay que hacer drop porque cambia la firma).
-- =============================================================================
drop function if exists create_client_manual(text, text, text, text, text, text[]);

create or replace function create_client_manual(
  p_nombre text,
  p_email text,
  p_telefono text default null,
  p_negocio text default null,
  p_tipo text default null,
  p_solutions text[] default null,
  p_arranque_tier text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_client_id uuid; v_sol text;
begin
  if not is_founder() then
    raise exception 'Solo el founder puede dar de alta clientes nuevos';
  end if;

  if p_email is null or p_email = '' then
    raise exception 'Falta el email del cliente';
  end if;
  if p_arranque_tier is not null and p_arranque_tier not in ('start','basic','lite','pro') then
    raise exception 'Departamento inválido';
  end if;

  insert into clients (nombre, email, telefono, negocio, tipo, status, contract_started_at, arranque_tier)
  values (p_nombre, p_email, p_telefono, p_negocio, p_tipo, 'cliente', now(), p_arranque_tier)
  on conflict (email) do update set
    nombre = coalesce(excluded.nombre, clients.nombre),
    telefono = coalesce(excluded.telefono, clients.telefono),
    negocio = coalesce(excluded.negocio, clients.negocio),
    tipo = coalesce(excluded.tipo, clients.tipo),
    arranque_tier = coalesce(excluded.arranque_tier, clients.arranque_tier),
    status = 'cliente',
    baja_at = null,
    contract_started_at = coalesce(clients.contract_started_at, now()),
    updated_at = now()
  returning id into v_client_id;

  insert into interactions (client_id, source, nota)
  values (v_client_id, 'manual', 'Alta manual desde el panel.');

  if p_solutions is not null then
    foreach v_sol in array p_solutions loop
      insert into client_solutions (client_id, solution_key, solution_name, price_eur, is_free)
      select v_client_id, sc.solution_key, sc.name, sc.price_eur, false
      from solutions_catalog sc where sc.solution_key = v_sol
      on conflict (client_id, solution_key) do nothing;

      insert into client_automations (client_id, solution_key, status)
      values (v_client_id, v_sol, 'pending')
      on conflict (client_id, solution_key) do nothing;
    end loop;
  end if;

  return v_client_id;
end;
$$;
revoke all on function create_client_manual(text, text, text, text, text, text[], text) from public, anon;
grant execute on function create_client_manual(text, text, text, text, text, text[], text) to authenticated;

-- =============================================================================
-- 2) Domiciliación / cobro — para saber de un vistazo si un cliente tiene el
--    pago en orden, sin tener que ir a buscarlo en ningún otro sitio.
-- =============================================================================
alter table clients add column if not exists iban text;
alter table clients add column if not exists titular_cuenta text;
alter table clients add column if not exists domiciliacion_activa boolean not null default false;
alter table clients add column if not exists domiciliacion_fecha timestamptz;

create or replace function update_client_banking(
  p_client_id uuid, p_iban text, p_titular_cuenta text, p_domiciliacion_activa boolean
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_founder() then
    raise exception 'Solo el founder puede editar los datos de cobro';
  end if;

  update clients set
    iban = nullif(trim(p_iban), ''),
    titular_cuenta = nullif(trim(p_titular_cuenta), ''),
    domiciliacion_activa = p_domiciliacion_activa,
    domiciliacion_fecha = case
      when p_domiciliacion_activa and not clients.domiciliacion_activa then now()
      when not p_domiciliacion_activa then null
      else clients.domiciliacion_fecha
    end,
    updated_at = now()
  where id = p_client_id;
end;
$$;
revoke all on function update_client_banking(uuid, text, text, boolean) from public, anon;
grant execute on function update_client_banking(uuid, text, text, boolean) to authenticated;

-- =============================================================================
-- FIN — prueba de humo:
--   1. Como founder: sb.rpc('create_client_manual', {p_nombre:'Prueba', p_email:
--      'prueba2@ejemplo.com', p_arranque_tier:'lite', p_solutions: ['whatsapp','llamadas']})
--      debe devolver un uuid, y ese cliente debe aparecer con Departamento "Lite™".
--   2. sb.rpc('update_client_banking', {p_client_id: '<uuid>', p_iban:
--      'ES0000000000000000000000', p_titular_cuenta:'Prueba', p_domiciliacion_activa:true})
--      debe guardar el IBAN y poner domiciliacion_fecha a la fecha de hoy.
--   3. Un colaborador sin ser founder: ambas llamadas deben fallar con la
--      excepción explícita.
-- =============================================================================
