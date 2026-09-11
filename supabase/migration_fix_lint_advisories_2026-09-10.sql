-- Arregla los dos avisos reales que salieron en el linter de seguridad de
-- Supabase el 2026-09-10 (el resto de avisos son ruido esperado del patrón
-- SECURITY DEFINER usado a propósito en todo el proyecto — is_founder(),
-- has_client_access(), etc. — y RLS "sin políticas" en tablas que solo usa
-- el backend con la service key, que es el estado seguro por defecto).

-- 1. _touch_actualizado_en (creada en migration_client_whatsapp_bot_config.sql)
-- se quedó sin `set search_path`, a diferencia del resto de funciones del
-- proyecto — riesgo de search_path hijacking si alguien crea un objeto con
-- el mismo nombre en un esquema anterior en el path de la sesión.
create or replace function _touch_actualizado_en() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.actualizado_en := now();
  return new;
end;
$$;

-- 2. tier_config_effective y solutions_catalog_effective quedaron como
-- SECURITY DEFINER (comportamiento implícito de las vistas en Postgres) en
-- vez de SECURITY INVOKER. Verificado que es seguro cambiarlo: las tablas
-- que leen (pricing_offers, solutions_catalog, tier_config) ya tienen
-- policies de SELECT abiertas a todo el mundo (o a activos), así que
-- SECURITY INVOKER devuelve exactamente los mismos datos sin necesitar
-- saltarse RLS — simplemente dejamos de depender del comportamiento
-- implícito, que es lo que marca el linter.
alter view tier_config_effective set (security_invoker = true);
alter view solutions_catalog_effective set (security_invoker = true);
