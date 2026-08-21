-- =============================================================================
-- MIGRACIÓN — Alta manual de clientes desde el panel (sin pasar por Stripe)
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase del sitio
-- PRINCIPAL de TRUCO → pegar todo → Run.
-- Requiere migration_monstruo_overhaul.sql y migration_client_access_control.sql
-- ya aplicadas (usa is_founder(), clients, client_solutions, client_automations,
-- solutions_catalog, interactions).
--
-- Hasta ahora la única forma de que apareciera un cliente en `clients` era que
-- pagara por Stripe (confirm_client_purchase). Pero el founder atiende altas
-- por teléfono, o regala algún servicio — necesita poder crear el cliente él
-- mismo desde el panel, con o sin las soluciones que le vaya a dar, sin
-- depender de un pago real.
--
-- Idempotente a propósito, mismo criterio que las migraciones anteriores.
-- =============================================================================

create or replace function create_client_manual(
  p_nombre text,
  p_email text,
  p_telefono text default null,
  p_negocio text default null,
  p_tipo text default null,
  p_solutions text[] default null
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

  insert into clients (nombre, email, telefono, negocio, tipo, status, contract_started_at)
  values (p_nombre, p_email, p_telefono, p_negocio, p_tipo, 'cliente', now())
  on conflict (email) do update set
    nombre = coalesce(excluded.nombre, clients.nombre),
    telefono = coalesce(excluded.telefono, clients.telefono),
    negocio = coalesce(excluded.negocio, clients.negocio),
    tipo = coalesce(excluded.tipo, clients.tipo),
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
revoke all on function create_client_manual(text, text, text, text, text, text[]) from public, anon;
grant execute on function create_client_manual(text, text, text, text, text, text[]) to authenticated;

-- =============================================================================
-- FIN — prueba de humo:
--   1. Como founder: sb.rpc('create_client_manual', {p_nombre:'Prueba', p_email:
--      'prueba@ejemplo.com', p_solutions: ['truki']}) debe devolver un uuid, y
--      ese cliente debe aparecer en la lista con status "Cliente" y con TruKi
--      en su sección Económico.
--   2. Un colaborador sin ser founder: la misma llamada debe fallar con la
--      excepción explícita.
-- =============================================================================
