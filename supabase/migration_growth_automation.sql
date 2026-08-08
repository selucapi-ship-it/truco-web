-- Automatizaciones de crecimiento: recuperación de checkouts abandonados,
-- aviso de uso cercano al límite (señal de upsell), programa de referidos,
-- encuesta de satisfacción con marca de riesgo de fuga, y etapa de
-- implantación visible en el portal. Ejecutar una sola vez en Supabase (SQL
-- Editor → pegar → Run). Requiere migration_client_portal.sql y
-- migration_usage_tracking.sql ya aplicadas (usa is_admin(), auth_user_id,
-- usage_events, clients_due_for_renewal).

-- ═══ 1) CHECKOUT ABANDONADO ═══
-- Alguien empezó a comprar (save-lead ya lo registra vía log_interaction con
-- source='checkout') pero nunca llegó a pagar. Dos avisos automáticos: a las
-- 2h y a las 24h de iniciado, sin repetir.

alter table clients add column if not exists abandoned_2h_sent_at timestamptz;
alter table clients add column if not exists abandoned_24h_sent_at timestamptz;

-- Cada intento de checkout nuevo reinicia el contador de avisos — así si
-- alguien vuelve a intentarlo más tarde, no se queda sin recordatorio por
-- haber ya "gastado" el de un intento anterior. Solo aplica a quien todavía
-- no es cliente (un cliente comprando una solución más no necesita esto).
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

  if p_source = 'checkout' and v_client_id is not null then
    update clients set abandoned_2h_sent_at = null, abandoned_24h_sent_at = null
    where id = v_client_id and status <> 'cliente';
  end if;

  return v_client_id;
end;
$$;

-- Llamada por otros/n8n-truco/checkout-abandonado.json cada hora. p_stage
-- '2h' devuelve intentos de entre 2 y 24h sin avisar; '24h' devuelve los de
-- entre 24 y 72h — pasado ese margen, ya no tiene sentido insistir.
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
  where c.status <> 'cliente'
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

create or replace function mark_abandoned_reminder_sent(p_client_id uuid, p_stage text)
returns void
language sql
security definer
set search_path = public
as $$
  update clients set
    abandoned_2h_sent_at = case when p_stage = '2h' then now() else abandoned_2h_sent_at end,
    abandoned_24h_sent_at = case when p_stage = '24h' then now() else abandoned_24h_sent_at end
  where id = p_client_id;
$$;
revoke all on function mark_abandoned_reminder_sent from public, anon, authenticated;
grant execute on function mark_abandoned_reminder_sent to service_role;

-- ═══ 2) AVISO DE USO CERCANO AL LÍMITE (señal de upsell, no solo aviso) ═══
create table if not exists usage_alerts_sent (
  client_id uuid not null references clients(id) on delete cascade,
  solution_key text not null,
  period_start date not null,
  alert_type text not null check (alert_type in ('near_limit', 'over_limit')),
  sent_at timestamptz not null default now(),
  primary key (client_id, solution_key, period_start, alert_type)
);
alter table usage_alerts_sent enable row level security;
create policy "admin read usage_alerts_sent" on usage_alerts_sent for select using (is_admin());

-- p_threshold 0.8 = avisa desde el 80% de uso. Distingue near_limit (80-99%)
-- de over_limit (100%+, ya se le va a cobrar el exceso) para que el mensaje
-- al cliente y la oportunidad de upsell al founder sean distintos.
create or replace function clients_near_usage_limit(p_threshold numeric default 0.8)
returns table(
  client_id uuid, nombre text, negocio text, telefono text, email text,
  solution_key text, used int, limit_n int, pct numeric, alert_type text
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_period date := date_trunc('month', now())::date;
begin
  return query
  with limits(solution_key, limit_n) as (
    values ('whatsapp', 1000), ('web-ia', 1000), ('email-ia', 1000), ('llamadas', 150)
  ),
  usage_this_month as (
    select ue.client_id, ue.solution_key, count(*)::int as used
    from usage_events ue
    where ue.created_at >= date_trunc('month', now())
      and ue.created_at < date_trunc('month', now()) + interval '1 month'
    group by ue.client_id, ue.solution_key
  )
  select c.id, c.nombre, c.negocio, c.telefono, c.email, u.solution_key, u.used, l.limit_n,
    round((u.used::numeric / l.limit_n) * 100, 1),
    case when u.used >= l.limit_n then 'over_limit' else 'near_limit' end
  from usage_this_month u
  join limits l on l.solution_key = u.solution_key
  join clients c on c.id = u.client_id
  where (u.used::numeric / l.limit_n) >= p_threshold
    and not exists (
      select 1 from usage_alerts_sent a
      where a.client_id = u.client_id and a.solution_key = u.solution_key
        and a.period_start = v_period
        and a.alert_type = (case when u.used >= l.limit_n then 'over_limit' else 'near_limit' end)
    );
end;
$$;
revoke all on function clients_near_usage_limit from public, anon, authenticated;
grant execute on function clients_near_usage_limit to service_role;

create or replace function mark_usage_alert_sent(p_client_id uuid, p_solution_key text, p_alert_type text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into usage_alerts_sent (client_id, solution_key, period_start, alert_type)
  values (p_client_id, p_solution_key, date_trunc('month', now())::date, p_alert_type)
  on conflict (client_id, solution_key, period_start, alert_type) do nothing;
$$;
revoke all on function mark_usage_alert_sent from public, anon, authenticated;
grant execute on function mark_usage_alert_sent to service_role;

-- ═══ 3) RESUMEN SEMANAL PARA EL FOUNDER ═══
-- Un único RPC que agrega lo que de verdad importa mirar cada semana — así
-- el flujo de n8n solo necesita un nodo HTTP, no cinco.
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
        and client_id in (select id from clients where status <> 'cliente')
    )
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function founder_weekly_digest from public, anon, authenticated;
grant execute on function founder_weekly_digest to service_role;

-- ═══ 4) PROGRAMA DE REFERIDOS ═══
-- Cada cliente tiene un código propio (generado solo, sin que nadie tenga
-- que pedirlo) y un contador de créditos. Quien compra con un código válido
-- de otro cliente se lleva un descuento en pago.html; cuando su compra se
-- confirma, quien le refirió gana 1 crédito, canjeable como descuento en su
-- siguiente compra (nunca dinero real que mover, todo vía el propio
-- descuento — más simple y sin riesgo de reembolsos).
alter table clients add column if not exists referral_code text unique
  default upper(substr(md5(random()::text || clock_timestamp()::text), 1, 7));
alter table clients add column if not exists referral_credits int not null default 0;

update clients set referral_code = upper(substr(md5(random()::text || clock_timestamp()::text || id::text), 1, 7))
where referral_code is null;

-- Público a propósito: solo confirma si un código existe (true/false), nunca
-- devuelve datos del cliente al que pertenece.
create or replace function validate_referral_code(p_code text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists(select 1 from clients where referral_code = upper(p_code));
$$;
revoke all on function validate_referral_code from public;
grant execute on function validate_referral_code to anon, authenticated;

-- Llamada por stripe-webhook.js tras confirmar un pago que incluía un código
-- de referido válido en su metadata.
create or replace function reward_referral(p_ref_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referrer_id uuid;
begin
  select id into v_referrer_id from clients where referral_code = upper(p_ref_code);
  if v_referrer_id is not null then
    update clients set referral_credits = referral_credits + 1 where id = v_referrer_id;
    insert into interactions (client_id, source, nota)
    values (v_referrer_id, 'checkout', 'Referido convertido en cliente — +1 crédito de descuento (código ' || upper(p_ref_code) || ')');
  end if;
end;
$$;
revoke all on function reward_referral from public, anon, authenticated;
grant execute on function reward_referral to service_role;

create or replace function consume_referral_credit(p_client_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update clients set referral_credits = greatest(referral_credits - 1, 0) where id = p_client_id;
$$;
revoke all on function consume_referral_credit from public, anon, authenticated;
grant execute on function consume_referral_credit to service_role;

-- ═══ 5) ENCUESTA DE SATISFACCIÓN → RIESGO DE FUGA ═══
alter table clients add column if not exists churn_risk boolean not null default false;

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
create policy "admin read satisfaction_surveys" on satisfaction_surveys for select using (is_admin());

-- 14 días desde el alta es el margen para haber probado ya lo contratado.
-- Se manda una sola vez por contrato (no repite si ya existe una fila).
create or replace function clients_due_for_satisfaction_survey()
returns table(id uuid, nombre text, telefono text, email text, negocio text)
language sql
security definer
set search_path = public
stable
as $$
  select c.id, c.nombre, c.telefono, c.email, c.negocio
  from clients c
  where c.status = 'cliente'
    and c.contract_started_at is not null
    and c.contract_started_at <= now() - interval '14 days'
    and not exists (select 1 from satisfaction_surveys s where s.client_id = c.id);
$$;
revoke all on function clients_due_for_satisfaction_survey from public, anon, authenticated;
grant execute on function clients_due_for_satisfaction_survey to service_role;

create or replace function mark_satisfaction_survey_sent(p_client_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into satisfaction_surveys (client_id) values (p_client_id);
$$;
revoke all on function mark_satisfaction_survey_sent from public, anon, authenticated;
grant execute on function mark_satisfaction_survey_sent to service_role;

-- Llamada por el flujo de recepción de respuesta (matchea por teléfono,
-- igual que whatsapp_recent_history). Nota ≤3 marca riesgo de fuga
-- automáticamente, visible como badge en admin/panel.html.
create or replace function log_satisfaction_response(p_telefono text, p_score int, p_comentario text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
  v_survey_id uuid;
begin
  select id into v_client_id from clients where telefono = p_telefono limit 1;
  if v_client_id is null then
    return;
  end if;

  select id into v_survey_id from satisfaction_surveys
  where client_id = v_client_id and responded_at is null
  order by sent_at desc limit 1;
  if v_survey_id is null then
    return;
  end if;

  update satisfaction_surveys set responded_at = now(), score = p_score, comentario = p_comentario
  where id = v_survey_id;

  if p_score <= 3 then
    update clients set churn_risk = true where id = v_client_id;
    insert into interactions (client_id, source, nota)
    values (v_client_id, 'whatsapp', 'Encuesta de satisfacción: ' || p_score || '/5 — marcado como riesgo de fuga.' || coalesce(' Comentario: ' || p_comentario, ''));
  else
    insert into interactions (client_id, source, nota)
    values (v_client_id, 'whatsapp', 'Encuesta de satisfacción: ' || p_score || '/5.' || coalesce(' Comentario: ' || p_comentario, ''));
  end if;
end;
$$;
revoke all on function log_satisfaction_response from public, anon, authenticated;
grant execute on function log_satisfaction_response to service_role;

-- ═══ 6) ETAPA DE IMPLANTACIÓN VISIBLE EN EL PORTAL ═══
-- El founder la actualiza a mano desde admin/panel.html (mismo desplegable
-- que ya existe para status) — no hay forma de inferirla automáticamente sin
-- datos que hoy no se registran, así que es la única pieza de este archivo
-- que no es 100% automática. El cliente la ve como checklist en su portal.
alter table clients add column if not exists implementation_stage text not null default 'contratado';
alter table clients drop constraint if exists clients_implementation_stage_check;
alter table clients add constraint clients_implementation_stage_check
  check (implementation_stage in ('contratado', 'en_implantacion', 'revision', 'completado'));
