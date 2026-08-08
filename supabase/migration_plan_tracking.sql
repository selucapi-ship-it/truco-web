-- Migración incremental: añade seguimiento de plan/permanencia a los clientes,
-- para poder automatizar la alta y el aviso de renovación con n8n.
-- Ejecutar una sola vez en Supabase (SQL Editor → pegar → Run).
-- (Requiere schema.sql y migration_delete_and_notes.sql ya aplicados antes.)

alter table clients add column if not exists plan_key text;
alter table clients add column if not exists plan_type text;
alter table clients add column if not exists arranque_tier text;
alter table clients add column if not exists permanencia_meses int;
alter table clients add column if not exists gift_period_days int;
alter table clients add column if not exists contract_started_at timestamptz;
alter table clients add column if not exists renewal_reminder_sent_at timestamptz;

alter table clients drop constraint if exists clients_plan_type_check;
alter table clients add constraint clients_plan_type_check
  check (plan_type is null or plan_type in ('arranque','proyecto'));

alter table clients drop constraint if exists clients_arranque_tier_check;
alter table clients add constraint clients_arranque_tier_check
  check (arranque_tier is null or arranque_tier in ('basic','lite','pro'));

-- Llamada por netlify/functions/stripe-webhook.js cuando Stripe confirma un
-- pago: pasa el lead de 'nuevo'/'contactado' a 'cliente' con los datos del
-- plan que compró. Reinicia el aviso de renovación (por si es una renovación,
-- no un alta) para que vuelva a contar desde el nuevo contract_started_at.
create or replace function confirm_client_purchase(
  p_email text,
  p_nombre text default null,
  p_plan_key text default null,
  p_plan_type text default null,
  p_arranque_tier text default null,
  p_permanencia_meses int default null,
  p_gift_period_days int default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
begin
  insert into clients (email, nombre, status, plan_key, plan_type, arranque_tier, permanencia_meses, gift_period_days, contract_started_at)
  values (p_email, p_nombre, 'cliente', p_plan_key, p_plan_type, p_arranque_tier, p_permanencia_meses, p_gift_period_days, now())
  on conflict (email) do update set
    status = 'cliente',
    nombre = coalesce(excluded.nombre, clients.nombre),
    plan_key = excluded.plan_key,
    plan_type = excluded.plan_type,
    arranque_tier = excluded.arranque_tier,
    permanencia_meses = excluded.permanencia_meses,
    gift_period_days = excluded.gift_period_days,
    contract_started_at = now(),
    renewal_reminder_sent_at = null,
    updated_at = now()
  returning id into v_client_id;

  insert into interactions (client_id, source, nota)
  values (v_client_id, 'checkout', 'Pago confirmado por Stripe — plan: ' || coalesce(p_plan_key, '(sin clave)'));

  return v_client_id;
end;
$$;

revoke all on function confirm_client_purchase from public, anon, authenticated;
grant execute on function confirm_client_purchase to service_role;

-- Llamada por el flujo n8n "aviso-renovacion": devuelve los clientes cuya
-- permanencia (o periodo de regalo) termina dentro de p_days_before días y
-- todavía no se les ha avisado de esta renovación.
create or replace function clients_due_for_renewal(p_days_before int default 14)
returns table(
  id uuid, nombre text, email text, telefono text, negocio text,
  plan_key text, arranque_tier text, renewal_date date
)
language sql
security definer
set search_path = public
stable
as $$
  select
    c.id, c.nombre, c.email, c.telefono, c.negocio, c.plan_key, c.arranque_tier,
    (c.contract_started_at
      + (coalesce(c.permanencia_meses, 0) || ' months')::interval
      + (coalesce(c.gift_period_days, 0) || ' days')::interval
    )::date as renewal_date
  from clients c
  where c.status = 'cliente'
    and c.contract_started_at is not null
    and (c.permanencia_meses is not null or c.gift_period_days is not null)
    and c.renewal_reminder_sent_at is null
    and (c.contract_started_at
          + (coalesce(c.permanencia_meses, 0) || ' months')::interval
          + (coalesce(c.gift_period_days, 0) || ' days')::interval
        )::date <= (current_date + (p_days_before || ' days')::interval)::date;
$$;

revoke all on function clients_due_for_renewal from public, anon, authenticated;
grant execute on function clients_due_for_renewal to service_role;

-- Llamada por el mismo flujo n8n justo después de mandar el aviso, para no
-- repetirlo cada día mientras dure la ventana de p_days_before.
create or replace function mark_renewal_reminder_sent(p_client_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update clients set renewal_reminder_sent_at = now(), updated_at = now()
  where id = p_client_id;
$$;

revoke all on function mark_renewal_reminder_sent from public, anon, authenticated;
grant execute on function mark_renewal_reminder_sent to service_role;

-- Permite que interactions.source acepte 'whatsapp' (canal nuevo — el
-- asistente de WhatsApp propio de TRUCO, ver otros/n8n-truco/whatsapp-truco.json).
alter table interactions drop constraint if exists interactions_source_check;
alter table interactions add constraint interactions_source_check
  check (source in ('checkout','chat','voice','whatsapp','manual'));

-- log_interaction solo sabía identificar/crear un cliente por email. El
-- asistente de WhatsApp no tiene email, solo teléfono — sin esto, cada
-- mensaje de un mismo número quedaba como una interacción huérfana
-- (client_id null) en vez de acumularse en la ficha del mismo cliente.
-- Mantiene el comportamiento anterior tal cual cuando SÍ hay email.
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
  elsif p_telefono is not null and p_telefono <> '' then
    select id into v_client_id from clients where telefono = p_telefono limit 1;

    if v_client_id is null then
      insert into clients (nombre, telefono, negocio, tipo, nif)
      values (p_nombre, p_telefono, p_negocio, p_tipo, p_nif)
      returning id into v_client_id;
    else
      update clients set
        nombre = coalesce(p_nombre, nombre),
        negocio = coalesce(p_negocio, negocio),
        tipo = coalesce(p_tipo, tipo),
        nif = coalesce(p_nif, nif),
        updated_at = now()
      where id = v_client_id;
    end if;

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

-- Llamada por otros/n8n-truco/whatsapp-truco.json antes de responder: trae
-- las últimas interacciones del mismo teléfono para que la IA recuerde la
-- conversación en vez de responder cada mensaje como si fuera el primero.
create or replace function whatsapp_recent_history(p_telefono text, p_limit int default 6)
returns table(nota text, source text, created_at timestamptz)
language sql
security definer
set search_path = public
stable
as $$
  select i.nota, i.source, i.created_at
  from interactions i
  join clients c on c.id = i.client_id
  where c.telefono = p_telefono
    and i.nota is not null
  order by i.created_at desc
  limit p_limit;
$$;

revoke all on function whatsapp_recent_history from public, anon, authenticated;
grant execute on function whatsapp_recent_history to service_role;
