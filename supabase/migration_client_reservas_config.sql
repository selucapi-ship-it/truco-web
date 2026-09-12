-- Sistema centralizado de configuración de "Reservas y Agenda" por cliente —
-- mismo patrón que WhatsApp/Llamadas/Web. Hasta ahora solo existía la mitad
-- de RECORDATORIO (plantillas/03-automatizaciones/n8n-flows/recordatorio-
-- citas.json); esto añade la mitad de CREAR la reserva, que es lo que la
-- propia página de marketing promete con su "botón de reserva directa".
--
-- Arquitectura de calendario: igual que ya hace antonia-agent/voice-agent —
-- el cliente comparte SU Google Calendar con la cuenta de servicio
-- (truco-voice-agent@truco-voice-agent.iam.gserviceaccount.com, ver
-- GOOGLE_SERVICE_ACCOUNT_JSON_B64 ya configurada), en vez de que el cliente
-- tenga que dar acceso OAuth completo a su cuenta de Google. Nunca se crea
-- un calendario nuevo para el cliente — se reserva DIRECTAMENTE en el suyo.

create table if not exists client_reservas_config (
  client_id uuid primary key references clients(id) on delete cascade,
  nombre_negocio text not null,
  widget_key text unique not null default encode(gen_random_bytes(16), 'hex'),
  google_calendar_id text not null,
  horario_atencion jsonb not null default '{}'::jsonb,
  -- servicios: [{"nombre":"Corte de pelo","duracion_min":30,"precio":15}, ...]
  servicios jsonb not null default '[]'::jsonb,
  buffer_min int not null default 0,
  zona_horaria text not null default 'Europe/Madrid',
  activo boolean not null default true,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

alter table client_reservas_config enable row level security;

drop policy if exists "read client_reservas_config" on client_reservas_config;
create policy "read client_reservas_config" on client_reservas_config for select
using (
  exists (select 1 from clients c where c.id = client_reservas_config.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'view')
);

drop policy if exists "edit client_reservas_config" on client_reservas_config;
create policy "edit client_reservas_config" on client_reservas_config for update
using (
  exists (select 1 from clients c where c.id = client_reservas_config.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'edit')
)
with check (
  exists (select 1 from clients c where c.id = client_reservas_config.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'edit')
);

drop policy if exists "founder insert client_reservas_config" on client_reservas_config;
create policy "founder insert client_reservas_config" on client_reservas_config for insert
with check (has_client_access(client_id, 'edit'));

revoke all on client_reservas_config from public, anon;
grant select, update on client_reservas_config to authenticated;
grant insert on client_reservas_config to authenticated;

drop trigger if exists audit_client_reservas_config on client_reservas_config;
create trigger audit_client_reservas_config
  after insert or update or delete on client_reservas_config
  for each row execute function audit_row_change();

drop trigger if exists set_actualizado_en on client_reservas_config;
create trigger set_actualizado_en
  before update on client_reservas_config
  for each row execute function _touch_actualizado_en();

-- Única vía de lectura pública (por widget_key), igual que web-ia — el
-- backend de reservas la llama para saber en qué calendario mirar/crear el
-- evento y con qué servicios/horario, sin exponer nunca la tabla directa.
drop function if exists get_reservas_config_by_widget_key(text);
create function get_reservas_config_by_widget_key(p_widget_key text)
returns table (
  client_id uuid,
  nombre_negocio text,
  google_calendar_id text,
  horario_atencion jsonb,
  servicios jsonb,
  buffer_min int,
  zona_horaria text
)
language sql
security definer
stable
set search_path = public
as $$
  select
    cfg.client_id, cfg.nombre_negocio, cfg.google_calendar_id,
    cfg.horario_atencion, cfg.servicios, cfg.buffer_min, cfg.zona_horaria
  from client_reservas_config cfg
  join client_automations ca
    on ca.client_id = cfg.client_id and ca.solution_key = 'reservas' and ca.status = 'live'
  where cfg.widget_key = p_widget_key and cfg.activo = true;
$$;

revoke all on function get_reservas_config_by_widget_key from public, anon, authenticated;
grant execute on function get_reservas_config_by_widget_key to service_role;

-- Registro de cada reserva creada — para poder listarlas al cliente/founder
-- y para que registrarUso() (mismo patrón de facturación por uso) tenga algo
-- que contar si en el futuro "reservas" pasa a tener límite mensual.
create table if not exists reservas_creadas (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  google_event_id text not null,
  servicio_nombre text not null,
  cliente_final_nombre text,
  cliente_final_telefono text,
  inicio timestamptz not null,
  fin timestamptz not null,
  creado_en timestamptz not null default now()
);
alter table reservas_creadas enable row level security;
drop policy if exists "read reservas_creadas" on reservas_creadas;
create policy "read reservas_creadas" on reservas_creadas for select
using (
  exists (select 1 from clients c where c.id = reservas_creadas.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'view')
);
revoke all on reservas_creadas from public, anon;
grant select on reservas_creadas to authenticated;

-- Prueba de humo:
-- 1. select * from client_automations where solution_key = 'reservas' limit 1;
-- 2. select * from get_reservas_config_by_widget_key('...'); con la service_role key
--    -- debe devolver la fila si status='live' y activo=true, y NADA si no
