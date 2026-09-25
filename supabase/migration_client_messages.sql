-- Mensajería directa founder <-> cliente dentro del portal — distinta del
-- chat de socio (un bot de IA que solo crea peticiones) y de las peticiones
-- (tasks, cliente -> founder). Esto es un hilo simple, cualquiera de los dos
-- puede escribir primero.
create table if not exists public.client_messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  sender text not null check (sender in ('founder','client')),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists client_messages_client_id_idx on public.client_messages(client_id);

alter table public.client_messages enable row level security;

create policy "client_messages founder all" on public.client_messages
  for all using (is_founder()) with check (is_founder());

create policy "client_messages client select own" on public.client_messages
  for select using (
    exists (select 1 from public.clients c where c.id = client_messages.client_id and c.auth_user_id = auth.uid())
  );

create policy "client_messages client insert own" on public.client_messages
  for insert with check (
    sender = 'client'
    and exists (select 1 from public.clients c where c.id = client_messages.client_id and c.auth_user_id = auth.uid())
  );
