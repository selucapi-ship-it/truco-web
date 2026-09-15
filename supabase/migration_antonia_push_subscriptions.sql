-- Suscripciones de notificaciones push (Web Push / VAPID) de la app ANTONIA
-- (antonia-app, PWA personal de Jose). Puede haber más de una fila a la vez
-- (móvil + un navegador de escritorio, por ejemplo) — se manda a todas las
-- que sigan vivas y se borran las que el navegador de destino ya considera
-- caducadas (respuesta 404/410 del propio servicio push).
create table if not exists antonia_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- Mismo patrón deny-all-except-service_role que bank_transfer_orders /
-- paypal_pending_orders: nadie con la clave pública puede leer ni escribir
-- aquí directamente.
alter table antonia_push_subscriptions enable row level security;
