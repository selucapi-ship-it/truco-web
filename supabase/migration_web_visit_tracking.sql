-- Contador de visitas por fuente offline (folletos, carteles, tarjetas...).
-- Cada pieza impresa lleva un QR con ?src=<etiqueta> en la URL; al cargar la
-- página, el cliente llama a esta función una vez por sesión para dejar
-- constancia. Público a propósito (como validate_referral_code): no expone
-- ni toca datos de ningún cliente, solo cuenta una visita anónima.
-- Ejecutar una sola vez en Supabase (SQL Editor → pegar → Run).
-- Requiere migration_plan_tracking.sql ya aplicada (tabla interactions).

alter table interactions drop constraint if exists interactions_source_check;
alter table interactions add constraint interactions_source_check
  check (source in ('checkout','chat','voice','whatsapp','portal','manual','web'));

create or replace function log_web_visit(p_src text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into interactions (source, nota)
  values ('web', 'src=' || left(coalesce(p_src, '(vacío)'), 80));
end;
$$;
revoke all on function log_web_visit from public;
grant execute on function log_web_visit to anon, authenticated;

-- Consulta para ver cuántas visitas ha traído cada fuente impresa:
--   select nota, count(*) as visitas, min(created_at) as primera, max(created_at) as ultima
--   from interactions where source = 'web' group by nota order by visitas desc;
