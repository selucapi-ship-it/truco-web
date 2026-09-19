-- =============================================================================
-- MIGRACIÓN — Descuento comercial explícito en presupuestos
-- =============================================================================
-- Ejecutar en el SQL Editor de Supabase del proyecto PRINCIPAL de TRUCO.
-- Requiere migration_quotes.sql ya aplicada.
--
-- Añade porcentaje + motivo de descuento a los presupuestos, para que el
-- founder pueda justificar por qué se rebajó uno concreto (cliente piloto,
-- cierre rápido, amigo, etc.) sin tener que tocar precio a precio cada línea
-- a mano. total_estimado sigue siendo la base sin IVA que se cobra de verdad
-- (create-quote-checkout.js la usa tal cual) — ahora se guarda YA con el
-- descuento aplicado, calculado en admin/panel.html.
--
-- Idempotente, mismo criterio que las migraciones anteriores.
-- =============================================================================

alter table quotes add column if not exists descuento_pct numeric not null default 0 check (descuento_pct >= 0 and descuento_pct <= 100);
alter table quotes add column if not exists descuento_motivo text;

-- =============================================================================
-- FIN — prueba de humo:
--   select descuento_pct, descuento_motivo from quotes limit 1; debe devolver
--   0 / null en presupuestos antiguos, sin romper nada existente.
-- =============================================================================
