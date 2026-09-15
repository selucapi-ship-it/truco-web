-- ── CAMPANA DE AVISOS DEL PANEL + RESUMEN DIARIO DE ANTONIA ──
--
-- El founder quiere que al entrar al panel vea de un vistazo cuánto tiene
-- pendiente de revisar (conversaciones nuevas del chat/voz, transferencias
-- sin confirmar, cobros de domiciliación pendientes del mes, leads nuevos
-- sin contactar) — y que ANTONIA le avise de lo mismo por Telegram, no solo
-- el panel.
--
-- La mayoría de esas categorías son "pendiente hasta que se resuelve"
-- (transferencias, cobros, leads) y no necesitan estado propio: se cuentan
-- en vivo contra su propia condición (bank_transfer_orders.status='pendiente',
-- etc. — ver admin/panel.html y antonia-resumen-diario.js). La única que sí
-- necesita recordar "hasta dónde ya has mirado" es "conversaciones nuevas",
-- porque una conversación de chat no tiene un estado de "resuelta": solo
-- tiene fecha. De ahí esta tabla, pensada para poder añadir más categorías
-- de este tipo en el futuro sin otra migración.
create table if not exists panel_notification_state (
  category text primary key,
  last_seen_at timestamptz not null default now()
);

-- Se siembra "ahora" a propósito (no epoch): así, la primera vez que esto se
-- despliega, la campana no muestra de golpe todo el histórico de
-- conversaciones que ha habido siempre, solo lo que llegue de aquí en
-- adelante — mismo criterio que "esPrimeraEjecucion" en antonia-vigilancia.js.
insert into panel_notification_state (category, last_seen_at)
values ('conversaciones', now())
on conflict (category) do nothing;

alter table panel_notification_state enable row level security;

-- is_founder(), no has_role()/is_admin(): comprobado contra las políticas
-- reales de "interactions" (pg_policies) que la campana consume — "read
-- interactions" solo deja ver las conversaciones sin cliente asignado
-- (la inmensa mayoría de "conversaciones nuevas": son leads anónimos del
-- chat/voz) a is_founder(), igual que "anon-section" ya está founder-only
-- en admin/panel.html. Un admin sin acceso concreto a esos clientes no
-- vería ese conteo aunque se le diera permiso aquí, así que este gate se
-- queda igual de estricto para no prometer un número que luego no se pueda
-- leer.
drop policy if exists "staff read panel_notification_state" on panel_notification_state;
create policy "staff read panel_notification_state" on panel_notification_state
  for select using (is_founder());

drop policy if exists "staff write panel_notification_state" on panel_notification_state;
create policy "staff write panel_notification_state" on panel_notification_state
  for update using (is_founder()) with check (is_founder());

drop policy if exists "staff insert panel_notification_state" on panel_notification_state;
create policy "staff insert panel_notification_state" on panel_notification_state
  for insert with check (is_founder());

-- El resumen diario de ANTONIA por Telegram necesita recordar desde cuándo
-- contar "conversaciones nuevas" (igual que el panel, pero por su cuenta —
-- que Jose haya mirado el panel no significa que ya se lo hayan contado por
-- Telegram, y viceversa). antonia_estado ya es la fila única de ajustes
-- globales de ANTONIA (no_molestar_hasta) — se le añade esta columna en vez
-- de crear otra tabla de una sola fila más.
alter table antonia_estado add column if not exists ultimo_resumen_negocio_at timestamptz;
