-- TRUCO technology — esquema del CRM (clientes + interacciones)
-- Ejecutar una sola vez en Supabase: Project → SQL Editor → pegar todo → Run.

create extension if not exists pgcrypto;

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  nombre text,
  email text unique,
  telefono text,
  negocio text,
  tipo text,
  nif text,
  status text not null default 'nuevo' check (status in ('nuevo','contactado','cliente','descartado'))
);

create table if not exists interactions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete set null,
  session_id text,
  source text not null check (source in ('checkout','chat','voice','manual')),
  nota text,
  created_at timestamptz not null default now()
);

create index if not exists interactions_client_id_idx on interactions(client_id);
create index if not exists interactions_session_id_idx on interactions(session_id);

-- Única función que puede escribir: busca/crea el cliente por email, enlaza
-- sesiones anónimas previas del mismo navegador, y añade la nota. Solo la
-- puede ejecutar la service_role (nunca el navegador ni un usuario anónimo).
create or replace function log_interaction(
  p_source text,
  p_session_id text default null,
  p_nombre text default null,
  p_email text default null,
  p_telefono text default null,
  p_negocio text default null,
  p_tipo text default null,
  p_nif text default null,
  p_nota text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
begin
  if p_email is not null and p_email <> '' then
    insert into clients (nombre, email, telefono, negocio, tipo, nif)
    values (p_nombre, p_email, p_telefono, p_negocio, p_tipo, p_nif)
    on conflict (email) do update set
      nombre = coalesce(excluded.nombre, clients.nombre),
      telefono = coalesce(excluded.telefono, clients.telefono),
      negocio = coalesce(excluded.negocio, clients.negocio),
      tipo = coalesce(excluded.tipo, clients.tipo),
      nif = coalesce(excluded.nif, clients.nif),
      updated_at = now()
    returning id into v_client_id;

    if p_session_id is not null then
      update interactions set client_id = v_client_id
      where session_id = p_session_id and client_id is null;
    end if;
  end if;

  insert into interactions (client_id, session_id, source, nota)
  values (v_client_id, p_session_id, p_source, p_nota);

  return v_client_id;
end;
$$;

revoke all on function log_interaction from public, anon, authenticated;
grant execute on function log_interaction to service_role;

-- Row Level Security: nadie sin sesión ve o toca nada. Los usuarios logueados
-- en el panel (Supabase Auth) pueden leer todo y actualizar el status.
alter table clients enable row level security;
alter table interactions enable row level security;

drop policy if exists "authenticated read clients" on clients;
create policy "authenticated read clients" on clients
  for select using (auth.role() = 'authenticated');

drop policy if exists "authenticated update clients" on clients;
create policy "authenticated update clients" on clients
  for update using (auth.role() = 'authenticated');

drop policy if exists "authenticated read interactions" on interactions;
create policy "authenticated read interactions" on interactions
  for select using (auth.role() = 'authenticated');

-- El panel también puede borrar un cliente (con confirmación en pantalla)
-- y añadir notas manuales propias — pero solo con source='manual', para que
-- el navegador nunca pueda fabricar una interacción de checkout/chat/voice.
drop policy if exists "authenticated delete clients" on clients;
create policy "authenticated delete clients" on clients
  for delete using (auth.role() = 'authenticated');

drop policy if exists "authenticated insert manual interactions" on interactions;
create policy "authenticated insert manual interactions" on interactions
  for insert with check (auth.role() = 'authenticated' and source = 'manual');

drop policy if exists "authenticated delete interactions" on interactions;
create policy "authenticated delete interactions" on interactions
  for delete using (auth.role() = 'authenticated');
