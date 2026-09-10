-- Sistema centralizado de configuración del bot de WhatsApp por cliente
-- (tarea #222, "sistema centralizado de configuración de bots por cliente").
-- `client_automations` ya existe y trackea el ESTADO de cada automatización
-- contratada (pending/live/paused/error) pero nunca guardó la CONFIGURACIÓN
-- real (horario, tono, FAQ, catálogo) — hoy ese cambio es un ticket manual
-- en `tasks` ("¿Quieres actualizar un horario...? Cuéntanoslo aquí"). Esta
-- migración añade esa configuración de verdad, para que n8n pueda leerla en
-- caliente al recibir un mensaje de WhatsApp real de un cliente.
--
-- Empieza solo con WhatsApp (el automatismo más pedido, ya con un ejemplo
-- real funcionando — el propio "Jose" de TRUCO) en vez de un esquema
-- genérico para las 12 automatizaciones del catálogo: construir para una
-- automatización real primero y medir, en vez de adivinar una abstracción
-- para las otras 11 antes de tener un solo cliente real usándolo.

create table if not exists client_whatsapp_bot_config (
  client_id uuid primary key references clients(id) on delete cascade,
  nombre_negocio text not null,
  nombre_asistente text not null default 'Asistente',
  telefono_whatsapp text unique,
  horario_atencion jsonb not null default '{}'::jsonb,
  tono text not null default 'profesional y cercano',
  mensaje_bienvenida text,
  mensaje_ausencia text,
  faq jsonb not null default '[]'::jsonb,
  catalogo jsonb not null default '[]'::jsonb,
  -- El phone_number_id lo asigna Meta a cada número conectado por Embedded
  -- Signup (no es el número de teléfono en sí) — hace falta para llamar al
  -- endpoint de envío de la API de WhatsApp Cloud de ESE cliente en concreto.
  -- El token de acceso puede ser uno solo compartido (system user de TRUCO
  -- como Meta Tech Provider) válido para todos los números incorporados, así
  -- que va como variable de entorno y no como columna por cliente.
  meta_phone_number_id text,
  activo boolean not null default true,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

alter table client_whatsapp_bot_config enable row level security;

drop policy if exists "read client_whatsapp_bot_config" on client_whatsapp_bot_config;
create policy "read client_whatsapp_bot_config" on client_whatsapp_bot_config for select
using (
  exists (select 1 from clients c where c.id = client_whatsapp_bot_config.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'view')
);

drop policy if exists "edit client_whatsapp_bot_config" on client_whatsapp_bot_config;
create policy "edit client_whatsapp_bot_config" on client_whatsapp_bot_config for update
using (
  exists (select 1 from clients c where c.id = client_whatsapp_bot_config.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'edit')
)
with check (
  exists (select 1 from clients c where c.id = client_whatsapp_bot_config.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'edit')
);

-- INSERT solo vía la función de abajo (upsert_my_whatsapp_bot_config) o por
-- el founder — nunca una policy de INSERT abierta al cliente, para poder
-- comprobar primero que de verdad tiene la automatización de WhatsApp contratada.
drop policy if exists "founder insert client_whatsapp_bot_config" on client_whatsapp_bot_config;
create policy "founder insert client_whatsapp_bot_config" on client_whatsapp_bot_config for insert
with check (has_client_access(client_id, 'edit'));

revoke all on client_whatsapp_bot_config from public, anon;
grant select, update on client_whatsapp_bot_config to authenticated;
grant insert on client_whatsapp_bot_config to authenticated; -- filtrado por la policy de arriba

-- Trigger de auditoría, mismo patrón que el resto de tablas de configuración
-- de cliente (monstruo_overhaul.sql) — para poder ver quién cambió qué.
drop trigger if exists audit_client_whatsapp_bot_config on client_whatsapp_bot_config;
create trigger audit_client_whatsapp_bot_config
  after insert or update or delete on client_whatsapp_bot_config
  for each row execute function audit_row_change();

drop trigger if exists set_actualizado_en on client_whatsapp_bot_config;
create or replace function _touch_actualizado_en() returns trigger
language plpgsql as $$
begin
  new.actualizado_en := now();
  return new;
end;
$$;
create trigger set_actualizado_en
  before update on client_whatsapp_bot_config
  for each row execute function _touch_actualizado_en();

-- El cliente (o el founder) crea/edita su propia config sin poder tocar la
-- de otro — resuelve el client_id por su cuenta vía auth_user_id, nunca
-- confía en un client_id que venga del navegador. Exige que la automatización
-- de WhatsApp esté realmente contratada (fila en client_automations) antes
-- de dejar crear configuración — evita configs huérfanas sin automatización
-- asociada.
create or replace function upsert_my_whatsapp_bot_config(
  p_nombre_negocio text,
  p_nombre_asistente text default 'Asistente',
  p_telefono_whatsapp text default null,
  p_horario_atencion jsonb default '{}'::jsonb,
  p_tono text default 'profesional y cercano',
  p_mensaje_bienvenida text default null,
  p_mensaje_ausencia text default null,
  p_faq jsonb default '[]'::jsonb,
  p_catalogo jsonb default '[]'::jsonb
) returns client_whatsapp_bot_config
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
  v_row client_whatsapp_bot_config;
begin
  select id into v_client_id from clients where auth_user_id = auth.uid();
  if v_client_id is null then
    raise exception 'No se ha encontrado el cliente asociado a este usuario';
  end if;

  if not exists (
    select 1 from client_automations
    where client_id = v_client_id and solution_key = 'whatsapp'
  ) then
    raise exception 'Este cliente no tiene contratada la automatización de WhatsApp todavía';
  end if;

  insert into client_whatsapp_bot_config (
    client_id, nombre_negocio, nombre_asistente, telefono_whatsapp,
    horario_atencion, tono, mensaje_bienvenida, mensaje_ausencia, faq, catalogo
  ) values (
    v_client_id, p_nombre_negocio, p_nombre_asistente, p_telefono_whatsapp,
    p_horario_atencion, p_tono, p_mensaje_bienvenida, p_mensaje_ausencia, p_faq, p_catalogo
  )
  on conflict (client_id) do update set
    nombre_negocio = excluded.nombre_negocio,
    nombre_asistente = excluded.nombre_asistente,
    telefono_whatsapp = excluded.telefono_whatsapp,
    horario_atencion = excluded.horario_atencion,
    tono = excluded.tono,
    mensaje_bienvenida = excluded.mensaje_bienvenida,
    mensaje_ausencia = excluded.mensaje_ausencia,
    faq = excluded.faq,
    catalogo = excluded.catalogo
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function upsert_my_whatsapp_bot_config from public;
grant execute on function upsert_my_whatsapp_bot_config to authenticated;

-- La única vía de lectura para n8n: nunca acceso directo a la tabla con la
-- service key (mismo patrón que whatsapp_recent_history, founder_fiscal_resumen,
-- etc.) — un solo RPC estrecho, solo para service_role, que además comprueba
-- que la automatización esté "live" (si está en pausa o dada de baja, el bot
-- no debe contestar aunque la config siga guardada).
drop function if exists get_whatsapp_bot_config_by_phone(text);
create function get_whatsapp_bot_config_by_phone(p_telefono text)
returns table (
  client_id uuid,
  nombre_negocio text,
  nombre_asistente text,
  horario_atencion jsonb,
  tono text,
  mensaje_bienvenida text,
  mensaje_ausencia text,
  faq jsonb,
  catalogo jsonb,
  meta_phone_number_id text
)
language sql
security definer
stable
set search_path = public
as $$
  select
    cfg.client_id, cfg.nombre_negocio, cfg.nombre_asistente, cfg.horario_atencion,
    cfg.tono, cfg.mensaje_bienvenida, cfg.mensaje_ausencia, cfg.faq, cfg.catalogo,
    cfg.meta_phone_number_id
  from client_whatsapp_bot_config cfg
  join client_automations ca
    on ca.client_id = cfg.client_id and ca.solution_key = 'whatsapp' and ca.status = 'live'
  where cfg.telefono_whatsapp = p_telefono and cfg.activo = true;
$$;

revoke all on function get_whatsapp_bot_config_by_phone from public, anon, authenticated;
grant execute on function get_whatsapp_bot_config_by_phone to service_role;

-- El webhook REAL de Meta identifica el número receptor por
-- metadata.phone_number_id (un id interno de Meta), no por el número de
-- teléfono en texto — de ahí esta segunda vía de búsqueda.
drop function if exists get_whatsapp_bot_config_by_phone_number_id(text);
create function get_whatsapp_bot_config_by_phone_number_id(p_phone_number_id text)
returns table (
  client_id uuid,
  nombre_negocio text,
  nombre_asistente text,
  horario_atencion jsonb,
  tono text,
  mensaje_bienvenida text,
  mensaje_ausencia text,
  faq jsonb,
  catalogo jsonb
)
language sql
security definer
stable
set search_path = public
as $$
  select
    cfg.client_id, cfg.nombre_negocio, cfg.nombre_asistente, cfg.horario_atencion,
    cfg.tono, cfg.mensaje_bienvenida, cfg.mensaje_ausencia, cfg.faq, cfg.catalogo
  from client_whatsapp_bot_config cfg
  join client_automations ca
    on ca.client_id = cfg.client_id and ca.solution_key = 'whatsapp' and ca.status = 'live'
  where cfg.meta_phone_number_id = p_phone_number_id and cfg.activo = true;
$$;

revoke all on function get_whatsapp_bot_config_by_phone_number_id from public, anon, authenticated;
grant execute on function get_whatsapp_bot_config_by_phone_number_id to service_role;

-- Prueba de humo (ejecutar a mano tras aplicar la migración):
-- 1. Como founder: select * from client_automations where solution_key = 'whatsapp' limit 1;
--    -- coger un client_id real con la automatización activa (o crear uno de prueba)
-- 2. select upsert_my_whatsapp_bot_config('Negocio de prueba', 'Ana', '+34600000000',
--      '{"lunes":"9:00-18:00"}'::jsonb, 'cercano', 'Hola, soy Ana', 'Ahora no puedo, te escribo luego',
--      '[{"pregunta":"¿Cuánto cuesta?","respuesta":"Depende del servicio"}]'::jsonb, '[]'::jsonb);
--    -- debe fallar con "usuario asociado" si se llama sin sesión de ese cliente (esperado)
-- 3. select * from get_whatsapp_bot_config_by_phone('+34600000000'); -- con la service_role key
--    -- debe devolver la fila si status='live', y NADA si el automatismo está 'paused'
