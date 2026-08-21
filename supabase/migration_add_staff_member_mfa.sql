-- =============================================================================
-- MIGRACIÓN — add_staff_member() pasa a usar is_founder() (exige 2FA también aquí)
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase del sitio
-- PRINCIPAL de TRUCO → pegar todo → Run.
-- Requiere migration_monstruo_overhaul.sql y migration_founder_mfa.sql ya
-- aplicadas.
--
-- add_staff_member() (el "Equipo" del panel — puede incluso ascender a
-- alguien a founder) comprobaba el rol por su cuenta (role = 'founder'
-- directo contra staff_roles) en vez de llamar a is_founder() — así que,
-- a diferencia de TODAS las demás acciones de founder, se quedaba sin la
-- exigencia de verificación en dos pasos que migration_founder_mfa.sql le
-- dio a is_founder(). Dar de alta o ascender a alguien del equipo es de las
-- acciones más sensibles que hay — merece la misma protección que las demás,
-- no menos.
-- =============================================================================

create or replace function add_staff_member(p_user_id uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_founder() then
    raise exception 'Solo el founder puede añadir miembros del equipo';
  end if;
  if p_role not in ('founder','admin','support','readonly') then
    raise exception 'Rol no válido: %', p_role;
  end if;
  insert into staff_roles (user_id, role, created_by) values (p_user_id, p_role, auth.uid())
  on conflict (user_id) do update set role = excluded.role;
end;
$$;
revoke all on function add_staff_member(uuid, text) from public;
grant execute on function add_staff_member(uuid, text) to authenticated;

-- =============================================================================
-- FIN — prueba de humo: con el 2FA activado, cierra sesión, vuelve a entrar
-- SIN completar el código del móvil (si el panel te dejara, cosa que ya no
-- debería) e intenta añadir a alguien al equipo desde "Equipo" → debe fallar
-- con "Solo el founder puede añadir miembros del equipo", igual que fallaría
-- cualquier otra acción de founder sin el segundo factor completado.
-- =============================================================================
