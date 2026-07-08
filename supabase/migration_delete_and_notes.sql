-- Migración incremental: permite borrar clientes y añadir notas manuales
-- desde el panel. Ejecutar una sola vez en Supabase (SQL Editor → pegar → Run).
-- (Ya tienes las tablas creadas por schema.sql; esto solo añade lo nuevo.)

alter table interactions drop constraint if exists interactions_source_check;
alter table interactions add constraint interactions_source_check
  check (source in ('checkout','chat','voice','manual'));

drop policy if exists "authenticated delete clients" on clients;
create policy "authenticated delete clients" on clients
  for delete using (auth.role() = 'authenticated');

drop policy if exists "authenticated insert manual interactions" on interactions;
create policy "authenticated insert manual interactions" on interactions
  for insert with check (auth.role() = 'authenticated' and source = 'manual');
