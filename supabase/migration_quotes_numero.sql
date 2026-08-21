-- =============================================================================
-- MIGRACIÓN — Numeración correlativa de presupuestos (P0001, P0002...)
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase del sitio
-- PRINCIPAL de TRUCO → pegar todo → Run.
-- Requiere migration_quotes.sql ya aplicada.
--
-- numero es un entero correlativo (1, 2, 3...) — el "P" y los ceros por
-- delante (P0001) se pintan en el panel/PDF, no se guardan así en la base de
-- datos, para poder ordenar y buscar por número de forma normal.
--
-- Idempotente a propósito: si ya se aplicó, no hace nada raro al repetirla.
-- =============================================================================

create sequence if not exists quotes_numero_seq;

alter table quotes add column if not exists numero int;
alter table quotes alter column numero set default nextval('quotes_numero_seq');

-- Rellena el número a los presupuestos que ya existan y todavía no lo tengan
-- (ej. si se crearon entre migration_quotes.sql y esta migración).
update quotes set numero = nextval('quotes_numero_seq') where numero is null;

alter table quotes alter column numero set not null;
create unique index if not exists quotes_numero_idx on quotes(numero);

-- =============================================================================
-- FIN — prueba de humo:
--   1. sb.from('quotes').select('numero').order('numero') debe devolver
--      números únicos y correlativos.
--   2. Un presupuesto nuevo (sb.from('quotes').insert({...})) debe recibir
--      numero automáticamente, sin tener que indicarlo.
-- =============================================================================
