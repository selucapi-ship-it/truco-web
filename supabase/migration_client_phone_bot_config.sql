-- Sistema centralizado de configuración del bot de "IA para Llamadas" por
-- cliente (mismo patrón exacto que migration_client_whatsapp_bot_config.sql,
-- ver tarea #222). Se crea ANTES de tener la cuenta de Telnyx porque no
-- depende de ningún proveedor externo — solo guarda la config real del
-- negocio (horario, tono, FAQ, catálogo) más el número que identifica a cada
-- cliente cuando llegue una llamada real.
--
-- Arquitectura de número decidida 2026-09-11 (tres opciones, mismo backend
-- para las tres — ver memoria pending-roadmap-checklist.md punto 3):
--   A) Desvío de llamadas — el cliente mantiene su número de siempre y lo
--      desvía a `numero_recepcion_ia` (el número que le asigna TRUCO).
--   B) Portabilidad completa — su número antiguo pasa a ser
--      `numero_recepcion_ia` directamente.
--   C) Número nuevo dedicado — `numero_recepcion_ia` es su única línea para
--      esta automatización.
-- En los tres casos, lo único que necesita el agente de voz para identificar
-- al cliente es `numero_recepcion_ia` (el número que Telnyx entrega como
-- destino de la llamada entrante) — igual que el webhook de WhatsApp
-- identifica al cliente por `meta_phone_number_id`, no por el número que
-- escribe el usuario final.

create table if not exists client_phone_bot_config (
  client_id uuid primary key references clients(id) on delete cascade,
  nombre_negocio text not null,
  nombre_asistente text not null default 'Asistente',
  numero_recepcion_ia text unique,
  horario_atencion jsonb not null default '{}'::jsonb,
  tono text not null default 'profesional y cercano',
  mensaje_bienvenida text,
  faq jsonb not null default '[]'::jsonb,
  catalogo jsonb not null default '[]'::jsonb,
  activo boolean not null default true,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

alter table client_phone_bot_config enable row level security;

drop policy if exists "read client_phone_bot_config" on client_phone_bot_config;
create policy "read client_phone_bot_config" on client_phone_bot_config for select
using (
  exists (select 1 from clients c where c.id = client_phone_bot_config.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'view')
);

drop policy if exists "edit client_phone_bot_config" on client_phone_bot_config;
create policy "edit client_phone_bot_config" on client_phone_bot_config for update
using (
  exists (select 1 from clients c where c.id = client_phone_bot_config.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'edit')
)
with check (
  exists (select 1 from clients c where c.id = client_phone_bot_config.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'edit')
);

drop policy if exists "founder insert client_phone_bot_config" on client_phone_bot_config;
create policy "founder insert client_phone_bot_config" on client_phone_bot_config for insert
with check (has_client_access(client_id, 'edit'));

revoke all on client_phone_bot_config from public, anon;
grant select, update on client_phone_bot_config to authenticated;
grant insert on client_phone_bot_config to authenticated;

drop trigger if exists audit_client_phone_bot_config on client_phone_bot_config;
create trigger audit_client_phone_bot_config
  after insert or update or delete on client_phone_bot_config
  for each row execute function audit_row_change();

drop trigger if exists set_actualizado_en on client_phone_bot_config;
create trigger set_actualizado_en
  before update on client_phone_bot_config
  for each row execute function _touch_actualizado_en();

-- Única vía de lectura para el agente de voz: nunca acceso directo a la
-- tabla con la service key, un solo RPC estrecho para service_role, que
-- además exige que la automatización esté 'live' (no 'pending'/'paused').
drop function if exists get_phone_bot_config_by_numero(text);
create function get_phone_bot_config_by_numero(p_numero_recepcion text)
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
  from client_phone_bot_config cfg
  join client_automations ca
    on ca.client_id = cfg.client_id and ca.solution_key = 'llamadas' and ca.status = 'live'
  where cfg.numero_recepcion_ia = p_numero_recepcion and cfg.activo = true;
$$;

revoke all on function get_phone_bot_config_by_numero from public, anon, authenticated;
grant execute on function get_phone_bot_config_by_numero to service_role;

-- Prueba de humo (ejecutar tras aplicar la migración):
-- 1. select * from client_automations where solution_key = 'llamadas' limit 1;
-- 2. Con sesión de ese cliente: select upsert equivalente aún no existe, insertar a mano de founder
--    o cuando exista el panel de cliente, replicar upsert_my_whatsapp_bot_config para esta tabla.
-- 3. select * from get_phone_bot_config_by_numero('+34...'); con la service_role key
--    -- debe devolver la fila si status='live', y NADA si el automatismo está 'paused'
