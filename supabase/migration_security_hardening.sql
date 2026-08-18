-- =============================================================================
-- MIGRACIÓN — Refuerzo de seguridad: retirar la tabla admins obsoleta
-- =============================================================================
-- Ejecutar UNA sola vez en el SQL Editor de Supabase (pegar todo → Run).
--
-- `admins` fue la fuente original de is_admin() (migration_client_portal.sql).
-- Desde migration_client_access_control.sql, is_admin()/is_founder() leen
-- staff_roles — admins se dejó existiendo "por si acaso" pero nada en el
-- código (grep confirmado en toda la app) la referencia ya. Es superficie
-- muerta: una tabla con RLS activo pero sin ninguna política, que no aporta
-- nada y solo puede confundir a quien audite el esquema más adelante.
-- =============================================================================

drop table if exists admins;
