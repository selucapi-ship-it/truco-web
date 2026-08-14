-- Contador real de plazas de fundador (Lite™/Pro™), para que founding-offer.js
-- deje de depender de que el founder edite un número a mano cada vez que se
-- cierra una venta a precio de fundador. Ejecutar una sola vez en Supabase
-- (SQL Editor → pegar → Run). No depende de ninguna otra migración.

create table if not exists founding_spots (
  tier text primary key check (tier in ('lite','pro')),
  spots_left int not null default 10 check (spots_left >= 0)
);
insert into founding_spots (tier, spots_left) values ('lite', 10), ('pro', 10)
  on conflict (tier) do nothing;

alter table founding_spots enable row level security;
-- Lectura pública a propósito: son solo dos números (cuántas plazas de
-- fundador quedan), sin ningún dato personal — founding-offer.js los lee
-- desde cualquier página pública con la clave anon, sin pasar por ninguna
-- Netlify Function.
create policy "public read founding_spots" on founding_spots for select using (true);
-- Sin policy de insert/update/delete a propósito: solo decrement_founding_spot()
-- (más abajo) puede tocar esta tabla, y solo el webhook de Stripe la llama.

-- Baja 1 plaza del tier indicado si aún quedan, y devuelve el nuevo valor.
-- La llama netlify/functions/stripe-webhook.js, y solo cuando el pago
-- confirmado por Stripe se hizo realmente a precio de fundador (metadata
-- founding='true' en la sesión de checkout) — nunca se llama en cada compra,
-- solo en las que de verdad consumieron una plaza de fundador.
create or replace function decrement_founding_spot(p_tier text)
returns int
language sql
security definer
set search_path = public
as $$
  update founding_spots
  set spots_left = spots_left - 1
  where tier = p_tier and spots_left > 0
  returning spots_left;
$$;
revoke all on function decrement_founding_spot from public, anon, authenticated;
grant execute on function decrement_founding_spot to service_role;
