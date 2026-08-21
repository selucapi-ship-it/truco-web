-- =============================================================================
-- MIGRACIÓN — Verificación en dos pasos (TOTP) obligatoria para is_founder()
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase del sitio
-- PRINCIPAL de TRUCO → pegar todo → Run.
--
-- Qué hace: is_founder() ya no basta con tener el rol 'founder' en
-- staff_roles — si esa cuenta tiene un factor TOTP verificado (activado
-- desde el panel, en "Seguridad"), además exige que la sesión actual haya
-- completado ese segundo paso (aal2). Así, aunque alguien consiga la
-- contraseña del founder, no puede ejecutar ninguna acción de founder sin el
-- código del móvil — esto se comprueba en el servidor (RLS/RPCs), no solo en
-- la pantalla del panel, que se podría saltar llamando a la API directamente.
--
-- Antes de activar el TOTP desde el panel, esto no cambia nada: la condición
-- "no exists factor TOTP verificado" sigue dejando pasar con solo la
-- contraseña, para no bloquear a nadie a medio camino de configurarlo.
--
-- Requiere migration_client_access_control.sql ya aplicada (define
-- is_founder() por primera vez). Idempotente.
-- =============================================================================

create or replace function is_founder() returns boolean
language sql security definer set search_path = public, auth stable as $$
  select
    exists (select 1 from staff_roles where user_id = auth.uid() and role = 'founder')
    and (
      coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors
        where user_id = auth.uid() and status = 'verified'
      )
    );
$$;
revoke all on function is_founder() from public;
grant execute on function is_founder() to authenticated, anon;

-- =============================================================================
-- FIN — prueba de humo:
--   1. Antes de activar el TOTP en "Seguridad" del panel: todo sigue
--      funcionando igual que hoy con solo la contraseña.
--   2. Actívalo desde el panel (escanear QR + código de 6 dígitos).
--   3. Cierra sesión y vuelve a entrar: el panel debe pedir el código antes
--      de dejarte ver nada. Sin ese paso, cualquier acción de founder (crear
--      presupuesto, cambiar precios, dar de alta un cliente...) debe fallar
--      con "No autorizado" aunque el login con contraseña haya sido correcto.
-- =============================================================================
