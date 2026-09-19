-- CRM base por cliente (Basic / Lite / Pro): cada cliente de TRUCO tiene su propia
-- libreta de contactos, que se llena sola desde sus automatizaciones (reservas,
-- WhatsApp, correo) y que él ve en su portal. Aislamiento por cliente con RLS.
-- Idempotente: se puede volver a ejecutar.

create table if not exists crm_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  nombre text,
  telefono text,
  telefono_norm text,
  email text,
  email_norm text,
  estado text not null default 'nuevo' check (estado in ('nuevo','contactado','cita','cliente','perdido')),
  origen text,
  notas text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create unique index if not exists crm_contacts_phone_uq on crm_contacts (client_id, telefono_norm) where telefono_norm is not null;
create unique index if not exists crm_contacts_email_uq on crm_contacts (client_id, email_norm) where email_norm is not null;
create index if not exists crm_contacts_client_seen_idx on crm_contacts (client_id, last_seen desc);

create table if not exists crm_activities (
  id bigserial primary key,
  contact_id uuid not null references crm_contacts(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null check (kind in ('mensaje','cita','llamada','correo','nota')),
  source text,
  texto text,
  created_at timestamptz not null default now()
);
create index if not exists crm_activities_contact_idx on crm_activities (contact_id, id desc);

alter table crm_contacts enable row level security;
alter table crm_activities enable row level security;

-- Dueño de la fila = el usuario del portal enlazado a ese cliente.
create or replace function crm_owns_client(p_client_id uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from clients c where c.id = p_client_id and c.auth_user_id = auth.uid());
$$;
revoke all on function crm_owns_client(uuid) from public;
grant execute on function crm_owns_client(uuid) to authenticated;

drop policy if exists "crm contacts founder" on crm_contacts;
create policy "crm contacts founder" on crm_contacts for all using (is_founder()) with check (is_founder());
drop policy if exists "crm contacts owner select" on crm_contacts;
create policy "crm contacts owner select" on crm_contacts for select using (crm_owns_client(client_id));
drop policy if exists "crm contacts owner insert" on crm_contacts;
create policy "crm contacts owner insert" on crm_contacts for insert with check (crm_owns_client(client_id));
drop policy if exists "crm contacts owner update" on crm_contacts;
create policy "crm contacts owner update" on crm_contacts for update using (crm_owns_client(client_id)) with check (crm_owns_client(client_id));
drop policy if exists "crm contacts owner delete" on crm_contacts;
create policy "crm contacts owner delete" on crm_contacts for delete using (crm_owns_client(client_id));

drop policy if exists "crm activities founder" on crm_activities;
create policy "crm activities founder" on crm_activities for all using (is_founder()) with check (is_founder());
drop policy if exists "crm activities owner select" on crm_activities;
create policy "crm activities owner select" on crm_activities for select using (crm_owns_client(client_id));
drop policy if exists "crm activities owner insert note" on crm_activities;
create policy "crm activities owner insert note" on crm_activities for insert with check (
  crm_owns_client(client_id) and kind = 'nota'
  and exists (select 1 from crm_contacts k where k.id = contact_id and k.client_id = crm_activities.client_id)
);

-- Normaliza teléfonos: solo dígitos, sin 00 inicial, y 9 dígitos españoles → 34 + número.
create or replace function crm_norm_phone(p text) returns text
language plpgsql immutable as $$
declare d text;
begin
  if p is null then return null; end if;
  d := regexp_replace(p, '\D', '', 'g');
  if d like '00%' then d := substr(d, 3); end if;
  if length(d) = 9 and d ~ '^[6-9]' then d := '34' || d; end if;
  if length(d) < 8 then return null; end if;
  return d;
end;
$$;

-- Lo llaman las funciones de Netlify (service_role) cada vez que una automatización
-- atiende a alguien: crea el contacto si no existe (por teléfono o email) o lo
-- actualiza, y apunta la actividad. El estado solo avanza, nunca retrocede.
create or replace function crm_capture(
  p_client_id uuid, p_source text, p_kind text,
  p_nombre text default null, p_telefono text default null, p_email text default null,
  p_texto text default null, p_estado text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tel text := crm_norm_phone(p_telefono);
  v_mail text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_id uuid;
  v_cur text;
  v_rank jsonb := '{"nuevo":0,"contactado":1,"cita":2,"cliente":3,"perdido":0}';
begin
  if p_client_id is null or not exists (select 1 from clients where id = p_client_id) then
    return null;
  end if;
  if p_kind not in ('mensaje','cita','llamada','correo','nota') then p_kind := 'mensaje'; end if;
  if p_estado is not null and p_estado not in ('nuevo','contactado','cita','cliente','perdido') then p_estado := null; end if;
  if v_tel is null and v_mail is null then return null; end if;

  if v_tel is not null then
    select id, estado into v_id, v_cur from crm_contacts where client_id = p_client_id and telefono_norm = v_tel;
  end if;
  if v_id is null and v_mail is not null then
    select id, estado into v_id, v_cur from crm_contacts where client_id = p_client_id and email_norm = v_mail;
  end if;

  if v_id is null then
    insert into crm_contacts (client_id, nombre, telefono, telefono_norm, email, email_norm, estado, origen)
    values (p_client_id, left(nullif(btrim(coalesce(p_nombre, '')), ''), 200), left(p_telefono, 50), v_tel,
            left(v_mail, 200), v_mail, coalesce(p_estado, 'nuevo'), left(p_source, 40))
    returning id into v_id;
  else
    update crm_contacts set
      last_seen = now(),
      nombre = coalesce(nombre, left(nullif(btrim(coalesce(p_nombre, '')), ''), 200)),
      telefono = coalesce(telefono, left(p_telefono, 50)),
      telefono_norm = coalesce(telefono_norm, v_tel),
      email = coalesce(email, left(v_mail, 200)),
      email_norm = coalesce(email_norm, v_mail),
      estado = case when p_estado is not null and (v_rank->>p_estado)::int > (v_rank->>v_cur)::int and v_cur <> 'perdido'
                    then p_estado else estado end
    where id = v_id;
  end if;

  if p_texto is not null then
    insert into crm_activities (contact_id, client_id, kind, source, texto)
    values (v_id, p_client_id, p_kind, left(p_source, 40), left(p_texto, 600));
  end if;
  return v_id;
end;
$$;
revoke all on function crm_capture(uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function crm_capture(uuid, text, text, text, text, text, text, text) to service_role;

-- Contactos creados o editados a mano desde el portal: recalcula las claves de duplicado.
create or replace function crm_contacts_norm() returns trigger
language plpgsql set search_path = public as $$
begin
  new.telefono_norm := crm_norm_phone(new.telefono);
  new.email_norm := nullif(lower(btrim(coalesce(new.email, ''))), '');
  return new;
end;
$$;
drop trigger if exists crm_contacts_norm_trg on crm_contacts;
create trigger crm_contacts_norm_trg before insert or update of telefono, email on crm_contacts
  for each row execute function crm_contacts_norm();
