-- Sistema centralizado de configuración del widget de "IA para tu Web" por
-- cliente — mismo patrón exacto que client_whatsapp_bot_config y
-- client_phone_bot_config. Hasta ahora `chat-ai.js` solo servía a la propia
-- web de TRUCO (contenido 100% hardcodeado); esto lo hace multi-cliente de
-- verdad sin desplegar una función nueva por cada uno.
--
-- Identificador público a propósito: a diferencia de WhatsApp (identifica al
-- cliente por un phone_number_id que da Meta) o Llamadas (por el número que
-- marcó quien llama), aquí el propio cliente pega un <script> con su
-- `widget_key` en su web — es un identificador público por diseño (va en el
-- HTML visible de su página), nunca un secreto. La seguridad no depende de
-- ocultarlo: solo permite leer SU configuración pública (nombre, horario,
-- FAQ) y usar el chat con SU límite de uso — nunca escribir ni ver datos de
-- otro cliente.

create table if not exists client_web_bot_config (
  client_id uuid primary key references clients(id) on delete cascade,
  nombre_negocio text not null,
  nombre_asistente text not null default 'Asistente',
  widget_key text unique not null default encode(gen_random_bytes(16), 'hex'),
  horario_atencion jsonb not null default '{}'::jsonb,
  tono text not null default 'profesional y cercano',
  mensaje_bienvenida text,
  faq jsonb not null default '[]'::jsonb,
  catalogo jsonb not null default '[]'::jsonb,
  activo boolean not null default true,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

alter table client_web_bot_config enable row level security;

drop policy if exists "read client_web_bot_config" on client_web_bot_config;
create policy "read client_web_bot_config" on client_web_bot_config for select
using (
  exists (select 1 from clients c where c.id = client_web_bot_config.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'view')
);

drop policy if exists "edit client_web_bot_config" on client_web_bot_config;
create policy "edit client_web_bot_config" on client_web_bot_config for update
using (
  exists (select 1 from clients c where c.id = client_web_bot_config.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'edit')
)
with check (
  exists (select 1 from clients c where c.id = client_web_bot_config.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'edit')
);

drop policy if exists "founder insert client_web_bot_config" on client_web_bot_config;
create policy "founder insert client_web_bot_config" on client_web_bot_config for insert
with check (has_client_access(client_id, 'edit'));

revoke all on client_web_bot_config from public, anon;
grant select, update on client_web_bot_config to authenticated;
grant insert on client_web_bot_config to authenticated;

drop trigger if exists audit_client_web_bot_config on client_web_bot_config;
create trigger audit_client_web_bot_config
  after insert or update or delete on client_web_bot_config
  for each row execute function audit_row_change();

drop trigger if exists set_actualizado_en on client_web_bot_config;
create trigger set_actualizado_en
  before update on client_web_bot_config
  for each row execute function _touch_actualizado_en();

-- Única vía de lectura para el widget público: nunca acceso directo a la
-- tabla con la service key. A diferencia de WhatsApp/Llamadas, esta SÍ la
-- llama en última instancia el navegador del visitante final (a través de la
-- Netlify Function, nunca directo a Supabase) — por eso comprueba también
-- `activo` y el estado 'live' de la automatización, igual que las otras dos,
-- para que un cliente dado de baja deje de contestar aunque su widget_key
-- siga técnicamente pegado en su web.
drop function if exists get_web_bot_config_by_widget_key(text);
create function get_web_bot_config_by_widget_key(p_widget_key text)
returns table (
  client_id uuid,
  nombre_negocio text,
  nombre_asistente text,
  horario_atencion jsonb,
  tono text,
  mensaje_bienvenida text,
  faq jsonb,
  catalogo jsonb
)
language sql
security definer
stable
set search_path = public
as $$
  select
    cfg.client_id, cfg.nombre_negocio, cfg.nombre_asistente,
    cfg.horario_atencion, cfg.tono, cfg.mensaje_bienvenida, cfg.faq, cfg.catalogo
  from client_web_bot_config cfg
  join client_automations ca
    on ca.client_id = cfg.client_id and ca.solution_key = 'web-ia' and ca.status = 'live'
  where cfg.widget_key = p_widget_key and cfg.activo = true;
$$;

revoke all on function get_web_bot_config_by_widget_key from public, anon, authenticated;
grant execute on function get_web_bot_config_by_widget_key to service_role;

-- Prueba de humo:
-- 1. select * from client_automations where solution_key = 'web-ia' limit 1;
-- 2. select * from get_web_bot_config_by_widget_key('...'); con la service_role key
--    -- debe devolver la fila si status='live' y activo=true, y NADA si no
