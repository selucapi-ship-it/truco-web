-- Renombra las claves internas de tier que hasta ahora eran 'basic' (mostrado
-- como Start™) y 'elemental-profesional' (mostrado como Basic™) para que
-- coincidan por fin con los nombres visibles: 'basic'→'start' y
-- 'elemental-profesional'→'basic'. Motivo: mantener claves internas
-- desalineadas de los nombres visibles generaba confusión real (enlaces y
-- código más difíciles de razonar) — se decidió alinear todo de una vez.
--
-- Requiere migration_founding_spots.sql y migration_founding_spots_start_basic.sql
-- ya aplicadas. Ejecutar una sola vez en Supabase (SQL Editor → pegar → Run),
-- DESPUÉS de haber desplegado el código nuevo de pago.html/founding-offer.js/
-- stripe-webhook.js (para minimizar la ventana en la que código viejo y
-- claves nuevas convivirían).
--
-- Orden crítico: 'basic'→'start' PRIMERO, luego 'elemental-profesional'→'basic'
-- SEGUNDO — si se hiciera al revés (o a la vez), la segunda fila chocaría con
-- la clave primaria 'basic' que la primera acaba de dejar libre.

alter table founding_spots drop constraint if exists founding_spots_tier_check;
alter table founding_spots add constraint founding_spots_tier_check
  check (tier in ('lite','pro','start','basic','elemental-profesional'));
-- (constraint temporalmente permisiva con ambos juegos de claves mientras
-- dura esta migración; se deja estrecha otra vez al final del archivo)

update founding_spots set tier = 'start' where tier = 'basic';
update founding_spots set tier = 'basic' where tier = 'elemental-profesional';

alter table founding_spots drop constraint if exists founding_spots_tier_check;
alter table founding_spots add constraint founding_spots_tier_check
  check (tier in ('lite','pro','start','basic'));

-- clients.arranque_tier: si migration_plan_tracking.sql no llegó a
-- ejecutarse en este proyecto de Supabase, la columna ni siquiera existe
-- todavía — se crea aquí de forma segura (no hace nada si ya existe) antes
-- de tocarla, para que esta migración no dependa de si aquella se aplicó.
alter table clients add column if not exists arranque_tier text;

-- Tenía además un hueco previo sin relación con este renombrado: su CHECK
-- nunca llegó a incluir 'elemental-profesional' cuando se creó el
-- Departamento Basic™ — se corrige aquí de paso, ya con las claves nuevas.
alter table clients drop constraint if exists clients_arranque_tier_check;
alter table clients add constraint clients_arranque_tier_check
  check (arranque_tier is null or arranque_tier in ('start','basic','lite','pro'));

update clients set arranque_tier = 'start' where arranque_tier = 'basic';
update clients set arranque_tier = 'basic' where arranque_tier = 'elemental-profesional';
