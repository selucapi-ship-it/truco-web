-- =============================================================================
-- MIGRACIÓN — Presupuestos comerciales (para prospectos y clientes)
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase del sitio
-- PRINCIPAL de TRUCO → pegar todo → Run.
-- Requiere migration_monstruo_overhaul.sql y migration_client_access_control.sql
-- ya aplicadas (usa is_founder(), clients, client_solutions, solutions_catalog,
-- payments).
--
-- Un presupuesto no necesita que el destinatario sea ya cliente — guarda su
-- propio contacto. Si acepta y paga (Parte 3, create-quote-checkout.js +
-- stripe-webhook.js), ahí sí se crea o enlaza el cliente de verdad.
--
-- Idempotente a propósito, mismo criterio que las migraciones anteriores.
-- =============================================================================

create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete set null,
  nombre_contacto text,
  email_contacto text,
  telefono text,
  negocio text,
  lineas jsonb not null default '[]'::jsonb,
  notas text,
  total_estimado numeric not null default 0,
  estado text not null default 'borrador' check (estado in ('borrador','enviado','aceptado','rechazado','pagado')),
  stripe_checkout_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists quotes_client_id_idx on quotes(client_id);
create index if not exists quotes_email_idx on quotes(email_contacto);

alter table quotes enable row level security;
drop policy if exists "founder all quotes" on quotes;
create policy "founder all quotes" on quotes for all using (is_founder()) with check (is_founder());

-- =============================================================================
-- solutions_catalog: precio de venta suelta, distinto del "valor si va dentro
-- de un Departamento" que ya tiene price_eur. Y de alta 3 soluciones que hoy
-- se venden en soluciones/*.html pero nunca se dieron de alta en el catálogo.
--
-- crm/docs/integraciones no van incluidas en NINGÚN Departamento (se venden
-- siempre sueltas, con auditoría previa) — así que price_eur no aplica para
-- ellas. Hace falta permitir que sea nulo (hoy es not null); admin/panel.html
-- ya está preparado para pintar "—" cuando price_eur es null.
-- =============================================================================
alter table solutions_catalog alter column price_eur drop not null;
alter table solutions_catalog add column if not exists standalone_price_eur numeric;

insert into solutions_catalog (solution_key, name, price_eur, standalone_price_eur, monthly_usage_limit, overage_rate_eur) values
  ('crm', 'CRM a medida', null, 950, null, null),
  ('docs', 'Automatización de documentos', null, 400, null, null),
  ('integraciones', 'Integraciones a medida', null, 600, null, null)
  on conflict (solution_key) do nothing;

update solutions_catalog set standalone_price_eur = 29 where solution_key = 'web-ia' and standalone_price_eur is null;

-- =============================================================================
-- confirm_quote_payment() — la llama stripe-webhook.js (service_role, sin
-- sesión de usuario) al confirmarse el pago de un presupuesto. A propósito
-- NO usa is_founder() como create_client_manual (esa comprueba quién ES el
-- usuario logueado, y aquí no hay ninguno) — en su lugar, igual que
-- confirm_client_purchase(), se protege solo concediendo EXECUTE a
-- service_role y revocándolo a todo lo demás, así que solo puede llamarla el
-- propio backend con la clave de servicio, nunca un usuario ni anónimo.
-- =============================================================================
create or replace function confirm_quote_payment(
  p_quote_id uuid,
  p_nombre text default null,
  p_email text default null,
  p_telefono text default null,
  p_negocio text default null,
  p_solutions text[] default null,
  p_stripe_session_id text default null,
  p_stripe_payment_intent_id text default null,
  p_stripe_customer_id text default null,
  p_amount_total_cents int default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_client_id uuid; v_sol text;
begin
  if p_email is not null and p_email <> '' then
    insert into clients (nombre, email, telefono, negocio, status, contract_started_at)
    values (p_nombre, p_email, p_telefono, p_negocio, 'cliente', now())
    on conflict (email) do update set
      nombre = coalesce(excluded.nombre, clients.nombre),
      telefono = coalesce(excluded.telefono, clients.telefono),
      negocio = coalesce(excluded.negocio, clients.negocio),
      status = 'cliente',
      baja_at = null,
      contract_started_at = coalesce(clients.contract_started_at, now()),
      updated_at = now()
    returning id into v_client_id;

    insert into interactions (client_id, source, nota)
    values (v_client_id, 'checkout', 'Presupuesto ' || p_quote_id || ' aceptado y pagado.');

    if p_solutions is not null then
      foreach v_sol in array p_solutions loop
        insert into client_solutions (client_id, solution_key, solution_name, price_eur, is_free)
        select v_client_id, sc.solution_key, sc.name, sc.price_eur, false
        from solutions_catalog sc where sc.solution_key = v_sol
        on conflict (client_id, solution_key) do nothing;

        insert into client_automations (client_id, solution_key, status)
        values (v_client_id, v_sol, 'pending')
        on conflict (client_id, solution_key) do nothing;
      end loop;
    end if;
  end if;

  update quotes set estado = 'pagado', client_id = coalesce(v_client_id, quotes.client_id), updated_at = now()
  where id = p_quote_id;

  if v_client_id is not null and p_amount_total_cents is not null then
    insert into payments (client_id, stripe_checkout_session_id, stripe_payment_intent_id,
      stripe_customer_id, amount_total_cents, status, plan_key)
    values (v_client_id, p_stripe_session_id, p_stripe_payment_intent_id,
      p_stripe_customer_id, p_amount_total_cents, 'completed', 'presupuesto:' || p_quote_id)
    on conflict (stripe_checkout_session_id) do nothing;
  end if;

  return v_client_id;
end;
$$;
revoke all on function confirm_quote_payment(uuid, text, text, text, text, text[], text, text, text, int) from public, anon, authenticated;
grant execute on function confirm_quote_payment(uuid, text, text, text, text, text[], text, text, text, int) to service_role;

-- =============================================================================
-- FIN — prueba de humo:
--   1. Como founder: sb.from('quotes').insert({...}) y sb.from('quotes').select()
--      deben funcionar.
--   2. Un colaborador sin ser founder: ambas deben devolver 0 filas / fallar
--      por RLS (nunca ver ni crear presupuestos de otro).
--   3. sb.rpc('confirm_quote_payment', {p_quote_id:'<uuid de un presupuesto de
--      prueba>', p_email:'prueba@ejemplo.com', p_solutions:['truki']}) debe
--      devolver un client_id y dejar ese presupuesto en estado 'pagado'.
-- =============================================================================
