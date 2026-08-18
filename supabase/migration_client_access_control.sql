-- =============================================================================
-- MIGRACIÓN — Control de acceso granular por cliente + "dar de baja"
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase (pegar todo → Run).
-- NO toca migration_monstruo_overhaul.sql. Requiere que esa migración ya esté
-- aplicada en producción (usa staff_roles, is_admin(), clients.status,
-- clients.implementation_stage tal como los dejó esa migración).
--
-- Idempotente a propósito (create table if not exists / drop policy if exists
-- antes de cada create policy / create or replace en todas las funciones).
--
-- CAMBIO DE MODELO IMPORTANTE — léelo antes de ejecutar:
-- Hasta ahora, cualquier staff_roles.role IN ('founder','admin') tenía acceso
-- de bloque a TODO vía is_admin(). A partir de aquí, is_admin() desaparece y
-- SOLO role='founder' conserva acceso de bloque. Cualquier miembro del equipo
-- que hoy tenga role='admin' en staff_roles se queda SIN acceso a ningún dato
-- de cliente en cuanto esto se ejecute, hasta que el founder le conceda acceso
-- cliente a cliente vía grant_client_access(). Antes de ejecutar, corre:
--   select user_id, role from staff_roles where role <> 'founder';
-- Si esa consulta devuelve filas, decide si quieres hacerles un backfill de
-- staff_client_access para no dejarlos a ciegas de golpe (ver bloque opcional
-- comentado al final de este archivo — NO se ejecuta solo, es tu decisión).
--
-- ORDEN DE DEPENDENCIAS (no reordenar):
--   1. is_founder()                     — no depende de nada nuevo
--   2. staff_client_access (tabla+RLS)  — su política usa is_founder()
--   3. has_client_access()              — usa is_founder() + staff_client_access
--   4. is_authorized_staff()            — usa is_founder() + staff_client_access
--   5. grant_client_access() / revoke_client_access() / deactivate_client() /
--      update_client_status() / update_client_stage()
--                                       — usan is_founder()/has_client_access()
--   6. clients_status_check (+'baja')   — independiente, pero antes de que
--                                          deactivate_client() se use de verdad
--   7. Reescritura de TODAS las políticas is_admin()-gated, tabla por tabla
--   8. anonymize_client() / audit_row_change() reescritas (dejan de llamar
--      a is_admin())
--   9. clients_abandoned_checkout() / founder_weekly_digest() — fix de status
--  10. drop function is_admin()         — SIEMPRE LO ÚLTIMO. Si algo de lo de
--                                          arriba falla o se salta, esto falla
--                                          con "cannot drop function because
--                                          other objects depend on it".
-- =============================================================================


-- =============================================================================
-- 1) is_founder() — único gate de acceso de bloque a partir de ahora
-- =============================================================================
create or replace function is_founder() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from staff_roles where user_id = auth.uid() and role = 'founder');
$$;
revoke all on function is_founder() from public;
grant execute on function is_founder() to authenticated, anon;


-- =============================================================================
-- 2) staff_client_access — concesión de acceso por cliente concreto
-- =============================================================================
create table if not exists staff_client_access (
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  permission text not null check (permission in ('view','edit')),
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, client_id)
);
-- La PK (user_id, client_id) ya indexa búsquedas por user_id (columna líder);
-- añade un índice aparte para las búsquedas por client_id que hace la ficha
-- del panel (sección "Accesos" — lista quién tiene acceso a ESTE cliente).
create index if not exists staff_client_access_client_idx on staff_client_access(client_id);

alter table staff_client_access enable row level security;
drop policy if exists "founder read staff_client_access" on staff_client_access;
create policy "founder read staff_client_access" on staff_client_access
  for select using (is_founder());
-- Sin insert/update/delete para nadie vía REST: solo grant_client_access() y
-- revoke_client_access() (SECURITY DEFINER, más abajo) escriben aquí, mismo
-- patrón que staff_roles.


-- =============================================================================
-- 3) has_client_access() — el nuevo gate que sustituye a is_admin() en todas
--    las políticas per-cliente
-- =============================================================================
create or replace function has_client_access(p_client_id uuid, p_min_permission text default 'view')
returns boolean
language sql security definer set search_path = public stable as $$
  select is_founder() or exists (
    select 1 from staff_client_access sca
    where sca.user_id = auth.uid()
      and sca.client_id = p_client_id
      and (p_min_permission <> 'edit' or sca.permission = 'edit')
  );
$$;
revoke all on function has_client_access(uuid, text) from public;
-- grant a anon TAMBIÉN (no solo authenticated): esta función se invoca
-- directamente dentro de políticas RLS de tablas sin cláusula "TO", que por
-- eso se evalúan para cualquier rol que consulte esas tablas, incluido anon
-- — sin este grant, una consulta anon a cualquiera de esas tablas fallaría
-- con "permission denied for function" en vez de simplemente no ver filas
-- (mismo motivo por el que is_admin() estaba concedida también a anon).
grant execute on function has_client_access(uuid, text) to authenticated, anon;


-- =============================================================================
-- 4) is_authorized_staff() — nuevo gate de entrada al panel (sustituye a
--    is_admin() en verifyAdminAndShowApp())
-- =============================================================================
create or replace function is_authorized_staff() returns boolean
language sql security definer set search_path = public stable as $$
  select is_founder() or exists (select 1 from staff_client_access where user_id = auth.uid());
$$;
revoke all on function is_authorized_staff() from public;
grant execute on function is_authorized_staff() to authenticated, anon;


-- =============================================================================
-- 5) grant_client_access() / revoke_client_access() — únicas escrituras
--    permitidas en staff_client_access, exclusivas del founder
-- =============================================================================
create or replace function grant_client_access(p_user_id uuid, p_client_id uuid, p_permission text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_founder() then
    raise exception 'Solo el founder puede conceder acceso a clientes';
  end if;
  insert into staff_client_access (user_id, client_id, permission, granted_by)
  values (p_user_id, p_client_id, p_permission, auth.uid())
  on conflict (user_id, client_id) do update
    set permission = excluded.permission, granted_at = now(), granted_by = auth.uid();
end;
$$;
revoke all on function grant_client_access(uuid, uuid, text) from public, anon;
grant execute on function grant_client_access(uuid, uuid, text) to authenticated;
-- Sin validar p_permission a mano a propósito: el check de la tabla
-- (permission in ('view','edit')) ya rechaza cualquier otro valor con un
-- error claro de Postgres — mismo principio de "una sola fuente de verdad"
-- que el resto del archivo.

create or replace function revoke_client_access(p_user_id uuid, p_client_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_founder() then
    raise exception 'Solo el founder puede revocar acceso a clientes';
  end if;
  delete from staff_client_access where user_id = p_user_id and client_id = p_client_id;
end;
$$;
revoke all on function revoke_client_access(uuid, uuid) from public, anon;
grant execute on function revoke_client_access(uuid, uuid) to authenticated;


-- =============================================================================
-- 6) deactivate_client() — "dar de baja", exclusivo del founder, no destructivo
-- =============================================================================
create or replace function deactivate_client(p_client_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_founder() then
    raise exception 'Solo el founder puede dar de baja a un cliente';
  end if;
  update clients set status = 'baja', updated_at = now() where id = p_client_id;
end;
$$;
revoke all on function deactivate_client(uuid) from public, anon;
grant execute on function deactivate_client(uuid) to authenticated;


-- =============================================================================
-- 7) update_client_status() / update_client_stage() — únicas vías de escritura
--    de status/implementation_stage para quien no es founder (columnas fijas,
--    para que un 'edit' en staff_client_access no pueda tocar auth_user_id,
--    is_founder, plan_key, etc. vía un UPDATE ... with check amplio)
-- =============================================================================
create or replace function update_client_status(p_client_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_client_access(p_client_id, 'edit') then
    raise exception 'No tienes permiso de edición sobre este cliente';
  end if;
  if p_status = 'baja' then
    raise exception 'Usa deactivate_client() para dar de baja a un cliente, no update_client_status()';
  end if;
  if p_status not in ('nuevo','contactado','cliente','descartado') then
    raise exception 'Status no válido: %', p_status;
  end if;
  update clients set status = p_status, updated_at = now() where id = p_client_id;
end;
$$;
revoke all on function update_client_status(uuid, text) from public, anon;
grant execute on function update_client_status(uuid, text) to authenticated;

create or replace function update_client_stage(p_client_id uuid, p_stage text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not has_client_access(p_client_id, 'edit') then
    raise exception 'No tienes permiso de edición sobre este cliente';
  end if;
  -- p_stage se valida solo: clients_implementation_stage_check (definida en
  -- migration_growth_automation.sql) rechaza cualquier valor fuera de
  -- ('contratado','en_implantacion','revision','completado') con un error
  -- claro de Postgres, sin duplicar la lista aquí.
  update clients set implementation_stage = p_stage, updated_at = now() where id = p_client_id;
end;
$$;
revoke all on function update_client_stage(uuid, text) from public, anon;
grant execute on function update_client_stage(uuid, text) to authenticated;


-- =============================================================================
-- 8) clients.status — añade 'baja' sin quitar ningún valor existente
-- =============================================================================
alter table clients drop constraint if exists clients_status_check;
alter table clients add constraint clients_status_check
  check (status in ('nuevo','contactado','cliente','descartado','baja'));


-- =============================================================================
-- 9) clients — reescritura de políticas
-- =============================================================================
drop policy if exists "admin read clients" on clients;
drop policy if exists "staff read clients" on clients;
create policy "staff read clients" on clients
  for select using (has_client_access(id, 'view'));

drop policy if exists "admin update clients" on clients;
drop policy if exists "founder update clients" on clients;
create policy "founder update clients" on clients
  for update using (is_founder()) with check (is_founder());
-- Sin política de update para nadie más: un colaborador con 'edit' pasa por
-- update_client_status()/update_client_stage() (columnas fijas). El founder
-- conserva UPDATE directo por REST para el resto de columnas (nombre,
-- negocio, teléfono, nif, plan_key, etc.) sin necesitar una función por cada
-- campo.

drop policy if exists "admin delete clients" on clients;
-- Sin política de delete para NADIE, ni siquiera el founder: deactivate_client()
-- es el único camino (no destructivo). Un borrado físico real, si algún día
-- hiciera falta, lo hace el founder a mano en el SQL Editor de Supabase, fuera
-- de RLS — decisión deliberada, no un descuido.

-- "client read own row" (select, auth_user_id = auth.uid()) — sin tocar.


-- =============================================================================
-- 10) interactions — split en anónimas (client_id is null, founder-only) vs.
--     de cliente concreto (has_client_access)
-- =============================================================================
drop policy if exists "admin read interactions" on interactions;
drop policy if exists "founder read anon interactions" on interactions;
create policy "founder read anon interactions" on interactions
  for select using (is_founder() and client_id is null);
drop policy if exists "staff read client interactions" on interactions;
create policy "staff read client interactions" on interactions
  for select using (client_id is not null and has_client_access(client_id, 'view'));

drop policy if exists "admin insert manual interactions" on interactions;
drop policy if exists "founder insert anon manual interactions" on interactions;
create policy "founder insert anon manual interactions" on interactions
  for insert with check (is_founder() and client_id is null and source = 'manual');
drop policy if exists "staff insert client manual interactions" on interactions;
create policy "staff insert client manual interactions" on interactions
  for insert with check (client_id is not null and source = 'manual' and has_client_access(client_id, 'edit'));

drop policy if exists "admin delete interactions" on interactions;
drop policy if exists "founder delete anon interactions" on interactions;
create policy "founder delete anon interactions" on interactions
  for delete using (is_founder() and client_id is null);
drop policy if exists "staff delete client interactions" on interactions;
create policy "staff delete client interactions" on interactions
  for delete using (client_id is not null and has_client_access(client_id, 'edit'));

-- "client read own portal interactions" — sin tocar.


-- =============================================================================
-- 11) client_solutions — de "admin all" a 4 políticas por comando (view ≠ edit)
-- =============================================================================
drop policy if exists "admin all client_solutions" on client_solutions;
drop policy if exists "staff read client_solutions" on client_solutions;
create policy "staff read client_solutions" on client_solutions
  for select using (has_client_access(client_id, 'view'));
drop policy if exists "staff insert client_solutions" on client_solutions;
create policy "staff insert client_solutions" on client_solutions
  for insert with check (has_client_access(client_id, 'edit'));
drop policy if exists "staff update client_solutions" on client_solutions;
create policy "staff update client_solutions" on client_solutions
  for update using (has_client_access(client_id, 'edit')) with check (has_client_access(client_id, 'edit'));
drop policy if exists "staff delete client_solutions" on client_solutions;
create policy "staff delete client_solutions" on client_solutions
  for delete using (has_client_access(client_id, 'edit'));

-- "client read own client_solutions" — sin tocar.


-- =============================================================================
-- 12) payments — solo lectura, igual que antes
-- =============================================================================
drop policy if exists "admin read payments" on payments;
drop policy if exists "staff read payments" on payments;
create policy "staff read payments" on payments
  for select using (has_client_access(client_id, 'view'));

-- "client read own payments" — sin tocar. Sin insert/update/delete para
-- nadie, como ya era el caso.


-- =============================================================================
-- 13) tasks — de "admin all" a 4 políticas por comando
-- =============================================================================
drop policy if exists "admin all tasks" on tasks;
drop policy if exists "staff read tasks" on tasks;
create policy "staff read tasks" on tasks
  for select using (has_client_access(client_id, 'view'));
drop policy if exists "staff insert tasks" on tasks;
create policy "staff insert tasks" on tasks
  for insert with check (has_client_access(client_id, 'edit'));
drop policy if exists "staff update tasks" on tasks;
create policy "staff update tasks" on tasks
  for update using (has_client_access(client_id, 'edit')) with check (has_client_access(client_id, 'edit'));
drop policy if exists "staff delete tasks" on tasks;
create policy "staff delete tasks" on tasks
  for delete using (has_client_access(client_id, 'edit'));

-- "client read own tasks" — sin tocar.


-- =============================================================================
-- 14) client_automations — de "admin all" a 4 políticas por comando
-- =============================================================================
drop policy if exists "admin all client_automations" on client_automations;
drop policy if exists "staff read client_automations" on client_automations;
create policy "staff read client_automations" on client_automations
  for select using (has_client_access(client_id, 'view'));
drop policy if exists "staff insert client_automations" on client_automations;
create policy "staff insert client_automations" on client_automations
  for insert with check (has_client_access(client_id, 'edit'));
drop policy if exists "staff update client_automations" on client_automations;
create policy "staff update client_automations" on client_automations
  for update using (has_client_access(client_id, 'edit')) with check (has_client_access(client_id, 'edit'));
drop policy if exists "staff delete client_automations" on client_automations;
create policy "staff delete client_automations" on client_automations
  for delete using (has_client_access(client_id, 'edit'));

-- "client read own client_automations" — sin tocar.


-- =============================================================================
-- 15/16/17) usage_events, usage_alerts_sent, satisfaction_surveys — solo
--     lectura, client_id NOT NULL en las tres, cambio directo
-- =============================================================================

-- BACKFILL DEFENSIVO — usage_events (y sus funciones) resultaron no existir
-- en producción pese a que migration_usage_tracking.sql las da por aplicadas
-- (mismo patrón de migraciones nunca terminadas de esta noche). Se recrea
-- aquí, byte-idéntico al original, para que el resto de esta sección no
-- falle con "relation does not exist" — y de paso deja el contador de uso
-- del portal realmente funcional, que hasta ahora no lo estaba.
create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  solution_key text not null check (solution_key in ('whatsapp','web-ia','email-ia','llamadas')),
  created_at timestamptz not null default now()
);
create index if not exists usage_events_client_period_idx on usage_events(client_id, solution_key, created_at);
alter table usage_events enable row level security;

create or replace function log_usage_event(p_client_id uuid, p_solution_key text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into usage_events (client_id, solution_key)
  select p_client_id, p_solution_key
  where p_solution_key in ('whatsapp','web-ia','email-ia','llamadas');
$$;
revoke all on function log_usage_event from public, anon, authenticated;
grant execute on function log_usage_event to service_role;

create or replace function portal_usage_summary()
returns table(solution_key text, used int)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_client_id uuid;
begin
  select id into v_client_id from clients where auth_user_id = auth.uid();
  if v_client_id is null then
    return;
  end if;
  return query
    select ue.solution_key, count(*)::int as used
    from usage_events ue
    where ue.client_id = v_client_id
      and ue.created_at >= date_trunc('month', now())
      and ue.created_at < date_trunc('month', now()) + interval '1 month'
    group by ue.solution_key;
end;
$$;
revoke all on function portal_usage_summary from public, anon;
grant execute on function portal_usage_summary to authenticated;

drop policy if exists "admin read usage_events" on usage_events;
drop policy if exists "staff read usage_events" on usage_events;
create policy "staff read usage_events" on usage_events
  for select using (has_client_access(client_id, 'view'));

-- BACKFILL DEFENSIVO — mismo motivo que usage_events arriba: por si
-- migration_growth_automation.sql tampoco llegó a aplicarse del todo.
-- Byte-idéntico al original de ese archivo.
create table if not exists usage_alerts_sent (
  client_id uuid not null references clients(id) on delete cascade,
  solution_key text not null,
  period_start date not null,
  alert_type text not null check (alert_type in ('near_limit', 'over_limit')),
  sent_at timestamptz not null default now(),
  primary key (client_id, solution_key, period_start, alert_type)
);
alter table usage_alerts_sent enable row level security;
drop policy if exists "admin read usage_alerts_sent" on usage_alerts_sent;
drop policy if exists "staff read usage_alerts_sent" on usage_alerts_sent;
create policy "staff read usage_alerts_sent" on usage_alerts_sent
  for select using (has_client_access(client_id, 'view'));

-- BACKFILL DEFENSIVO — mismo motivo, mismo archivo de origen.
create table if not exists satisfaction_surveys (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  sent_at timestamptz not null default now(),
  responded_at timestamptz,
  score int check (score between 1 and 5),
  comentario text
);
create index if not exists satisfaction_surveys_client_id_idx on satisfaction_surveys(client_id);
alter table satisfaction_surveys enable row level security;
drop policy if exists "admin read satisfaction_surveys" on satisfaction_surveys;
drop policy if exists "staff read satisfaction_surveys" on satisfaction_surveys;
create policy "staff read satisfaction_surveys" on satisfaction_surveys
  for select using (has_client_access(client_id, 'view'));


-- =============================================================================
-- 18/19) solutions_catalog, tier_config — NO son por-cliente (config global),
--     así que has_client_access no aplica: pasan a ser founder-exclusive para
--     escritura, igual que el resto de "acceso de bloque". Lectura pública
--     intacta.
-- =============================================================================
drop policy if exists "admin all solutions_catalog" on solutions_catalog;
drop policy if exists "founder all solutions_catalog" on solutions_catalog;
create policy "founder all solutions_catalog" on solutions_catalog
  for all using (is_founder()) with check (is_founder());
-- "public read active solutions_catalog" — sin tocar.

drop policy if exists "admin all tier_config" on tier_config;
drop policy if exists "founder all tier_config" on tier_config;
create policy "founder all tier_config" on tier_config
  for all using (is_founder()) with check (is_founder());
-- "public read tier_config" — sin tocar.


-- =============================================================================
-- 20) staff_roles — lectura pasa a ser founder-exclusiva (antes admin+founder)
-- =============================================================================
drop policy if exists "admin read staff_roles" on staff_roles;
drop policy if exists "founder read staff_roles" on staff_roles;
create policy "founder read staff_roles" on staff_roles
  for select using (is_founder());


-- =============================================================================
-- 21) data_retention_requests — founder-exclusive completo (ver nota de
--     diseño: es una desviación deliberada del patrón has_client_access que
--     aplica al resto de tablas — el RGPD es irreversible y de alto riesgo
--     legal, mismo criterio que "dar de baja")
-- =============================================================================
drop policy if exists "admin all data_retention_requests" on data_retention_requests;
drop policy if exists "founder all data_retention_requests" on data_retention_requests;
create policy "founder all data_retention_requests" on data_retention_requests
  for all using (is_founder()) with check (is_founder());

-- anonymize_client() referenciaba is_admin() internamente para decidir quién
-- puede invocarla — se cambia a is_founder() por el mismo motivo. Cuerpo
-- idéntico al original salvo esa única línea + el texto del mensaje de error.
create or replace function anonymize_client(p_client_id uuid, p_request_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_founder() then
    raise exception 'Solo el founder puede anonimizar un cliente';
  end if;

  update clients set
    nombre = 'Cliente anonimizado',
    email = null,
    telefono = null,
    negocio = null,
    nif = null,
    auth_user_id = null,
    referral_code = null,
    status = 'descartado',
    updated_at = now()
  where id = p_client_id;

  update interactions set nota = '[anonimizado]' where client_id = p_client_id;
  update tasks set title = '[anonimizado]', description = null where client_id = p_client_id;

  if p_request_id is not null then
    update data_retention_requests set status = 'completed', completed_at = now() where id = p_request_id;
  end if;
end;
$$;
revoke all on function anonymize_client(uuid, uuid) from public, anon, authenticated;
grant execute on function anonymize_client(uuid, uuid) to authenticated; -- gate interno de is_founder()


-- =============================================================================
-- 22) audit_log — lectura founder-exclusiva (record_id es texto genérico sin
--     FK a clients, no hay forma limpia de aplicar has_client_access aquí)
-- =============================================================================
drop policy if exists "admin read audit_log" on audit_log;
drop policy if exists "founder read audit_log" on audit_log;
create policy "founder read audit_log" on audit_log
  for select using (is_founder());


-- =============================================================================
-- 23) audit_row_change() — solo cambia qué función decide la etiqueta 'admin'
--     del actor_role (is_admin() → is_authorized_staff()); NO cambia el valor
--     'admin' en sí (el check de audit_log.actor_role sigue siendo
--     ('admin','client','system'), no se toca ese enum)
-- =============================================================================
create or replace function audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role text; v_record_id text;
begin
  v_role := case when auth.uid() is null then 'system' when is_authorized_staff() then 'admin' else 'client' end;
  v_record_id := coalesce(
    to_jsonb(coalesce(NEW, OLD))->>'id',
    to_jsonb(coalesce(NEW, OLD))->>'tier',
    to_jsonb(coalesce(NEW, OLD))->>'solution_key',
    to_jsonb(coalesce(NEW, OLD))->>'user_id',
    'n/a'
  );
  insert into audit_log (table_name, record_id, action, actor_id, actor_role, old_data, new_data)
  values (
    TG_TABLE_NAME, v_record_id, lower(TG_OP), auth.uid(), v_role,
    case when TG_OP in ('UPDATE','DELETE') then to_jsonb(OLD) else null end,
    case when TG_OP in ('INSERT','UPDATE') then to_jsonb(NEW) else null end
  );
  return coalesce(NEW, OLD);
end;
$$;


-- =============================================================================
-- BACKFILL DEFENSIVO — columnas de migration_growth_automation.sql. Ese
-- archivo tampoco se había aplicado del todo (mismo patrón que usage_events
-- arriba): clients_abandoned_checkout() de la sección 24 necesita
-- abandoned_2h_sent_at/abandoned_24h_sent_at, y de paso se blindan también
-- referral_code/referral_credits/churn_risk (columnas del mismo archivo que
-- otras partes ya construidas esta noche —el portal, el panel— dan por
-- hechas). Todo "add column if not exists": no toca nada si ya existía.
-- =============================================================================
alter table clients add column if not exists abandoned_2h_sent_at timestamptz;
alter table clients add column if not exists abandoned_24h_sent_at timestamptz;
alter table clients add column if not exists referral_code text unique
  default upper(substr(md5(random()::text || clock_timestamp()::text), 1, 7));
alter table clients add column if not exists referral_credits int not null default 0;
alter table clients add column if not exists churn_risk boolean not null default false;
update clients set referral_code = upper(substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 7))
where referral_code is null;


-- =============================================================================
-- 24) clients_abandoned_checkout() — único cambio: status <> 'cliente' →
--     status not in ('cliente','baja'). Todo lo demás byte-idéntico al
--     original de migration_growth_automation.sql.
-- =============================================================================
create or replace function clients_abandoned_checkout(p_stage text)
returns table(id uuid, nombre text, email text, telefono text, negocio text, iniciado_en timestamptz)
language sql
security definer
set search_path = public
stable
as $$
  select c.id, c.nombre, c.email, c.telefono, c.negocio, i.created_at
  from clients c
  join lateral (
    select created_at from interactions
    where client_id = c.id and source = 'checkout'
    order by created_at desc
    limit 1
  ) i on true
  where c.status not in ('cliente','baja')
    and (c.email is not null or c.telefono is not null)
    and (
      (p_stage = '2h' and c.abandoned_2h_sent_at is null
        and i.created_at <= now() - interval '2 hours' and i.created_at > now() - interval '24 hours')
      or
      (p_stage = '24h' and c.abandoned_24h_sent_at is null
        and i.created_at <= now() - interval '24 hours' and i.created_at > now() - interval '72 hours')
    );
$$;
revoke all on function clients_abandoned_checkout from public, anon, authenticated;
grant execute on function clients_abandoned_checkout to service_role;


-- =============================================================================
-- 25) founder_weekly_digest() — único cambio: en checkouts_abandonados_semana,
--     status <> 'cliente' → status not in ('cliente','baja'). Resto idéntico.
-- =============================================================================
create or replace function founder_weekly_digest()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'nuevos_leads_semana', (select count(*) from clients where created_at >= now() - interval '7 days'),
    'clientes_total', (select count(*) from clients where status = 'cliente'),
    'a_punto_de_renovar', (
      select coalesce(jsonb_agg(jsonb_build_object('nombre', r.nombre, 'negocio', r.negocio, 'fecha', r.renewal_date)), '[]'::jsonb)
      from clients_due_for_renewal(14) r
    ),
    'cerca_o_supera_limite', (
      select coalesce(jsonb_agg(jsonb_build_object('nombre', u.nombre, 'negocio', u.negocio, 'solucion', u.solution_key, 'pct', u.pct, 'tipo', u.alert_type)), '[]'::jsonb)
      from clients_near_usage_limit(0.8) u
    ),
    'checkouts_abandonados_semana', (
      select count(distinct client_id) from interactions
      where source = 'checkout' and created_at >= now() - interval '7 days'
        and client_id in (select id from clients where status not in ('cliente','baja'))
    )
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function founder_weekly_digest from public, anon, authenticated;
grant execute on function founder_weekly_digest to service_role;


-- =============================================================================
-- 26) drop is_admin() — SIEMPRE LO ÚLTIMO. Todo lo de arriba debe estar
--     aplicado sin errores antes de llegar aquí, o esto falla con "cannot
--     drop function because other objects depend on it".
-- =============================================================================
drop function if exists is_admin();


-- =============================================================================
-- FIN — prueba de humo antes de dar por bueno esto en producción:
--   1. select is_founder();  -- true logueado como founder
--   2. Como founder: grant_client_access(<user_id_de_prueba>, <client_id>, 'view')
--      y confirma que ESE usuario, logueado, ve exactamente ese cliente en
--      admin/panel.html y ningún otro.
--   3. El mismo usuario intenta cambiar el status de ese cliente a 'baja' vía
--      update_client_status → debe fallar con la excepción explícita.
--   4. El mismo usuario intenta deactivate_client() de ese cliente → debe
--      fallar (no es founder).
--   5. Founder llama deactivate_client() sobre un cliente de prueba, confirma
--      status='baja' y que TODAS sus filas relacionadas (interactions, tasks,
--      client_solutions, payments) siguen intactas.
--   6. Founder revoke_client_access() y confirma que ese usuario deja de ver
--      el cliente inmediatamente.
-- =============================================================================

-- =============================================================================
-- OPCIONAL — backfill de continuidad para staff_roles.role='admin' existentes
-- (NO se ejecuta como parte de la migración de arriba; decide tú si correrlo).
-- Da a cada 'admin' actual acceso 'edit' a TODOS los clientes existentes hoy,
-- para que no se queden a ciegas de golpe. Los clientes que se den de alta
-- DESPUÉS de correr esto NO quedan cubiertos — tendrás que seguir concediendo
-- acceso cliente a cliente a partir de ahora, este backfill es solo el
-- "punto de partida" de la transición.
-- =============================================================================
-- insert into staff_client_access (user_id, client_id, permission, granted_by)
-- select sr.user_id, c.id, 'edit', sr.user_id
-- from staff_roles sr cross join clients c
-- where sr.role = 'admin'
-- on conflict (user_id, client_id) do nothing;
