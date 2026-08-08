-- Contador de uso real para las soluciones con límite mensual incluido
-- (IA WhatsApp, IA Web, IA Correo: 1.000 interacciones/mes, exceso 0,02€ —
-- IA Llamadas: 150 llamadas/mes, exceso 0,50€ — mismos límites documentados
-- en pago.html/chat-ai.js/agent.py/terminos.html, no se inventan aquí).
-- Ejecutar una sola vez en Supabase (SQL Editor → pegar → Run). Requiere
-- migration_client_portal.sql ya aplicada (usa is_admin() y clients.auth_user_id).

create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  solution_key text not null check (solution_key in ('whatsapp','web-ia','email-ia','llamadas')),
  created_at timestamptz not null default now()
);
create index if not exists usage_events_client_period_idx on usage_events(client_id, solution_key, created_at);
alter table usage_events enable row level security;
create policy "admin read usage_events" on usage_events for select using (is_admin());
-- A propósito sin policy de cliente: un cliente nunca lee esta tabla en
-- crudo, solo a través de portal_usage_summary() (más abajo), que agrega y
-- nunca expone eventos individuales de otro cliente.

-- Registra un evento de uso. La llama netlify/functions/log-usage.js, que a
-- su vez la llama cada integración de IA ya desplegada para un cliente
-- concreto (su propio WhatsApp Business, su web, su correo o su línea de
-- llamadas) cada vez que la IA resuelve una interacción — un evento = una
-- interacción que cuenta para su límite mensual.
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

-- Lee el uso del propio cliente, del mes natural en curso — un cliente logueado
-- puede llamarla directamente (no necesita pasar por una Netlify Function),
-- porque internamente se limita sola a auth.uid(): nunca puede pedir el
-- uso de otro cliente, no hay ningún client_id que el navegador controle.
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
