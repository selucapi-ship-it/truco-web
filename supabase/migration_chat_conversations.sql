-- MIGRACIÓN — conversaciones completas del chat de la web + control de abuso.
--
-- Qué añade:
--   1. chat_sessions / chat_messages: cada conversación con su nombre, su IP
--      y TODO lo que se preguntó y se contestó (antes solo se guardaba la
--      pregunta suelta en `interactions`).
--   2. blocked_ips: IPs bloqueadas desde el panel. Se hace cumplir en el
--      servidor (chat-ai.js), así que un bloqueado no gasta créditos de Gemini.
--   3. Contadores de abuso: rachas de preguntas fuera de tema / intentos de
--      manipular a la IA, límite diario por IP y límite global de seguridad.
--   4. Aviso por IPs "parecidas" (misma red /24 en IPv4, /64 en IPv6) a una ya
--      bloqueada.
--
-- Privacidad: la IP es dato personal. Se borra sola a los 90 días (salvo las
-- de IPs bloqueadas) y hay que citarlo en privacidad.html.
--
-- Todo lo que escribe pasa por funciones security definer que solo puede
-- ejecutar la service_role (las Netlify Functions). El navegador (anon) no
-- puede leer ni escribir nada; el panel (founder) solo lee y borra.
-- Idempotente.
-- =============================================================================

-- ── helpers de IP ───────────────────────────────────────────────────────────
create or replace function chat_norm_ip(p_ip text) returns text
language plpgsql immutable as $$
begin
  return host(p_ip::inet);
exception when others then
  return nullif(left(trim(coalesce(p_ip, '')), 64), '');
end;
$$;

create or replace function chat_ip_net(p_ip text) returns text
language plpgsql immutable as $$
declare i inet;
begin
  i := p_ip::inet;
  if family(i) = 4 then
    return network(set_masklen(i, 24))::text;
  end if;
  return network(set_masklen(i, 64))::text;
exception when others then
  return null;
end;
$$;

-- ── tablas ──────────────────────────────────────────────────────────────────
create table if not exists chat_sessions (
  session_id text primary key,
  nombre text,
  ip text,
  ip_net text,
  user_agent text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  msg_count int not null default 0,
  ai_calls int not null default 0,
  strikes int not null default 0,
  offtopic_total int not null default 0,
  manipulation_total int not null default 0,
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_reason text,
  closed_at timestamptz,
  similar_to_blocked boolean not null default false,
  alerted_close boolean not null default false,
  alerted_similar boolean not null default false,
  legacy boolean not null default false
);
create index if not exists chat_sessions_last_seen_idx on chat_sessions (last_seen desc);
create index if not exists chat_sessions_ip_idx on chat_sessions (ip);
create index if not exists chat_sessions_ip_net_idx on chat_sessions (ip_net);

create table if not exists chat_messages (
  id bigserial primary key,
  session_id text not null references chat_sessions(session_id) on delete cascade,
  role text not null check (role in ('user', 'bot')),
  text text not null,
  via text,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_session_idx on chat_messages (session_id, id);

create table if not exists blocked_ips (
  ip text primary key,
  ip_net text,
  reason text,
  blocked_at timestamptz not null default now(),
  blocked_by uuid
);
create index if not exists blocked_ips_net_idx on blocked_ips (ip_net);

create or replace function blocked_ips_before_insert() returns trigger
language plpgsql as $$
begin
  new.ip := chat_norm_ip(new.ip);
  new.ip_net := chat_ip_net(new.ip);
  new.blocked_by := coalesce(new.blocked_by, auth.uid());
  return new;
end;
$$;
drop trigger if exists blocked_ips_before_insert on blocked_ips;
create trigger blocked_ips_before_insert before insert on blocked_ips
  for each row execute function blocked_ips_before_insert();

create table if not exists chat_ip_usage (
  ip text not null,
  usage_date date not null default current_date,
  request_count int not null default 0,
  primary key (ip, usage_date)
);
create table if not exists chat_global_usage (
  usage_date date primary key default current_date,
  request_count int not null default 0,
  alerted boolean not null default false
);

-- ── RLS: nadie del navegador; el founder del panel lee y borra ──────────────
alter table chat_sessions enable row level security;
alter table chat_messages enable row level security;
alter table blocked_ips enable row level security;
alter table chat_ip_usage enable row level security;
alter table chat_global_usage enable row level security;

drop policy if exists "founder read chat_sessions" on chat_sessions;
create policy "founder read chat_sessions" on chat_sessions for select using (is_founder());
drop policy if exists "founder delete chat_sessions" on chat_sessions;
create policy "founder delete chat_sessions" on chat_sessions for delete using (is_founder());

drop policy if exists "founder read chat_messages" on chat_messages;
create policy "founder read chat_messages" on chat_messages for select using (is_founder());
drop policy if exists "founder delete chat_messages" on chat_messages;
create policy "founder delete chat_messages" on chat_messages for delete using (is_founder());

drop policy if exists "founder read blocked_ips" on blocked_ips;
create policy "founder read blocked_ips" on blocked_ips for select using (is_founder());
drop policy if exists "founder insert blocked_ips" on blocked_ips;
create policy "founder insert blocked_ips" on blocked_ips for insert with check (is_founder());
drop policy if exists "founder delete blocked_ips" on blocked_ips;
create policy "founder delete blocked_ips" on blocked_ips for delete using (is_founder());

-- ── limpieza: IPs a los 90 días, conversaciones a los 180 ───────────────────
create or replace function chat_purge_old() returns void
language plpgsql security definer set search_path = public as $$
begin
  update chat_sessions s
     set ip = null, ip_net = null
   where s.last_seen < now() - interval '90 days'
     and s.ip is not null
     and not exists (select 1 from blocked_ips b where b.ip = s.ip);
  delete from chat_sessions where last_seen < now() - interval '180 days';
  delete from chat_ip_usage where usage_date < current_date - 3;
  delete from chat_global_usage where usage_date < current_date - 30;
end;
$$;
revoke all on function chat_purge_old() from public, anon, authenticated;
grant execute on function chat_purge_old() to service_role;

-- ── toca la sesión, mira si la IP está bloqueada o es parecida ──────────────
create or replace function chat_touch_session(p_session text, p_ip text, p_ua text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session text := left(coalesce(nullif(trim(p_session), ''), 'sin_sesion'), 100);
  v_ip text := chat_norm_ip(p_ip);
  v_net text := chat_ip_net(v_ip);
  v_blocked boolean := false;
  v_similar boolean := false;
  v_alert_similar boolean := false;
  v_already boolean;
begin
  insert into chat_sessions (session_id, ip, ip_net, user_agent)
  values (v_session, v_ip, v_net, left(p_ua, 300))
  on conflict (session_id) do update
    set ip = coalesce(excluded.ip, chat_sessions.ip),
        ip_net = coalesce(excluded.ip_net, chat_sessions.ip_net),
        user_agent = coalesce(excluded.user_agent, chat_sessions.user_agent),
        last_seen = now();

  if v_ip is not null then
    select exists (select 1 from blocked_ips where ip = v_ip) into v_blocked;
    if not v_blocked and v_net is not null then
      select exists (select 1 from blocked_ips where ip_net = v_net) into v_similar;
    end if;
  end if;

  if v_similar then
    select alerted_similar into v_already from chat_sessions where session_id = v_session;
    if not coalesce(v_already, false) then
      v_alert_similar := true;
      update chat_sessions set alerted_similar = true where session_id = v_session;
    end if;
    update chat_sessions set similar_to_blocked = true where session_id = v_session;
  end if;

  return jsonb_build_object('blocked', v_blocked, 'similar', v_similar, 'alert_similar', v_alert_similar, 'ip', v_ip);
end;
$$;
revoke all on function chat_touch_session(text, text, text) from public, anon, authenticated;
grant execute on function chat_touch_session(text, text, text) to service_role;

-- ── puerta de entrada de cada llamada a la IA ───────────────────────────────
create or replace function chat_gate(
  p_session text, p_ip text, p_ua text,
  p_session_limit int default 15, p_ip_limit int default 40, p_global_limit int default 1500
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session text := left(coalesce(nullif(trim(p_session), ''), 'sin_sesion'), 100);
  v_ip text := chat_norm_ip(p_ip);
  v_touch jsonb;
  v_sess chat_sessions%rowtype;
  v_count int;
  v_ip_count int := 0;
  v_global int;
  v_alert_global boolean := false;
  v_global_alerted boolean;
begin
  v_touch := chat_touch_session(v_session, p_ip, p_ua);

  if (v_touch ->> 'blocked')::boolean then
    return jsonb_build_object('allowed', false, 'reason', 'blocked', 'alert_similar', false);
  end if;

  select * into v_sess from chat_sessions where session_id = v_session;

  if v_sess.status = 'closed' then
    if v_sess.closed_at is not null and v_sess.closed_at > now() - interval '24 hours' then
      return jsonb_build_object('allowed', false, 'reason', 'closed', 'alert_similar', (v_touch ->> 'alert_similar')::boolean);
    end if;
    update chat_sessions
       set status = 'open', strikes = 0, offtopic_total = 0, manipulation_total = 0,
           closed_reason = null, closed_at = null, alerted_close = false
     where session_id = v_session;
  end if;

  insert into chat_ai_usage (session_id, usage_date, request_count)
  values (v_session, current_date, 1)
  on conflict (session_id, usage_date)
  do update set request_count = chat_ai_usage.request_count + 1, updated_at = now()
  returning request_count into v_count;

  if v_ip is not null then
    insert into chat_ip_usage (ip, usage_date, request_count)
    values (v_ip, current_date, 1)
    on conflict (ip, usage_date) do update set request_count = chat_ip_usage.request_count + 1
    returning request_count into v_ip_count;
  end if;

  insert into chat_global_usage (usage_date, request_count)
  values (current_date, 1)
  on conflict (usage_date) do update set request_count = chat_global_usage.request_count + 1
  returning request_count, alerted into v_global, v_global_alerted;

  if v_global >= ceil(p_global_limit * 0.8) and not v_global_alerted then
    v_alert_global := true;
    update chat_global_usage set alerted = true where usage_date = current_date;
  end if;

  update chat_sessions set ai_calls = ai_calls + 1 where session_id = v_session;

  if v_count > p_session_limit or v_ip_count > p_ip_limit or v_global > p_global_limit then
    return jsonb_build_object(
      'allowed', false, 'reason', 'rate_limited',
      'alert_similar', (v_touch ->> 'alert_similar')::boolean,
      'alert_global', v_alert_global
    );
  end if;

  return jsonb_build_object(
    'allowed', true,
    'alert_similar', (v_touch ->> 'alert_similar')::boolean,
    'alert_global', v_alert_global,
    'ip', v_ip
  );
end;
$$;
revoke all on function chat_gate(text, text, text, int, int, int) from public, anon, authenticated;
grant execute on function chat_gate(text, text, text, int, int, int) to service_role;

-- ── puerta ligera para el chat de las webs de clientes (client-web-widget-chat)
-- Mismas IPs bloqueadas y un tope diario por IP (con su propio contador, para
-- que el tráfico de un cliente no gaste el cupo del chat de TRUCO).
create or replace function chat_ip_gate(p_ip text, p_limit int default 150)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_ip text := chat_norm_ip(p_ip);
  v_count int;
begin
  if v_ip is null then return jsonb_build_object('allowed', true); end if;
  if exists (select 1 from blocked_ips where ip = v_ip) then
    return jsonb_build_object('allowed', false, 'reason', 'blocked');
  end if;
  insert into chat_ip_usage (ip, usage_date, request_count)
  values ('webia:' || v_ip, current_date, 1)
  on conflict (ip, usage_date) do update set request_count = chat_ip_usage.request_count + 1
  returning request_count into v_count;
  if v_count > p_limit then
    return jsonb_build_object('allowed', false, 'reason', 'rate_limited');
  end if;
  return jsonb_build_object('allowed', true);
end;
$$;
revoke all on function chat_ip_gate(text, int) from public, anon, authenticated;
grant execute on function chat_ip_gate(text, int) to service_role;

-- ── resultado de cada respuesta de la IA: rachas, aviso y cierre ────────────
-- p_kind: 'ok' | 'off_topic' | 'manipulation'
-- Reglas: fuera de tema suma 1, intento de manipular suma 2; una respuesta
-- normal pone la racha a 0. Aviso al cruzar 3. Cierre a 6 seguidos, o a 10
-- fuera de tema en total, o a 3 intentos de manipulación en total.
create or replace function chat_register_outcome(p_session text, p_kind text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session text := left(coalesce(nullif(trim(p_session), ''), 'sin_sesion'), 100);
  v_prev int;
  s chat_sessions%rowtype;
  v_warn boolean := false;
  v_close boolean := false;
  v_reason text;
  v_alert_close boolean := false;
begin
  select strikes into v_prev from chat_sessions where session_id = v_session;
  if not found then return jsonb_build_object('warn', false, 'close', false); end if;

  if p_kind = 'off_topic' then
    update chat_sessions set strikes = strikes + 1, offtopic_total = offtopic_total + 1 where session_id = v_session;
  elsif p_kind = 'manipulation' then
    update chat_sessions set strikes = strikes + 2, offtopic_total = offtopic_total + 1,
      manipulation_total = manipulation_total + 1 where session_id = v_session;
  else
    update chat_sessions set strikes = 0 where session_id = v_session;
  end if;

  select * into s from chat_sessions where session_id = v_session;

  if p_kind <> 'ok' then
    v_warn := (v_prev < 3 and s.strikes >= 3);
    if s.strikes >= 6 then v_close := true; v_reason := 'Racha de preguntas fuera de tema';
    elsif s.manipulation_total >= 3 then v_close := true; v_reason := 'Intentos repetidos de manipular a la IA';
    elsif s.offtopic_total >= 10 then v_close := true; v_reason := 'Demasiadas preguntas fuera de tema';
    end if;
  end if;

  if v_close then
    update chat_sessions set status = 'closed', closed_reason = v_reason, closed_at = now() where session_id = v_session;
    v_alert_close := not s.alerted_close;
    update chat_sessions set alerted_close = true where session_id = v_session;
    insert into chat_messages (session_id, role, text, via)
    values (v_session, 'bot', 'Conversación cerrada automáticamente: ' || v_reason || '.', 'sistema');
  end if;

  return jsonb_build_object(
    'warn', v_warn, 'close', v_close, 'reason', v_reason,
    'alert_close', v_alert_close, 'strikes', s.strikes,
    'nombre', s.nombre, 'ip', s.ip
  );
end;
$$;
revoke all on function chat_register_outcome(text, text) from public, anon, authenticated;
grant execute on function chat_register_outcome(text, text) to service_role;

-- ── guardado de mensajes (los manda la propia web) ──────────────────────────
create or replace function chat_log_messages(p_session text, p_ip text, p_ua text, p_nombre text, p_msgs jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_session text := left(coalesce(nullif(trim(p_session), ''), 'sin_sesion'), 100);
  v_touch jsonb;
  v_total int;
  m jsonb;
  v_added int := 0;
  v_ip_msgs int;
begin
  v_touch := chat_touch_session(v_session, p_ip, p_ua);

  if p_nombre is not null and length(trim(p_nombre)) > 0 then
    update chat_sessions set nombre = left(trim(p_nombre), 60) where session_id = v_session;
  end if;

  select count(*) into v_total from chat_messages where session_id = v_session;

  -- Tope diario de mensajes guardados por IP: nadie puede inundar la base de
  -- datos con mensajes falsos llamando a la función a mano.
  select count(*) into v_ip_msgs
  from chat_messages cm join chat_sessions cs using (session_id)
  where cs.ip = chat_norm_ip(p_ip) and cm.created_at > now() - interval '1 day';
  if v_ip_msgs >= 800 then
    return jsonb_build_object('ok', true, 'added', 0, 'alert_similar', (v_touch ->> 'alert_similar')::boolean, 'ip', v_touch ->> 'ip');
  end if;

  for m in select * from jsonb_array_elements(coalesce(p_msgs, '[]'::jsonb)) loop
    exit when v_total + v_added >= 400;
    if (m ->> 'role') in ('user', 'bot') and length(coalesce(m ->> 'text', '')) > 0 then
      insert into chat_messages (session_id, role, text, via)
      values (v_session, m ->> 'role', left(m ->> 'text', 2000), left(m ->> 'via', 20));
      v_added := v_added + 1;
    end if;
  end loop;

  update chat_sessions set msg_count = msg_count + v_added where session_id = v_session;

  if random() < 0.02 then perform chat_purge_old(); end if;

  return jsonb_build_object('ok', true, 'added', v_added, 'alert_similar', (v_touch ->> 'alert_similar')::boolean, 'ip', v_touch ->> 'ip');
end;
$$;
revoke all on function chat_log_messages(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function chat_log_messages(text, text, text, text, jsonb) to service_role;

-- ── rescate de las conversaciones antiguas (solo tenían la pregunta suelta) ──
-- Se marcan `legacy` para que el panel avise de que no hay respuestas guardadas.
insert into chat_sessions (session_id, nombre, first_seen, last_seen, msg_count, legacy)
select session_id,
       max((regexp_match(nota, '^(.{1,40}?) — Preguntó'))[1]),
       min(created_at), max(created_at), 0, true
from interactions
where source = 'chat' and client_id is null and session_id is not null
  and nota ~ 'Preguntó'
group by session_id
on conflict (session_id) do nothing;

insert into chat_messages (session_id, role, text, via, created_at)
select session_id, 'user', q, 'legacy', min(created_at)
from (
  select session_id, created_at,
         (regexp_match(nota, '^(?:.{1,40}? — )?Preguntó(?: \(sin resolver por el asistente básico\))?: (.*)$'))[1] as q
  from interactions
  where source = 'chat' and client_id is null and session_id is not null and nota ~ 'Preguntó'
) t
where q is not null and length(q) > 0
  and exists (select 1 from chat_sessions cs where cs.session_id = t.session_id and cs.legacy)
  and not exists (select 1 from chat_messages cm where cm.session_id = t.session_id and cm.via = 'legacy')
group by session_id, q
order by min(created_at);

update chat_sessions cs
   set msg_count = (select count(*) from chat_messages cm where cm.session_id = cs.session_id)
 where cs.legacy;

-- =============================================================================
-- FIN — prueba de humo:
--   select chat_gate('t1','1.2.3.4','ua');           -- allowed:true
--   insert en blocked_ips (ip) values ('1.2.3.4');    -- desde el panel
--   select chat_gate('t2','1.2.3.4','ua');           -- reason:blocked
--   select chat_gate('t3','1.2.3.9','ua');           -- alert_similar:true (misma /24)
--   3 x chat_register_outcome('t1','off_topic')      -- 3ª devuelve warn:true
--   6 seguidas                                       -- close:true
-- =============================================================================
