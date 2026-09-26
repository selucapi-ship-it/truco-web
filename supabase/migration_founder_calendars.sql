-- El founder solo podía vincular UN calendario de Google en su propio panel
-- (guardado en localStorage del navegador, se perdía al cambiar de
-- dispositivo) y solo veía una lista de texto de los próximos días, sin
-- poder navegar por meses ni anotar nada — a diferencia del calendario
-- visual navegable que sí tienen sus clientes en portal/calendario.html.
-- Esta migración da al founder lo mismo: hasta 4 calendarios de Google
-- vinculados a la vez (persistidos en la base de datos, no en el
-- navegador) y notas propias por día, igual que client_day_notes pero sin
-- client_id porque solo hay un founder.
create table if not exists public.founder_calendars (
  id uuid primary key default gen_random_uuid(),
  calendar_id text not null,
  label text not null default '',
  color text not null default 'gold',
  created_at timestamptz not null default now()
);

alter table public.founder_calendars enable row level security;

create policy "founder_calendars founder all" on public.founder_calendars
  for all using (is_founder()) with check (is_founder());

create table if not exists public.founder_day_notes (
  fecha date primary key,
  nota text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.founder_day_notes enable row level security;

create policy "founder_day_notes founder all" on public.founder_day_notes
  for all using (is_founder()) with check (is_founder());
