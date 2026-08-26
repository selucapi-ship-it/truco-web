-- =============================================================================
-- MIGRACIÓN — "Despacho completo": 4 huecos cerrados tras la auditoría
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase (pegar todo → Run).
-- Requiere: migration_monstruo_overhaul.sql, migration_client_access_control.sql,
-- migration_fiscalidad.sql y migration_fiscalidad_v2.sql ya aplicadas.
--
-- Qué añade:
--   1) Contrataciones — vínculo real plantilla↔gasto (antes se emparejaba por
--      texto del concepto), periodicidad, fecha de renovación.
--   2) Nada nuevo en base de datos — audit_log y su política ya existían,
--      solo faltaba la pantalla (eso va en admin/panel.html).
--   3) Motivo de baja + dos etapas de pipeline antes de "cliente".
--   4) log_domiciliacion_payment() — registra el cobro mensual real de un
--      cliente con domiciliación activa, reutilizando el trigger que ya
--      vuelca payments -> fiscal_income sin tocarlo.
--
-- Idempotente a propósito, mismo criterio que las migraciones anteriores.
-- =============================================================================


-- =============================================================================
-- 1) Contrataciones — vínculo real, periodicidad, renovación
-- =============================================================================
alter table fiscal_expense_templates add column if not exists periodicidad text not null default 'mensual'
  check (periodicidad in ('mensual', 'trimestral', 'anual'));
alter table fiscal_expense_templates add column if not exists proxima_renovacion date;
alter table fiscal_expense_templates add column if not exists url_panel text;

alter table fiscal_expenses add column if not exists template_id uuid references fiscal_expense_templates(id) on delete set null;


-- =============================================================================
-- 3) Ciclo de vida de clientes — motivo de baja + pipeline con 2 etapas más
-- =============================================================================
alter table clients add column if not exists motivo_baja text;

alter table clients drop constraint if exists clients_status_check;
alter table clients add constraint clients_status_check
  check (status in ('nuevo', 'contactado', 'propuesta_enviada', 'negociando', 'cliente', 'descartado', 'baja'));

-- OJO: create or replace NO sustituye deactivate_client(uuid) por esta nueva
-- versión de 2 argumentos — Postgres las trata como funciones distintas por
-- número de parámetros, y dejar las dos vivas a la vez confunde a PostgREST
-- ("Could not choose the best candidate function"). Se borra la vieja antes.
drop function if exists deactivate_client(uuid);
create or replace function deactivate_client(p_client_id uuid, p_motivo text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_founder() then
    raise exception 'Solo el founder puede dar de baja a un cliente';
  end if;
  update clients set status = 'baja', baja_at = now(), motivo_baja = left(p_motivo, 500), updated_at = now()
  where id = p_client_id;
end;
$$;
revoke all on function deactivate_client(uuid, text) from public, anon;
grant execute on function deactivate_client(uuid, text) to authenticated;
-- panel.html ya llama siempre con p_client_id + p_motivo (aunque sea null),
-- así que no queda ninguna llamada usando la firma antigua de 1 argumento.


-- =============================================================================
-- 4) Ingresos recurrentes reales — registrar un cobro de domiciliación
-- =============================================================================
-- Reutiliza la tabla payments tal cual (sin columnas nuevas): el
-- stripe_checkout_session_id sintético "domiciliacion-<client_id>-<anio>-<mes>"
-- hace de clave de deduplicación natural por cliente+mes, y como es un
-- insert con status='completed', el trigger fiscal_income_sync_from_payment()
-- (ya existente, migration_fiscalidad.sql) lo vuelca solo a fiscal_income —
-- el trimestral lo recoge sin tocar ese trigger para nada.
create or replace function log_domiciliacion_payment(
  p_client_id uuid, p_amount_total_cents int, p_anio int, p_mes int
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_session_id text; v_payment_id uuid;
begin
  if not is_founder() then
    raise exception 'Solo el founder puede registrar cobros de domiciliación';
  end if;
  if p_amount_total_cents is null or p_amount_total_cents <= 0 then
    raise exception 'El importe debe ser mayor que cero';
  end if;
  v_session_id := 'domiciliacion-' || p_client_id::text || '-' || p_anio::text || '-' || lpad(p_mes::text, 2, '0');
  insert into payments (client_id, stripe_checkout_session_id, amount_total_cents, status, metadata)
  values (p_client_id, v_session_id, p_amount_total_cents, 'completed', jsonb_build_object('origen', 'domiciliacion_manual'))
  on conflict (stripe_checkout_session_id) do nothing
  returning id into v_payment_id;
  return v_payment_id;
end;
$$;
revoke all on function log_domiciliacion_payment(uuid, int, int, int) from public, anon;
grant execute on function log_domiciliacion_payment(uuid, int, int, int) to authenticated;


-- =============================================================================
-- FIN — prueba de humo:
--   1. Crear una plantilla de "gasto fijo" con proxima_renovacion a 3 días
--      vista y periodicidad 'mensual', aplicarla dos veces seguidas desde el
--      panel → debe crear el gasto la primera vez (con template_id relleno)
--      y NO duplicarlo la segunda.
--   2. select * from audit_log order by created_at desc limit 5; — confirmar
--      que ya hay filas (se escribe solo, desde hace tiempo).
--   3. Dar de baja a un cliente de prueba con un motivo → confirmar
--      select motivo_baja from clients where id = '...'; lo devuelve.
--   4. select log_domiciliacion_payment('<client_id de prueba>', 9900, 2026, 8);
--      dos veces seguidas → confirmar que solo hay una fila en payments con
--      ese cliente y ese mes (select * from payments where
--      stripe_checkout_session_id like 'domiciliacion-%-2026-08';), y que
--      fiscal_income tiene ya la fila correspondiente (mismo payment_id).
-- =============================================================================
