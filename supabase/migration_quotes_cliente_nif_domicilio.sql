-- =============================================================================
-- MIGRACIÓN — NIF/CIF y domicilio del CLIENTE en presupuestos
-- =============================================================================
-- Ejecutar en el SQL Editor de Supabase del proyecto PRINCIPAL de TRUCO.
-- Requiere migration_quotes.sql ya aplicada.
--
-- A diferencia de la dirección del founder (que nunca debe aparecer en ningún
-- documento — es su domicilio personal, ver autorizacion-accesos.html y
-- generate-quote-pdf.js), esta es la del NEGOCIO que se está presupuestando:
-- un dato público/legal que el propio cliente aporta, normal en cualquier
-- presupuesto comercial serio (razón social, NIF/CIF, domicilio fiscal).
--
-- Idempotente, mismo criterio que las migraciones anteriores.
-- =============================================================================

alter table quotes add column if not exists cliente_nif text;
alter table quotes add column if not exists cliente_domicilio text;

-- =============================================================================
-- FIN — prueba de humo:
--   select cliente_nif, cliente_domicilio from quotes limit 1; debe devolver
--   null en presupuestos antiguos, sin romper nada existente.
-- =============================================================================
