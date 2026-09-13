-- "Firma Digital" como producto independiente — hasta ahora el único código
-- real de firma electrónica cualificada (XAdES vía AutoFirma/Cliente@firma)
-- vivía dentro de TruKi, acoplado a facturas (truki-firma-xades.js firma un
-- invoice_id concreto en el proyecto Supabase de TruKi). Este producto se
-- vende de forma independiente en la web (soluciones/firma.html, 500€ +
-- IVA) para CUALQUIER documento (contratos, presupuestos, acuerdos), no
-- solo facturas de clientes de TruKi — hacía falta esta base de datos
-- propia, en el proyecto Supabase PRINCIPAL, para poder entregarlo a un
-- cliente que no usa TruKi en absoluto.
--
-- Mismo patrón de "backend compartido" que WhatsApp/Web/Reservas: una sola
-- función atiende a todos los clientes, identificando de cuál se trata por
-- una clave pública (firma_key) que el cliente pega en su propia web.
--
-- El relay de transporte (firma-relay.js) reutiliza EXACTAMENTE el mismo
-- protocolo que truki-firma-relay.js (ya verificado contra el código fuente
-- oficial de AutoFirma/Cliente@firma) — solo cambia la tabla de blobs
-- temporales, de truki_firma_temp a firma_temp, para no compartir estado
-- transitorio entre los dos productos.

create table if not exists client_firma_config (
  client_id uuid primary key references clients(id) on delete cascade,
  firma_key uuid not null default gen_random_uuid() unique,
  nombre_negocio text not null,
  activo boolean not null default true,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

alter table client_firma_config enable row level security;

-- Nadie lee la tabla completa por la API pública, ni con la clave anon ni
-- autenticado — el widget del cliente solo conoce su firma_key (un UUID no
-- adivinable) y la resuelve a través del RPC de abajo, que solo expone lo
-- imprescindible (nombre del negocio), igual que get_web_bot_config_by_widget_key.
revoke all on client_firma_config from public, anon, authenticated;

drop trigger if exists audit_client_firma_config on client_firma_config;
create trigger audit_client_firma_config
  after insert or update or delete on client_firma_config
  for each row execute function audit_row_change();

drop trigger if exists set_actualizado_en on client_firma_config;
create trigger set_actualizado_en
  before update on client_firma_config
  for each row execute function _touch_actualizado_en();

create or replace function get_firma_config_by_key(p_firma_key uuid)
returns table(client_id uuid, nombre_negocio text)
language sql security definer set search_path = public stable as $$
  select client_id, nombre_negocio
  from client_firma_config
  where firma_key = p_firma_key and activo = true;
$$;

grant execute on function get_firma_config_by_key(uuid) to anon, authenticated;

-- Registro definitivo de cada documento firmado: guarda el documento
-- original Y la firma XAdES detached que lo acompaña — hacen falta los dos
-- juntos para que la firma tenga valor probatorio real (la firma es un hash
-- firmado del documento, no sirve de nada archivada sola).
create table if not exists documentos_firmados (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  documento_nombre text not null,
  documento_base64 text not null,
  firma_base64 text not null,
  certificado_base64 text,
  firmante_nombre text,
  firmante_email text,
  firmado_en timestamptz not null default now()
);

alter table documentos_firmados enable row level security;
revoke all on documentos_firmados from public, anon, authenticated;

drop trigger if exists audit_documentos_firmados on documentos_firmados;
create trigger audit_documentos_firmados
  after insert or update or delete on documentos_firmados
  for each row execute function audit_row_change();

-- Blobs de transporte de un solo uso para el protocolo trifásico de
-- AutoFirma/Cliente@firma — ver firma-relay.js. Tabla propia (no
-- compartida con truki_firma_temp) para que los dos productos de firma no
-- puedan pisarse el estado transitorio entre sí.
create table if not exists firma_temp (
  id text primary key,
  dat text not null,
  created_at timestamptz not null default now()
);

alter table firma_temp enable row level security;
revoke all on firma_temp from public, anon, authenticated;

-- Prueba de humo:
-- 1. select * from client_firma_config; -- con anon key debe devolver [] o error de permiso, nunca filas.
-- 2. select * from get_firma_config_by_key('00000000-0000-0000-0000-000000000000'); -- con anon key debe funcionar (RPC) y devolver 0 filas si no existe esa key.
-- 3. select * from documentos_firmados; -- con anon key debe fallar/devolver vacío.
-- 4. select * from firma_temp; -- con anon key debe fallar/devolver vacío.
