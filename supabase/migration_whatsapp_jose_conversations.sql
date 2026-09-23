-- Conversaciones de WhatsApp del propio número de TRUCO ("Jose",
-- netlify/functions/whatsapp-client-webhook.mjs → manejarMensajeJose).
-- Hasta ahora, si quien escribía NO era ya cliente, lo único que quedaba era
-- un aviso suelto por Telegram — nada quedaba guardado para poder repasarlo
-- después. Mismo patrón que chat_sessions/chat_messages
-- (migration_chat_conversations.sql) pero sin la parte de detección de abuso
-- (IP/strikes/similar_to_blocked), que no aplica a un número de teléfono real.

create table if not exists whatsapp_sessions (
  telefono text primary key,
  nombre text,
  client_id uuid references clients(id) on delete set null,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  msg_count int not null default 0
);

create table if not exists whatsapp_messages (
  id bigserial primary key,
  telefono text not null references whatsapp_sessions(telefono) on delete cascade,
  role text not null check (role in ('user', 'bot')),
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists whatsapp_messages_telefono_idx on whatsapp_messages (telefono, id);

alter table whatsapp_sessions enable row level security;
alter table whatsapp_messages enable row level security;

drop policy if exists "founder read whatsapp_sessions" on whatsapp_sessions;
create policy "founder read whatsapp_sessions" on whatsapp_sessions for select using (is_founder());
drop policy if exists "founder delete whatsapp_sessions" on whatsapp_sessions;
create policy "founder delete whatsapp_sessions" on whatsapp_sessions for delete using (is_founder());

drop policy if exists "founder read whatsapp_messages" on whatsapp_messages;
create policy "founder read whatsapp_messages" on whatsapp_messages for select using (is_founder());
drop policy if exists "founder delete whatsapp_messages" on whatsapp_messages;
create policy "founder delete whatsapp_messages" on whatsapp_messages for delete using (is_founder());

-- Llamada desde manejarMensajeJose (whatsapp-client-webhook.mjs) con la
-- service_role — guarda el mensaje del usuario y la respuesta de Jose de una
-- sola vez, y engancha client_id si ya se identificó como cliente.
create or replace function whatsapp_log_jose_exchange(
  p_telefono text,
  p_nombre text,
  p_client_id uuid,
  p_user_text text,
  p_bot_text text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tel text := left(p_telefono, 40);
begin
  insert into whatsapp_sessions (telefono, nombre, client_id, msg_count)
  values (v_tel, nullif(trim(coalesce(p_nombre, '')), ''), p_client_id, 2)
  on conflict (telefono) do update set
    nombre = coalesce(excluded.nombre, whatsapp_sessions.nombre),
    client_id = coalesce(excluded.client_id, whatsapp_sessions.client_id),
    last_seen = now(),
    msg_count = whatsapp_sessions.msg_count + 2;

  insert into whatsapp_messages (telefono, role, text) values (v_tel, 'user', left(p_user_text, 4000));
  if p_bot_text is not null then
    insert into whatsapp_messages (telefono, role, text) values (v_tel, 'bot', left(p_bot_text, 4000));
  end if;
end;
$$;

revoke all on function whatsapp_log_jose_exchange from public, anon, authenticated;
grant execute on function whatsapp_log_jose_exchange to service_role;

-- Prueba de humo:
-- select whatsapp_log_jose_exchange('34600000000', 'Test', null, 'hola', 'hola, en qué puedo ayudarte');
-- select * from whatsapp_sessions where telefono = '34600000000';
-- select * from whatsapp_messages where telefono = '34600000000';
-- delete from whatsapp_sessions where telefono = '34600000000'; -- cascada borra los mensajes
