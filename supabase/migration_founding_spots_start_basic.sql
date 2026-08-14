-- Amplía el contador de plazas de fundador a los 4 Departamentos (antes solo
-- cubría Lite™/Pro™ — ver migration_founding_spots.sql). Las claves 'basic' y
-- 'elemental-profesional' son las mismas que usa pago.html/founding-offer.js:
-- 'basic' es el tier que se MUESTRA como "Start™" (69€ fundador/89€ estándar,
-- 20 plazas) y 'elemental-profesional' el que se muestra como "Basic™" (149€
-- fundador/169€ estándar, 10 plazas) — los nombres visibles cambiaron, las
-- claves internas no, a propósito, para no romper nada ya grabado.
-- Ejecutar una sola vez en Supabase (SQL Editor → pegar → Run). Requiere
-- migration_founding_spots.sql ya aplicada.

alter table founding_spots drop constraint if exists founding_spots_tier_check;
alter table founding_spots add constraint founding_spots_tier_check
  check (tier in ('lite','pro','basic','elemental-profesional'));

insert into founding_spots (tier, spots_left) values
  ('basic', 20),
  ('elemental-profesional', 10)
  on conflict (tier) do nothing;
