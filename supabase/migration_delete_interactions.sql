-- Migración incremental: permite borrar entradas del historial (por ejemplo,
-- sesiones de chat sin identificar) desde el panel. Ejecutar una sola vez en
-- Supabase (SQL Editor → pegar → Run).

drop policy if exists "authenticated delete interactions" on interactions;
create policy "authenticated delete interactions" on interactions
  for delete using (auth.role() = 'authenticated');
