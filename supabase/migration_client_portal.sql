-- Portal de clientes TRUCO: distingue founder (admin) de clientes reales,
-- da a cada cliente una fila propia y solo esa (RLS), y guarda qué soluciones
-- concretas tiene cada uno. Ejecutar una sola vez en Supabase (SQL Editor →
-- pegar → Run). Requiere schema.sql y migration_plan_tracking.sql ya aplicados.

create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table admins enable row level security;
-- Sin policies a propósito: nadie puede leer/escribir esta tabla vía la API
-- REST directamente (RLS habilitada + cero policies = inaccesible). Solo
-- is_admin() la lee, porque al ser security definer se ejecuta como el
-- propietario de la tabla y por tanto ignora RLS.

create or replace function is_admin() returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;
revoke all on function is_admin from public;
grant execute on function is_admin to authenticated, anon;

-- Alta manual del founder — una sola vez, a mano:
-- 1. Supabase Dashboard → Authentication → Users → busca tu email → copia el "User UID".
-- 2. insert into admins (user_id) values ('REEMPLAZA_TU_USER_ID');

alter table clients add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;

-- Reescribe TODAS las políticas existentes de auth.role()='authenticated' a
-- is_admin(). Es obligatorio hacerlo en la misma migración que introduce
-- logins de cliente: cualquier usuario autenticado (founder Y cliente) es
-- "authenticated" para Supabase — sin este cambio, el primer cliente real
-- heredaría permiso para ver y tocar los datos de todos los demás.
drop policy if exists "authenticated read clients" on clients;
drop policy if exists "authenticated update clients" on clients;
drop policy if exists "authenticated delete clients" on clients;
drop policy if exists "authenticated read interactions" on interactions;
drop policy if exists "authenticated insert manual interactions" on interactions;
drop policy if exists "authenticated delete interactions" on interactions;

create policy "admin read clients" on clients for select using (is_admin());
create policy "admin update clients" on clients for update using (is_admin()) with check (is_admin());
create policy "admin delete clients" on clients for delete using (is_admin());
create policy "admin read interactions" on interactions for select using (is_admin());
create policy "admin insert manual interactions" on interactions for insert with check (is_admin() and source = 'manual');
create policy "admin delete interactions" on interactions for delete using (is_admin());

-- Un cliente solo puede leer su propia fila. A propósito SIN política de
-- UPDATE: si la hubiera, un cliente podría reescribir su propio status/
-- plan_key/arranque_tier, o peor, su propio auth_user_id para intentar
-- apropiarse de la ficha de otro cliente. Cualquier edición futura (nombre,
-- teléfono) debe ir por una función security definer con columnas fijas,
-- nunca por una policy de UPDATE directa.
create policy "client read own row" on clients for select using (auth_user_id = auth.uid());

-- Un cliente solo puede leer sus propias interacciones, y solo las que vienen
-- del propio portal. interactions también guarda notas manuales privadas del
-- founder y trazas de otros canales (checkout/chat/voice/whatsapp) — sin el
-- filtro source='portal', cualquier cliente vería las notas internas que el
-- founder ha escrito sobre él.
create policy "client read own portal interactions" on interactions for select using (
  source = 'portal' and exists (select 1 from clients c where c.id = interactions.client_id and c.auth_user_id = auth.uid())
);

-- Nunca se había guardado qué soluciones concretas eligió cada cliente dentro
-- de su plan gratis (confirm_client_purchase solo guardaba el plan/tier).
create table if not exists client_solutions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  solution_key text not null,
  solution_name text not null,
  price_eur numeric,
  is_free boolean not null default false,
  added_at timestamptz not null default now()
);
create index if not exists client_solutions_client_id_idx on client_solutions(client_id);
create unique index if not exists client_solutions_client_key_idx on client_solutions(client_id, solution_key);
alter table client_solutions enable row level security;
create policy "admin all client_solutions" on client_solutions for all using (is_admin()) with check (is_admin());
create policy "client read own client_solutions" on client_solutions for select using (
  exists (select 1 from clients c where c.id = client_solutions.client_id and c.auth_user_id = auth.uid())
);

alter table interactions drop constraint if exists interactions_source_check;
alter table interactions add constraint interactions_source_check
  check (source in ('checkout','chat','voice','whatsapp','portal','manual'));

-- Añade p_solutions a confirm_client_purchase (llamada desde
-- netlify/functions/stripe-webhook.js tras un pago confirmado): guarda qué
-- soluciones concretas tiene el cliente, sustituyendo las anteriores en una
-- renovación/cambio de tier (para que no se arrastren soluciones de un plan
-- viejo que ya no aplica).
create or replace function confirm_client_purchase(
  p_email text, p_nombre text default null, p_plan_key text default null,
  p_plan_type text default null, p_arranque_tier text default null,
  p_permanencia_meses int default null, p_gift_period_days int default null,
  p_solutions jsonb default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_client_id uuid; v_sol jsonb;
begin
  insert into clients (email, nombre, status, plan_key, plan_type, arranque_tier, permanencia_meses, gift_period_days, contract_started_at)
  values (p_email, p_nombre, 'cliente', p_plan_key, p_plan_type, p_arranque_tier, p_permanencia_meses, p_gift_period_days, now())
  on conflict (email) do update set status='cliente', nombre=coalesce(excluded.nombre,clients.nombre),
    plan_key=excluded.plan_key, plan_type=excluded.plan_type, arranque_tier=excluded.arranque_tier,
    permanencia_meses=excluded.permanencia_meses, gift_period_days=excluded.gift_period_days,
    contract_started_at=now(), renewal_reminder_sent_at=null, updated_at=now()
  returning id into v_client_id;

  insert into interactions (client_id, source, nota)
  values (v_client_id, 'checkout', 'Pago confirmado por Stripe — plan: ' || coalesce(p_plan_key, '(sin clave)'));

  if p_solutions is not null and jsonb_typeof(p_solutions) = 'array' then
    delete from client_solutions where client_id = v_client_id; -- evita arrastrar soluciones de un tier anterior en una renovación
    for v_sol in select * from jsonb_array_elements(p_solutions) loop
      insert into client_solutions (client_id, solution_key, solution_name, price_eur, is_free)
      values (v_client_id, v_sol->>'key', coalesce(v_sol->>'name', v_sol->>'key'),
              nullif(v_sol->>'price','')::numeric, coalesce((v_sol->>'free')::boolean, false))
      on conflict (client_id, solution_key) do nothing;
    end loop;
  end if;
  return v_client_id;
end;
$$;
revoke all on function confirm_client_purchase from public, anon, authenticated;
grant execute on function confirm_client_purchase to service_role;
