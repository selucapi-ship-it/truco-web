-- =============================================================================
-- MIGRACIÓN — Ofertas por tiempo (Navidad, Primavera...) que se revierten solas
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase del sitio
-- PRINCIPAL de TRUCO → pegar todo → Run.
-- Requiere migration_monstruo_overhaul.sql, migration_client_access_control.sql
-- y migration_quotes.sql (standalone_price_eur) ya aplicadas.
--
-- El precio "de verdad" de cada Departamento/servicio SIEMPRE vive en
-- tier_config/solutions_catalog — nunca se sobrescribe. Una oferta es una
-- fila aparte con fecha de inicio y fin; mientras hoy caiga dentro de esas
-- fechas, el precio EFECTIVO (el que se muestra y se cobra en toda la web)
-- es el de la oferta — fuera de esas fechas, vuelve solo al precio de
-- siempre, sin que nadie tenga que acordarse de deshacer nada.
--
-- founding-offer.js y solutions-pricing.js pasan a leer de las vistas
-- *_effective en vez de las tablas directamente — es el único cambio que
-- necesitan para que las ofertas se apliquen solas en toda la web.
--
-- Idempotente a propósito, mismo criterio que las migraciones anteriores.
-- =============================================================================

create table if not exists pricing_offers (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('tier','solution')),
  target_key text not null,
  price_field text not null check (price_field in ('founder_price_eur','standard_price_eur','price_eur','standalone_price_eur')),
  nombre text not null,
  precio_oferta numeric not null,
  desde date not null,
  hasta date not null,
  created_at timestamptz not null default now()
);
create index if not exists pricing_offers_lookup_idx on pricing_offers(target_type, target_key, price_field, desde, hasta);

alter table pricing_offers enable row level security;
drop policy if exists "public read pricing_offers" on pricing_offers;
create policy "public read pricing_offers" on pricing_offers for select using (true);
drop policy if exists "founder write pricing_offers" on pricing_offers;
create policy "founder write pricing_offers" on pricing_offers for all using (is_founder()) with check (is_founder());

create or replace view tier_config_effective as
select
  tc.tier,
  tc.name,
  coalesce(
    (select o.precio_oferta from pricing_offers o
     where o.target_type = 'tier' and o.target_key = tc.tier and o.price_field = 'founder_price_eur'
       and current_date between o.desde and o.hasta
     order by o.created_at desc limit 1),
    tc.founder_price_eur
  ) as founder_price_eur,
  coalesce(
    (select o.precio_oferta from pricing_offers o
     where o.target_type = 'tier' and o.target_key = tc.tier and o.price_field = 'standard_price_eur'
       and current_date between o.desde and o.hasta
     order by o.created_at desc limit 1),
    tc.standard_price_eur
  ) as standard_price_eur,
  tc.free_solutions_count,
  tc.max_maintained_solutions,
  tc.permanencia_meses
from tier_config tc;

create or replace view solutions_catalog_effective as
select
  sc.solution_key,
  sc.name,
  coalesce(
    (select o.precio_oferta from pricing_offers o
     where o.target_type = 'solution' and o.target_key = sc.solution_key and o.price_field = 'price_eur'
       and current_date between o.desde and o.hasta
     order by o.created_at desc limit 1),
    sc.price_eur
  ) as price_eur,
  coalesce(
    (select o.precio_oferta from pricing_offers o
     where o.target_type = 'solution' and o.target_key = sc.solution_key and o.price_field = 'standalone_price_eur'
       and current_date between o.desde and o.hasta
     order by o.created_at desc limit 1),
    sc.standalone_price_eur
  ) as standalone_price_eur,
  sc.monthly_usage_limit,
  sc.overage_rate_eur,
  sc.active
from solutions_catalog sc
where sc.active = true;

grant select on tier_config_effective to anon, authenticated;
grant select on solutions_catalog_effective to anon, authenticated;

-- =============================================================================
-- FIN — prueba de humo:
--   1. Crea una oferta de prueba (target_type='tier', target_key='start',
--      price_field='founder_price_eur', precio_oferta=1, desde=hoy, hasta=hoy)
--      desde el panel → sb.from('tier_config_effective').select() debe
--      devolver founder_price_eur=1 para 'start', pero tier_config (la tabla
--      real) debe seguir mostrando el precio de siempre sin tocar.
--   2. Borra esa oferta de prueba (o cambia sus fechas al pasado) →
--      tier_config_effective debe volver sola al precio real.
-- =============================================================================
