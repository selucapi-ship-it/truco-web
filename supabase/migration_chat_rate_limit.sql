-- MIGRACIÓN — límite diario por sesión de las llamadas a Gemini desde el chat
-- de la web (netlify/functions/chat-ai.js).
--
-- Por qué: el proyecto de Gemini usado por chat-ai.js y telegram-antonia.js
-- comparte una cuota gratuita de solo 20 peticiones/día — compartida entre
-- TODOS los visitantes del sitio, no por persona. La defensa principal contra
-- eso es el chat local-primero (TRUCO_CHAT en index.html: responde sin llamar
-- a Gemini cuando reconoce la pregunta con certeza). Este límite es la segunda
-- capa: evita que una sola sesión (un bot, un visitante insistiendo, alguien
-- jugando con el chat) agote ella sola la cuota compartida del día para todos
-- los demás visitantes reales.
--
-- Mismo patrón de privacidad que page_views/button_clicks (migration_site_
-- analytics): solo cuenta por session_id anónimo (el mismo que ya usa
-- trucoSessionId() en el resto del sitio), nadie puede leer la tabla directo,
-- todo pasa por una función security definer.
-- =============================================================================

create table if not exists chat_ai_usage (
  session_id text not null,
  usage_date date not null default current_date,
  request_count int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (session_id, usage_date)
);
alter table chat_ai_usage enable row level security;
-- Sin policy de select/insert/update para nadie: solo se toca a través de
-- check_chat_quota() (security definer), nunca leyendo/escribiendo la tabla
-- directo — así una clave anon expuesta no sirve para fisgar el consumo ajeno.

create or replace function check_chat_quota(p_session_id text, p_limit int default 8)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session text := left(coalesce(nullif(trim(p_session_id), ''), 'sin_sesion'), 100);
  v_count int;
begin
  insert into chat_ai_usage (session_id, usage_date, request_count)
  values (v_session, current_date, 1)
  on conflict (session_id, usage_date)
  do update set request_count = chat_ai_usage.request_count + 1, updated_at = now()
  returning request_count into v_count;

  return jsonb_build_object('allowed', v_count <= p_limit, 'count', v_count, 'limit', p_limit);
end;
$$;
revoke all on function check_chat_quota(text, int) from public;
grant execute on function check_chat_quota(text, int) to anon, authenticated;

-- =============================================================================
-- FIN — prueba de humo: llamar 9 veces seguidas a check_chat_quota('test-abc', 8)
-- con la clave anon desde fuera del navegador y confirmar que las primeras 8
-- devuelven allowed:true y la 9ª allowed:false; confirmar también que un
-- select directo a chat_ai_usage con la clave anon devuelve vacío (RLS sin
-- policy de lectura).
-- =============================================================================
