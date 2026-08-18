-- =============================================================================
-- MIGRACIÓN "MONSTRUO" — overhaul completo del backend de TRUCO technology
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase (pegar todo → Run).
--
-- ANTES de ejecutar esto: correr la consulta de introspección que aparece al
-- final de este comentario y confirmar que el estado real de producción
-- coincide con lo que esta migración asume (esta noche se descubrieron TRES
-- migraciones que existían en el repo pero nunca se habían aplicado del todo
-- en producción — no des por hecho que "está en el archivo" significa "está
-- en la base de datos real").
--
-- Este script es idempotente a propósito (if not exists / drop ... if exists
-- en todo) para poder re-ejecutarse sin romper nada si algo falla a mitad.
--
-- Añade 5 módulos:
--   1. Finanzas + auditoría   → payments, audit_log
--   2. Operativa y soporte    → tasks, client_automations
--   3. Catálogo y config      → solutions_catalog, tier_config
--   4. Equipo y permisos      → staff_roles (sustituye a admins como fuente
--                                de is_admin(), sin tocar ninguna política
--                                existente)
--   5. RGPD / retención       → data_retention_requests, anonymize_client()
--
-- Requiere: schema.sql, migration_plan_tracking.sql, migration_client_portal.sql,
-- migration_client_founder_flag.sql ya aplicadas (usa is_admin(), clients.auth_user_id,
-- client_solutions, confirm_client_purchase de 9 argumentos).
--
-- --- CONSULTA DE INTROSPECCIÓN (ejecutar ANTES, por separado, y revisar) ---
-- select table_name, column_name, data_type from information_schema.columns
--   where table_schema='public' order by table_name, ordinal_position;
-- select p.proname, pg_get_function_identity_arguments(p.oid) as args
--   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--   where n.nspname='public' order by p.proname;
-- select tablename, policyname, cmd from pg_policies
--   where schemaname='public' order by tablename, policyname;
-- Si algo aparece con una firma distinta a la que este archivo asume, añade
-- el "drop function if exists" correspondiente antes de ejecutar el resto.
-- =============================================================================


-- =============================================================================
-- MÓDULO 4 — Equipo y permisos (va primero: todo lo demás depende de is_admin())
-- =============================================================================

create table if not exists staff_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('founder','admin','support','readonly')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);
alter table staff_roles enable row level security;
-- Sin políticas a propósito (mismo patrón que "admins"): solo is_admin()/has_role()
-- pueden ver dentro, porque son SECURITY DEFINER y saltan RLS. La única excepción
-- (política de lectura para que el founder vea la lista en el panel) se añade
-- al final de este archivo, después de que is_admin() ya esté definida.

-- Siembra staff_roles desde la tabla admins existente — el founder ya dado de
-- alta ahí conserva acceso total sin tener que hacer nada más a mano.
insert into staff_roles (user_id, role)
select user_id, 'founder' from admins
on conflict (user_id) do nothing;

-- is_admin() se redefine para leer staff_roles en vez de admins. Como CADA
-- política RLS del sitio entero llama a is_admin() y no a la tabla admins
-- directamente, este único cambio propaga RBAC a todo el esquema sin tocar
-- ni una política más. "admins" se queda tal cual (no se borra) por si algo
-- externo aún la referencia; simplemente deja de ser la fuente de verdad.
-- A propósito SIN "drop function if exists" aquí (a diferencia de las demás
-- funciones de este archivo): is_admin() no cambia su lista de argumentos
-- (sigue sin parámetros), así que no hay riesgo de overload — y un montón de
-- políticas RLS ya existentes (admin read clients, admin update clients, etc.)
-- dependen de ELLA, así que un DROP falla con "cannot drop function because
-- other objects depend on it" a menos que se use CASCADE (que borraría esas
-- políticas). "create or replace" conserva el mismo OID de función, así que
-- las políticas existentes siguen funcionando sin tocarlas, solo que ahora
-- evalúan el cuerpo nuevo.
create or replace function is_admin() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from staff_roles where user_id = auth.uid() and role in ('founder','admin'));
$$;
revoke all on function is_admin() from public;
grant execute on function is_admin() to authenticated, anon;

-- Gate más fino que is_admin(), para uso futuro cuando se diferencie de verdad
-- support/readonly de founder/admin (no se usa en ninguna política todavía).
create or replace function has_role(p_roles text[]) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from staff_roles where user_id = auth.uid() and role = any(p_roles));
$$;
revoke all on function has_role(text[]) from public;
grant execute on function has_role(text[]) to authenticated;

-- Alta de personal — solo el founder puede llamarla (verificación explícita
-- de role='founder', no basta con is_admin(), para que un futuro 'admin' no
-- pueda auto-ascenderse a 'founder').
create or replace function add_staff_member(p_user_id uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from staff_roles where user_id = auth.uid() and role = 'founder') then
    raise exception 'Solo el founder puede añadir miembros del equipo';
  end if;
  if p_role not in ('founder','admin','support','readonly') then
    raise exception 'Rol no válido: %', p_role;
  end if;
  insert into staff_roles (user_id, role, created_by) values (p_user_id, p_role, auth.uid())
  on conflict (user_id) do update set role = excluded.role;
end;
$$;
revoke all on function add_staff_member(uuid, text) from public;
grant execute on function add_staff_member(uuid, text) to authenticated;


-- =============================================================================
-- MÓDULO 1a — Audit log (debe existir antes de cualquier "create trigger" de más abajo)
-- =============================================================================

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  table_name text not null,
  record_id text not null,
  action text not null check (action in ('insert','update','delete')),
  actor_id uuid,
  actor_role text not null check (actor_role in ('admin','client','system')),
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_table_record_idx on audit_log(table_name, record_id);
create index if not exists audit_log_created_at_idx on audit_log(created_at desc);
alter table audit_log enable row level security;
drop policy if exists "admin read audit_log" on audit_log;
create policy "admin read audit_log" on audit_log for select using (is_admin());
-- Sin política de insert/update/delete para nadie: solo escribe el trigger
-- de abajo, que corre como SECURITY DEFINER (salta RLS igual que las demás
-- funciones del sitio).

-- Función de trigger genérica y reutilizable — una sola función, muchos
-- triggers. Por qué trigger y no logging a mano dentro de cada función:
-- admin/panel.html escribe clients/interactions DIRECTAMENTE vía RLS
-- (sb.from('clients').update(...)), sin pasar por ninguna función — un
-- logging manual se saltaría justo las ediciones del panel admin, que es
-- el escenario que más preocupa aquí. El trigger dispara sobre el DML en
-- sí, venga de donde venga.
create or replace function audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role text; v_record_id text;
begin
  v_role := case when auth.uid() is null then 'system' when is_admin() then 'admin' else 'client' end;
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
-- MÓDULO 3 — Catálogo y configuración central
-- =============================================================================

create table if not exists solutions_catalog (
  solution_key text primary key,
  name text not null,
  price_eur numeric not null,
  monthly_usage_limit int,       -- null = sin tope de uso (ej. firma, truki, reservas)
  overage_rate_eur numeric,      -- coste por unidad de exceso, solo si monthly_usage_limit no es null
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table solutions_catalog enable row level security;
drop policy if exists "public read active solutions_catalog" on solutions_catalog;
create policy "public read active solutions_catalog" on solutions_catalog for select using (active = true);
drop policy if exists "admin all solutions_catalog" on solutions_catalog;
create policy "admin all solutions_catalog" on solutions_catalog for all using (is_admin()) with check (is_admin());
-- Lectura pública a propósito (sin datos personales), mismo patrón que
-- founding_spots: pago.html/la web necesitan leer precios sin pasar por una
-- Netlify Function.

-- Semilla transcrita de pago.html (CLOSED_PRICE_SOLUTIONS) y portal/dashboard.html
-- (USAGE_LIMITS) tal como estaban en el código el 18-ago-2026. REVISA estos
-- valores contra cualquier oferta de lanzamiento activa antes de confiar en
-- ellos como fuente de verdad — si algo está desactualizado aquí, corrígelo
-- con un UPDATE después de correr esta migración, no hace falta repetirla.
insert into solutions_catalog (solution_key, name, price_eur, monthly_usage_limit, overage_rate_eur) values
  ('whatsapp','IA para WhatsApp',590,1000,0.02),
  ('web-ia','IA para tu Web',350,1000,0.02),
  ('llamadas','IA para Llamadas',690,150,0.50),
  ('email-ia','IA para Correo',350,1000,0.02),
  ('reservas','Reservas y Agenda',350,null,null),
  ('firma','Firma Digital',500,null,null),
  ('ciberseguridad','Ciberseguridad Pyme',450,null,null),
  ('automatizaciones','Flujos automáticos a medida',350,null,null),
  ('truki','Facturación automática (TruKi)',580,null,null)
  on conflict (solution_key) do nothing;

create table if not exists tier_config (
  tier text primary key check (tier in ('start','basic','lite','pro')),
  name text not null,
  founder_price_eur numeric not null,
  standard_price_eur numeric not null,
  free_solutions_count int not null,
  max_maintained_solutions int not null,
  permanencia_meses int not null default 12,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table tier_config enable row level security;
drop policy if exists "public read tier_config" on tier_config;
create policy "public read tier_config" on tier_config for select using (true);
drop policy if exists "admin all tier_config" on tier_config;
create policy "admin all tier_config" on tier_config for all using (is_admin()) with check (is_admin());

insert into tier_config (tier, name, founder_price_eur, standard_price_eur, free_solutions_count, max_maintained_solutions) values
  ('start','Start™',69,89,1,2),
  ('basic','Basic™',149,169,1,2),
  ('lite','Lite™',229,279,2,3),
  ('pro','Pro™',449,549,3,6)
  on conflict (tier) do nothing;


-- =============================================================================
-- MÓDULO 1b — Pagos (payments) + confirm_client_purchase extendida
-- =============================================================================

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete set null,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  stripe_customer_id text,
  amount_total_cents int not null,
  currency text not null default 'eur',
  status text not null check (status in ('completed','refunded','partially_refunded','failed','disputed')),
  plan_key text,
  arranque_tier text,
  is_founder_price boolean not null default false,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists payments_client_id_idx on payments(client_id);
alter table payments enable row level security;
drop policy if exists "admin read payments" on payments;
create policy "admin read payments" on payments for select using (is_admin());
drop policy if exists "client read own payments" on payments;
create policy "client read own payments" on payments for select using (
  exists (select 1 from clients c where c.id = payments.client_id and c.auth_user_id = auth.uid())
);
-- Sin política de insert/update/delete: solo escribe confirm_client_purchase (abajo).


-- =============================================================================
-- MÓDULO 2 — Operativa y soporte (tasks + client_automations)
-- =============================================================================

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'open' check (status in ('open','in_progress','blocked','done','cancelled')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  assignee_id uuid references auth.users(id) on delete set null,
  due_date date,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists tasks_client_id_idx on tasks(client_id);
create index if not exists tasks_open_idx on tasks(status) where status not in ('done','cancelled');
alter table tasks enable row level security;
drop policy if exists "admin all tasks" on tasks;
create policy "admin all tasks" on tasks for all using (is_admin()) with check (is_admin());
drop policy if exists "client read own tasks" on tasks;
create policy "client read own tasks" on tasks for select using (
  exists (select 1 from clients c where c.id = tasks.client_id and c.auth_user_id = auth.uid())
);
-- Sin insert/update directo para el cliente: una petición de cambio pasa por
-- create_client_task() (abajo), así status/priority/assignee quedan siempre
-- bajo control del founder — mismo principio que "clients" sin política de
-- update para que un cliente no pueda tocar su propio status.

create or replace function tasks_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if new.status in ('done','cancelled') and old.status not in ('done','cancelled') then
    new.closed_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists tasks_touch_trg on tasks;
create trigger tasks_touch_trg before update on tasks for each row execute function tasks_touch();

create or replace function create_client_task(p_title text, p_description text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_client_id uuid; v_task_id uuid;
begin
  select id into v_client_id from clients where auth_user_id = auth.uid();
  if v_client_id is null then
    raise exception 'No hay ningún cliente vinculado a esta sesión';
  end if;
  insert into tasks (client_id, title, description, created_by)
  values (v_client_id, left(p_title, 200), left(p_description, 2000), auth.uid())
  returning id into v_task_id;
  return v_task_id;
end;
$$;
revoke all on function create_client_task(text, text) from public;
grant execute on function create_client_task(text, text) to authenticated;

create table if not exists client_automations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  solution_key text not null references solutions_catalog(solution_key),
  status text not null default 'pending' check (status in ('pending','live','paused','error')),
  last_checked_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists client_automations_client_sol_idx on client_automations(client_id, solution_key);
alter table client_automations enable row level security;
drop policy if exists "admin all client_automations" on client_automations;
create policy "admin all client_automations" on client_automations for all using (is_admin()) with check (is_admin());
drop policy if exists "client read own client_automations" on client_automations;
create policy "client read own client_automations" on client_automations for select using (
  exists (select 1 from clients c where c.id = client_automations.client_id and c.auth_user_id = auth.uid())
);


-- =============================================================================
-- confirm_client_purchase — versión final (13 argumentos):
--   9 originales (email..is_founder) + 4 nuevos de Stripe (Módulo 1) +
--   siembra automática de client_automations por cada solución comprada (Módulo 2)
-- =============================================================================

drop function if exists confirm_client_purchase(text, text, text, text, text, int, int, jsonb, boolean);
create or replace function confirm_client_purchase(
  p_email text, p_nombre text default null, p_plan_key text default null,
  p_plan_type text default null, p_arranque_tier text default null,
  p_permanencia_meses int default null, p_gift_period_days int default null,
  p_solutions jsonb default null, p_is_founder boolean default false,
  p_stripe_session_id text default null, p_stripe_payment_intent_id text default null,
  p_stripe_customer_id text default null, p_amount_total_cents int default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_client_id uuid; v_sol jsonb;
begin
  insert into clients (email, nombre, status, plan_key, plan_type, arranque_tier, permanencia_meses, gift_period_days, contract_started_at, is_founder)
  values (p_email, p_nombre, 'cliente', p_plan_key, p_plan_type, p_arranque_tier, p_permanencia_meses, p_gift_period_days, now(), p_is_founder)
  on conflict (email) do update set status='cliente', nombre=coalesce(excluded.nombre,clients.nombre),
    plan_key=excluded.plan_key, plan_type=excluded.plan_type, arranque_tier=excluded.arranque_tier,
    permanencia_meses=excluded.permanencia_meses, gift_period_days=excluded.gift_period_days,
    contract_started_at=now(), renewal_reminder_sent_at=null, updated_at=now(),
    is_founder = clients.is_founder or excluded.is_founder
  returning id into v_client_id;

  insert into interactions (client_id, source, nota)
  values (v_client_id, 'checkout', 'Pago confirmado por Stripe — plan: ' || coalesce(p_plan_key, '(sin clave)'));

  if p_solutions is not null and jsonb_typeof(p_solutions) = 'array' then
    delete from client_solutions where client_id = v_client_id; -- evita arrastrar soluciones de un tier anterior en una renovación
    delete from client_automations where client_id = v_client_id; -- idem, para no dejar estado operativo de una solución ya no contratada
    for v_sol in select * from jsonb_array_elements(p_solutions) loop
      insert into client_solutions (client_id, solution_key, solution_name, price_eur, is_free)
      values (v_client_id, v_sol->>'key', coalesce(v_sol->>'name', v_sol->>'key'),
              nullif(v_sol->>'price','')::numeric, coalesce((v_sol->>'free')::boolean, false))
      on conflict (client_id, solution_key) do nothing;

      insert into client_automations (client_id, solution_key, status)
      values (v_client_id, v_sol->>'key', 'pending')
      on conflict (client_id, solution_key) do nothing;
    end loop;
  end if;

  -- Ledger de pago (Módulo 1) — solo si el webhook manda los campos de Stripe.
  -- on conflict do nothing porque Stripe reintenta webhooks y el mismo
  -- checkout session no debe duplicar la fila del ledger.
  if p_stripe_session_id is not null and p_amount_total_cents is not null then
    insert into payments (client_id, stripe_checkout_session_id, stripe_payment_intent_id,
      stripe_customer_id, amount_total_cents, status, plan_key, arranque_tier, is_founder_price)
    values (v_client_id, p_stripe_session_id, p_stripe_payment_intent_id,
      p_stripe_customer_id, p_amount_total_cents, 'completed', p_plan_key, p_arranque_tier, p_is_founder)
    on conflict (stripe_checkout_session_id) do nothing;
  end if;

  return v_client_id;
end;
$$;
revoke all on function confirm_client_purchase(text, text, text, text, text, int, int, jsonb, boolean, text, text, text, int) from public, anon, authenticated;
grant execute on function confirm_client_purchase(text, text, text, text, text, int, int, jsonb, boolean, text, text, text, int) to service_role;


-- =============================================================================
-- clients_near_usage_limit() — reescrita para leer límites de solutions_catalog
-- en vez del "values(...)" hardcodeado (mismo comportamiento, una sola fuente
-- de verdad ahora compartida con portal/dashboard.html tras su actualización).
-- =============================================================================

drop function if exists clients_near_usage_limit(numeric);
create or replace function clients_near_usage_limit(p_threshold numeric default 0.8)
returns table(client_id uuid, nombre text, negocio text, telefono text, email text, solution_key text, used int, limit_n int, pct numeric, alert_type text)
language plpgsql security definer set search_path = public stable as $$
begin
  return query
  with usage_this_month as (
    select ue.client_id, ue.solution_key, count(*)::int as used
    from usage_events ue
    where ue.created_at >= date_trunc('month', now()) and ue.created_at < date_trunc('month', now()) + interval '1 month'
    group by ue.client_id, ue.solution_key
  )
  select c.id, c.nombre, c.negocio, c.telefono, c.email, u.solution_key, u.used, sc.monthly_usage_limit,
    round((u.used::numeric / sc.monthly_usage_limit) * 100, 1),
    case when u.used >= sc.monthly_usage_limit then 'over_limit' else 'near_limit' end
  from usage_this_month u
  join solutions_catalog sc on sc.solution_key = u.solution_key and sc.monthly_usage_limit is not null
  join clients c on c.id = u.client_id
  where (u.used::numeric / sc.monthly_usage_limit) >= p_threshold
    and not exists (
      select 1 from usage_alerts_sent a
      where a.client_id = u.client_id and a.solution_key = u.solution_key
        and a.period_start = date_trunc('month', now())::date
        and a.alert_type = (case when u.used >= sc.monthly_usage_limit then 'over_limit' else 'near_limit' end)
    );
end;
$$;
revoke all on function clients_near_usage_limit(numeric) from public, anon, authenticated;
grant execute on function clients_near_usage_limit(numeric) to service_role;


-- =============================================================================
-- MÓDULO 5 — RGPD / retención de datos
-- =============================================================================

create table if not exists data_retention_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete set null,
  requested_email text not null,
  requested_at timestamptz not null default now(),
  requested_by uuid references auth.users(id),
  status text not null default 'pending' check (status in ('pending','completed','rejected')),
  completed_at timestamptz,
  notes text
);
alter table data_retention_requests enable row level security;
drop policy if exists "admin all data_retention_requests" on data_retention_requests;
create policy "admin all data_retention_requests" on data_retention_requests for all using (is_admin()) with check (is_admin());

-- Anonimiza los datos personales de un cliente (nombre/email/teléfono/nif).
-- A propósito NO toca payments/client_solutions/client_automations: los
-- registros financieros tienen su propia base legal de conservación
-- (normativa contable española, ~4-6 años) independiente del derecho al
-- olvido de RGPD. Gate interno de is_admin(): el borrado en B2B con
-- contrato activo es una decisión deliberada del founder, no autoservicio.
create or replace function anonymize_client(p_client_id uuid, p_request_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Solo un administrador puede anonimizar un cliente';
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
grant execute on function anonymize_client(uuid, uuid) to authenticated; -- gate interno de is_admin(), mismo patrón que add_staff_member


-- =============================================================================
-- Triggers de auditoría — se añaden al final, cuando todas las tablas ya existen
-- =============================================================================

drop trigger if exists audit_clients on clients;
create trigger audit_clients after insert or update or delete on clients
  for each row execute function audit_row_change();

-- Solo update/delete en interactions: los insert son altísimo volumen (cada
-- chat/whatsapp/visita web) y el riesgo real está en editar/borrar historial,
-- no en crearlo.
drop trigger if exists audit_interactions on interactions;
create trigger audit_interactions after update or delete on interactions
  for each row execute function audit_row_change();

drop trigger if exists audit_client_solutions on client_solutions;
create trigger audit_client_solutions after insert or update or delete on client_solutions
  for each row execute function audit_row_change();

-- Solo update/delete en payments: el insert es la propia transacción, ya
-- queda completa en la fila; un update/delete posterior sí es anómalo y
-- debe quedar trazado.
drop trigger if exists audit_payments on payments;
create trigger audit_payments after update or delete on payments
  for each row execute function audit_row_change();

drop trigger if exists audit_staff_roles on staff_roles;
create trigger audit_staff_roles after insert or update or delete on staff_roles
  for each row execute function audit_row_change();

drop trigger if exists audit_tasks on tasks;
create trigger audit_tasks after insert or update or delete on tasks
  for each row execute function audit_row_change();

drop trigger if exists audit_client_automations on client_automations;
create trigger audit_client_automations after insert or update or delete on client_automations
  for each row execute function audit_row_change();

drop trigger if exists audit_solutions_catalog on solutions_catalog;
create trigger audit_solutions_catalog after insert or update or delete on solutions_catalog
  for each row execute function audit_row_change(); -- cambios de precio son justo el tipo de deriva silenciosa que esta migración existe para evitar

drop trigger if exists audit_tier_config on tier_config;
create trigger audit_tier_config after insert or update or delete on tier_config
  for each row execute function audit_row_change();

drop trigger if exists audit_data_retention_requests on data_retention_requests;
create trigger audit_data_retention_requests after insert or update or delete on data_retention_requests
  for each row execute function audit_row_change();


-- =============================================================================
-- Política final de staff_roles — única excepción al patrón "sin políticas",
-- necesaria para que el founder pueda ver la lista de equipo en admin/panel.html
-- (is_admin() ya existe en este punto, así que puede usarse aquí sin problema)
-- =============================================================================

drop policy if exists "admin read staff_roles" on staff_roles;
create policy "admin read staff_roles" on staff_roles for select using (is_admin());

-- =============================================================================
-- FIN — a partir de aquí, verificar con la prueba de humo del plan:
-- crear un cliente de prueba vía confirm_client_purchase con los nuevos
-- parámetros de pago, confirmar fila en payments + client_automations,
-- editar su status desde admin/panel.html y confirmar fila en audit_log.
-- =============================================================================
