-- Nota personal del cliente por día en su calendario del portal — no existía
-- ningún sitio donde anotar algo desde la vista del día. RLS: cada cliente
-- solo ve/edita las suyas, el founder ve todas.
create table if not exists public.client_day_notes (
  client_id uuid not null references public.clients(id) on delete cascade,
  fecha date not null,
  nota text not null default '',
  updated_at timestamptz not null default now(),
  primary key (client_id, fecha)
);

alter table public.client_day_notes enable row level security;

create policy "client_day_notes founder all" on public.client_day_notes
  for all using (is_founder()) with check (is_founder());

create policy "client_day_notes client all own" on public.client_day_notes
  for all using (
    exists (select 1 from public.clients c where c.id = client_day_notes.client_id and c.auth_user_id = auth.uid())
  ) with check (
    exists (select 1 from public.clients c where c.id = client_day_notes.client_id and c.auth_user_id = auth.uid())
  );
