-- Historial real, mensaje a mensaje, del WhatsApp con IA de cada cliente —
-- hasta ahora solo quedaba una nota resumida en `interactions`, nada que el
-- propio cliente pudiera ver en su portal. Mismo patrón que
-- whatsapp_sessions/whatsapp_messages (Jose), pero multi-tenant desde el
-- inicio (client_id) y con RLS que deja verlo SOLO a quien tiene contratado
-- 'whatsapp' en client_solutions — el resto de clientes no debe ni saber que
-- esta tabla existe.
create table if not exists public.client_whatsapp_messages (
  id bigserial primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  telefono text not null,
  nombre text,
  role text not null check (role in ('user','bot')),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_client_whatsapp_messages_client on public.client_whatsapp_messages(client_id, created_at);

alter table public.client_whatsapp_messages enable row level security;

create policy "client_whatsapp_messages founder all" on public.client_whatsapp_messages
  for all using (is_founder()) with check (is_founder());

-- Solo ve esto quien tiene 'whatsapp' realmente contratado (client_solutions,
-- lo mismo que decide si aparece en su "Automatizaciones y servicios") — si
-- se le da de baja la automatización, deja de verlas sin borrar nada.
create policy "client_whatsapp_messages client select own" on public.client_whatsapp_messages
  for select using (
    exists (
      select 1 from public.clients c
      join public.client_solutions cs on cs.client_id = c.id and cs.solution_key = 'whatsapp'
      where c.id = client_whatsapp_messages.client_id and c.auth_user_id = auth.uid()
    )
  );

-- Nada de insert/update/delete para authenticated ni anon: solo el webhook
-- (service_role, que salta RLS) escribe aquí.
revoke all on public.client_whatsapp_messages from anon, authenticated;
grant select on public.client_whatsapp_messages to authenticated;
