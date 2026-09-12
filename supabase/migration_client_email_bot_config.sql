-- Sistema centralizado de configuración de "IA para Correo" por cliente —
-- mismo patrón que WhatsApp/Web/Reservas/Llamadas. A diferencia de esas
-- cuatro, aquí el cliente autoriza acceso OAuth a SU PROPIO Gmail (decidido
-- 2026-09-12, en vez de darle una dirección nueva gestionada por TRUCO — más
-- natural para él, usa la bandeja de siempre, mismo tipo de decisión que ya
-- se tomó con el teléfono de Llamadas).
--
-- Requiere una app de OAuth de Google Cloud que TODAVÍA NO EXISTE — ver
-- checklist en documentacion-interna/playbook-automatizaciones.md, sección
-- email-ia. Esta tabla se puede crear y probar de forma aislada sin esa app
-- (no depende de ella), pero no sirve de nada hasta que exista.

create table if not exists client_email_bot_config (
  client_id uuid primary key references clients(id) on delete cascade,
  nombre_negocio text not null,
  nombre_asistente text not null default 'Asistente',
  gmail_address text unique,
  -- El refresh_token de OAuth NUNCA se expone a authenticated/anon — solo
  -- service_role (el worker que revisa el correo) puede leerlo, igual que
  -- ninguna otra tabla de config expone secretos por la API pública.
  oauth_refresh_token text,
  tono text not null default 'profesional y cercano',
  faq jsonb not null default '[]'::jsonb,
  firma_email text,
  activo boolean not null default true,
  ultima_revision_en timestamptz,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

alter table client_email_bot_config enable row level security;

-- OJO: a diferencia de whatsapp/web/reservas, aquí NO hay policy de select
-- para authenticated ni siquiera para el propio dueño — el refresh_token es
-- un secreto real (da acceso de verdad al Gmail del cliente), así que ni él
-- mismo lo lee por la API pública. Su config no sensible (tono, FAQ, firma)
-- se gestionaría a través de un RPC específico si hace falta más adelante,
-- nunca leyendo la tabla entera.
revoke all on client_email_bot_config from public, anon, authenticated;

drop trigger if exists audit_client_email_bot_config on client_email_bot_config;
create trigger audit_client_email_bot_config
  after insert or update or delete on client_email_bot_config
  for each row execute function audit_row_change();

drop trigger if exists set_actualizado_en on client_email_bot_config;
create trigger set_actualizado_en
  before update on client_email_bot_config
  for each row execute function _touch_actualizado_en();

-- Prueba de humo: solo confirmar que la tabla existe con RLS activo y sin
-- ninguna policy — select/insert/update/delete con la clave anon o
-- authenticated deben devolver vacío/error siempre, solo service_role puede
-- tocarla directamente.
