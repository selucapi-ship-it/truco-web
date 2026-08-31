-- MIGRACIÓN — analítica propia del sitio: páginas más vistas, botones más
-- pulsados, y detección de "páginas muertas" (sin visitas) para la nueva
-- sección "Interacciones y Actividad" del panel admin.
--
-- Mismo patrón de privacidad que log_web_visit (migration_web_visit_tracking):
-- solo cuenta, session_id anónimo (no hay login), sin datos personales. Un
-- visitante anónimo puede INSERTAR (vía las funciones de abajo) pero nunca
-- LEER estas tablas directamente — solo founder/staff, a través de las
-- funciones de agregación.
-- =============================================================================

create table if not exists page_views (
  id bigint generated always as identity primary key,
  page text not null,
  session_id text,
  referrer text,
  created_at timestamptz not null default now()
);
create index if not exists page_views_page_idx on page_views(page);
create index if not exists page_views_created_at_idx on page_views(created_at);
alter table page_views enable row level security;
create policy "founder read page_views" on page_views for select
using (is_founder() or is_authorized_staff());
-- Sin policy de INSERT para nadie: se inserta solo a través de log_page_view()
-- (security definer), nunca escribiendo directo a la tabla.

create table if not exists button_clicks (
  id bigint generated always as identity primary key,
  button_key text not null,
  page text,
  session_id text,
  created_at timestamptz not null default now()
);
create index if not exists button_clicks_key_idx on button_clicks(button_key);
create index if not exists button_clicks_created_at_idx on button_clicks(created_at);
alter table button_clicks enable row level security;
create policy "founder read button_clicks" on button_clicks for select
using (is_founder() or is_authorized_staff());

-- ── Funciones públicas de registro (llamadas desde el JS de cualquier página) ──
create or replace function log_page_view(p_page text, p_session_id text default null, p_referrer text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_page is null or length(trim(p_page)) = 0 then return; end if;
  insert into page_views (page, session_id, referrer) values (left(p_page, 200), left(p_session_id, 100), left(p_referrer, 300));
end;
$$;
revoke all on function log_page_view(text, text, text) from public;
grant execute on function log_page_view(text, text, text) to anon, authenticated;

create or replace function log_button_click(p_button_key text, p_page text default null, p_session_id text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_button_key is null or length(trim(p_button_key)) = 0 then return; end if;
  insert into button_clicks (button_key, page, session_id) values (left(p_button_key, 100), left(p_page, 200), left(p_session_id, 100));
end;
$$;
revoke all on function log_button_click(text, text, text) from public;
grant execute on function log_button_click(text, text, text) to anon, authenticated;

-- ── Funciones de agregación, solo para founder/staff — las usa el panel ──
create or replace function top_pages(p_days int default 30)
returns table(page text, visitas bigint, ultima_visita timestamptz)
language plpgsql security definer set search_path = public stable as $$
begin
  if not (is_founder() or is_authorized_staff()) then
    raise exception 'No autorizado';
  end if;
  return query
    select pv.page, count(*)::bigint as visitas, max(pv.created_at) as ultima_visita
    from page_views pv
    where pv.created_at >= now() - (p_days || ' days')::interval
    group by pv.page
    order by visitas desc;
end;
$$;
revoke all on function top_pages(int) from public;
grant execute on function top_pages(int) to authenticated;

create or replace function top_buttons(p_days int default 30)
returns table(button_key text, clics bigint, ultima_vez timestamptz)
language plpgsql security definer set search_path = public stable as $$
begin
  if not (is_founder() or is_authorized_staff()) then
    raise exception 'No autorizado';
  end if;
  return query
    select bc.button_key, count(*)::bigint as clics, max(bc.created_at) as ultima_vez
    from button_clicks bc
    where bc.created_at >= now() - (p_days || ' days')::interval
    group by bc.button_key
    order by clics desc;
end;
$$;
revoke all on function top_buttons(int) from public;
grant execute on function top_buttons(int) to authenticated;

-- =============================================================================
-- FIN — prueba de humo: llamar a log_page_view('/test') con la clave anon
-- desde fuera del navegador y confirmar que inserta; luego llamar a
-- top_pages() con una sesión de founder autenticada y confirmar que aparece.
-- =============================================================================
