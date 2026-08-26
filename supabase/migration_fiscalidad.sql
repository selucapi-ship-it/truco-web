-- =============================================================================
-- MIGRACIÓN — Fiscalidad del founder: ingresos, gastos y trimestrales sin gestor
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase (pegar todo → Run).
-- Requiere migration_monstruo_overhaul.sql y migration_client_access_control.sql
-- ya aplicadas (usa is_founder(), clients, payments).
--
-- Qué resuelve: el founder lleva su propia contabilidad de autónomo, sin
-- gestoría. Esta migración crea tres tablas founder-exclusivas (ingresos,
-- gastos, declaraciones ya presentadas), un trigger que rellena los ingresos
-- solo cuando hay un pago real por Stripe (sin tocar netlify/functions/
-- stripe-webhook.js), y una función de resumen para calcular Modelo 130
-- (IRPF, pago fraccionado) y Modelo 303 (IVA trimestral) cada trimestre.
--
-- Esto es una herramienta de cálculo y contabilidad, no asesoría fiscal.
-- Las categorías de gasto y los porcentajes deducibles son orientativos.
--
-- Idempotente a propósito, mismo criterio que las migraciones anteriores.
-- =============================================================================


-- =============================================================================
-- 1) fiscal_income — ingresos. Se rellena sola desde payments (ver trigger más
--    abajo); admite también filas manuales (ej. una transferencia bancaria
--    que nunca pasa por Stripe). base_imponible_cents/iva_cents son columnas
--    generadas: la fórmula del IVA vive en un único sitio, nunca en JS.
-- =============================================================================
create table if not exists fiscal_income (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid unique references payments(id) on delete set null, -- null = entrada manual
  client_id uuid references clients(id) on delete set null,
  fecha date not null default current_date,
  concepto text not null,
  origen text not null default 'manual' check (origen in ('stripe', 'manual')),
  total_cents int not null check (total_cents >= 0),
  iva_pct numeric(5,2) not null default 21,
  base_imponible_cents int generated always as (round(total_cents::numeric / (1 + iva_pct / 100.0))::int) stored,
  iva_cents int generated always as (total_cents - round(total_cents::numeric / (1 + iva_pct / 100.0))::int) stored,
  anulado boolean not null default false,
  anulado_motivo text,
  notas text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fiscal_income_fecha_idx on fiscal_income(fecha);
create index if not exists fiscal_income_client_idx on fiscal_income(client_id);

alter table fiscal_income enable row level security;
drop policy if exists "founder all fiscal_income" on fiscal_income;
create policy "founder all fiscal_income" on fiscal_income for all using (is_founder()) with check (is_founder());


-- =============================================================================
-- 2) fiscal_expenses — gastos deducibles. Categorías orientativas para un
--    autónomo de software/SaaS (no las de TruKi, que son de oficios). Sin
--    numeración ni hash-chain: esa maquinaria (VERI*FACTU/RD 1007/2023) es
--    solo para documentos emitidos a terceros, no para contabilidad interna
--    — mismo criterio que ya usa truki_gastos en el producto TruKi.
-- =============================================================================
create table if not exists fiscal_expenses (
  id uuid primary key default gen_random_uuid(),
  fecha date not null default current_date,
  concepto text not null,
  categoria text not null default 'otros' check (categoria in (
    'software_saas', 'suministros_vivienda', 'equipos_informaticos', 'marketing',
    'comisiones_bancarias', 'formacion', 'cuota_autonomo', 'gestoria_puntual',
    'material_oficina', 'otros'
  )),
  importe_base_cents int not null check (importe_base_cents >= 0),
  iva_pct numeric(5,2) not null default 21, -- 0 en gastos sin IVA (ej. cuota de autónomo)
  iva_cents int generated always as (round(importe_base_cents::numeric * iva_pct / 100.0)::int) stored,
  total_cents int generated always as (importe_base_cents + round(importe_base_cents::numeric * iva_pct / 100.0)::int) stored,
  deducible_pct numeric(5,2) not null default 100 check (deducible_pct between 0 and 100), -- ej. ~30 en suministros de vivienda
  proveedor_nombre text,
  proveedor_nif text,
  recibo_base64 text, -- JPEG redimensionado en el navegador, sin bucket de storage (igual que TruKi)
  notas text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fiscal_expenses_fecha_idx on fiscal_expenses(fecha);
create index if not exists fiscal_expenses_categoria_idx on fiscal_expenses(categoria);

alter table fiscal_expenses enable row level security;
drop policy if exists "founder all fiscal_expenses" on fiscal_expenses;
create policy "founder all fiscal_expenses" on fiscal_expenses for all using (is_founder()) with check (is_founder());


-- =============================================================================
-- 3) fiscal_declarations — registro de lo ya presentado cada trimestre. Sin
--    esto, el Modelo 130 del trimestre siguiente no podría restar los pagos
--    fraccionados ya declarados en trimestres anteriores del mismo año.
-- =============================================================================
create table if not exists fiscal_declarations (
  id uuid primary key default gen_random_uuid(),
  anio int not null,
  trimestre int not null check (trimestre in (1, 2, 3, 4)),
  modelo text not null check (modelo in ('130', '303')),
  resultado_cents int not null, -- positivo = a ingresar, negativo = a devolver/compensar
  fecha_presentacion date not null default current_date,
  notas text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (anio, trimestre, modelo)
);
alter table fiscal_declarations enable row level security;
drop policy if exists "founder all fiscal_declarations" on fiscal_declarations;
create policy "founder all fiscal_declarations" on fiscal_declarations for all using (is_founder()) with check (is_founder());


-- =============================================================================
-- 4) fiscal_income_sync_from_payment() — trigger sobre payments. Cuando un
--    pago pasa a 'completed' se crea (o actualiza) su fila de ingreso; si
--    pasa a reembolsado/fallido/disputado, se marca anulado en vez de
--    borrarse (conserva el rastro). Nota: hoy stripe-webhook.js no escucha
--    eventos de reembolso, así que un refund real requiere actualizar
--    payments.status a mano en Supabase — el trigger lo recoge solo en
--    cuanto eso ocurre.
-- =============================================================================
create or replace function fiscal_income_sync_from_payment() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.status = 'completed' then
    insert into fiscal_income (payment_id, client_id, fecha, concepto, origen, total_cents, iva_pct)
    values (
      NEW.id, NEW.client_id, NEW.created_at::date,
      'Pago Stripe' || coalesce(' — ' || NEW.plan_key, '') || coalesce(' (' || NEW.arranque_tier || ')', ''),
      'stripe', NEW.amount_total_cents, 21
    )
    on conflict (payment_id) do update set
      total_cents = excluded.total_cents,
      client_id = excluded.client_id,
      anulado = false, anulado_motivo = null, updated_at = now();
  elsif NEW.status in ('refunded', 'partially_refunded', 'failed', 'disputed') then
    update fiscal_income set anulado = true, anulado_motivo = 'payments.status = ' || NEW.status, updated_at = now()
    where payment_id = NEW.id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists fiscal_income_sync on payments;
create trigger fiscal_income_sync
  after insert or update of status on payments
  for each row execute function fiscal_income_sync_from_payment();


-- =============================================================================
-- 5) founder_fiscal_resumen(p_anio, p_trimestre) — agregado único para el
--    overlay de Fiscalidad, founder-exclusivo, mismo patrón que
--    founder_dashboard_stats(). Todo el cálculo (Modelo 130 y 303) se hace
--    en el servidor; el navegador solo pinta el jsonb devuelto.
-- =============================================================================
create or replace function founder_fiscal_resumen(p_anio int, p_trimestre int) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_result jsonb;
  v_q_inicio date;
  v_q_fin date;
  v_anio_inicio date;
begin
  if not is_founder() then
    raise exception 'Solo el founder puede ver la fiscalidad';
  end if;
  if p_trimestre not in (1, 2, 3, 4) then
    raise exception 'Trimestre inválido: %', p_trimestre;
  end if;

  v_q_inicio := make_date(p_anio, (p_trimestre - 1) * 3 + 1, 1);
  v_q_fin := (v_q_inicio + interval '3 months' - interval '1 day')::date;
  v_anio_inicio := make_date(p_anio, 1, 1);

  select jsonb_build_object(
    'anio', p_anio, 'trimestre', p_trimestre,
    'periodo', jsonb_build_object('desde', v_q_inicio, 'hasta', v_q_fin),

    'iva_devengado_cents', (
      select coalesce(sum(iva_cents), 0) from fiscal_income
      where not anulado and fecha between v_q_inicio and v_q_fin
    ),
    'iva_deducible_cents', (
      select coalesce(sum(round(iva_cents * deducible_pct / 100.0)), 0)::bigint from fiscal_expenses
      where fecha between v_q_inicio and v_q_fin
    ),
    'base_devengada_cents', (
      select coalesce(sum(base_imponible_cents), 0) from fiscal_income
      where not anulado and fecha between v_q_inicio and v_q_fin
    ),
    'base_deducible_cents', (
      select coalesce(sum(round(importe_base_cents * deducible_pct / 100.0)), 0)::bigint from fiscal_expenses
      where fecha between v_q_inicio and v_q_fin
    ),

    'ingresos_netos_acumulados_cents', (
      select coalesce(sum(base_imponible_cents), 0) from fiscal_income
      where not anulado and fecha between v_anio_inicio and v_q_fin
    ),
    'gastos_deducibles_acumulados_cents', (
      select coalesce(sum(round(importe_base_cents * deducible_pct / 100.0)), 0)::bigint from fiscal_expenses
      where fecha between v_anio_inicio and v_q_fin
    ),
    'pagos_fraccionados_declarados_previos_cents', (
      select coalesce(sum(resultado_cents), 0) from fiscal_declarations
      where modelo = '130' and anio = p_anio and trimestre < p_trimestre
    ),

    'declaracion_303_ya_presentada', (
      select to_jsonb(d) from fiscal_declarations d where modelo = '303' and anio = p_anio and trimestre = p_trimestre
    ),
    'declaracion_130_ya_presentada', (
      select to_jsonb(d) from fiscal_declarations d where modelo = '130' and anio = p_anio and trimestre = p_trimestre
    ),

    'gastos_por_categoria', (
      select coalesce(jsonb_object_agg(categoria, total), '{}'::jsonb) from (
        select categoria, sum(total_cents) total from fiscal_expenses
        where fecha between v_q_inicio and v_q_fin group by categoria
      ) s
    ),

    'ingresos_lista', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'fecha', i.fecha, 'concepto', i.concepto, 'origen', i.origen, 'cliente', c.nombre,
        'base_cents', i.base_imponible_cents, 'iva_cents', i.iva_cents, 'total_cents', i.total_cents, 'anulado', i.anulado
      ) order by i.fecha desc), '[]'::jsonb)
      from fiscal_income i left join clients c on c.id = i.client_id
      where i.fecha between v_q_inicio and v_q_fin
    ),

    'gastos_lista', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id, 'fecha', e.fecha, 'concepto', e.concepto, 'categoria', e.categoria,
        'base_cents', e.importe_base_cents, 'iva_cents', e.iva_cents, 'total_cents', e.total_cents,
        'deducible_pct', e.deducible_pct, 'proveedor_nombre', e.proveedor_nombre
      ) order by e.fecha desc), '[]'::jsonb)
      from fiscal_expenses e where e.fecha between v_q_inicio and v_q_fin
    )
  ) into v_result;

  v_result := v_result
    || jsonb_build_object('resultado_303_cents',
         (v_result->>'iva_devengado_cents')::bigint - (v_result->>'iva_deducible_cents')::bigint)
    || jsonb_build_object('rendimiento_neto_acumulado_cents',
         (v_result->>'ingresos_netos_acumulados_cents')::bigint - (v_result->>'gastos_deducibles_acumulados_cents')::bigint);

  v_result := v_result
    || jsonb_build_object('pago_fraccionado_20pct_acumulado_cents',
         round((v_result->>'rendimiento_neto_acumulado_cents')::numeric * 0.20)::bigint)
    || jsonb_build_object('pago_fraccionado_pendiente_130_cents',
         round((v_result->>'rendimiento_neto_acumulado_cents')::numeric * 0.20)::bigint
         - (v_result->>'pagos_fraccionados_declarados_previos_cents')::bigint);

  return v_result;
end;
$$;
revoke all on function founder_fiscal_resumen(int, int) from public, anon;
grant execute on function founder_fiscal_resumen(int, int) to authenticated;


-- =============================================================================
-- FIN — prueba de humo:
--   1. Insertar un payments de prueba con amount_total_cents=12100 (121,00€)
--      y status='completed' → fiscal_income debe recibir base_imponible_
--      cents=10000 (100,00€) e iva_cents=2100 (21,00€). Cambiar el status a
--      'refunded' → anulado debe pasar a true.
--   2. Como founder: sb.rpc('founder_fiscal_resumen', {p_anio:2026,
--      p_trimestre:1}) debe devolver el jsonb completo.
--   3. Un colaborador sin ser founder intenta lo mismo → debe fallar con la
--      excepción explícita ("Solo el founder puede ver la fiscalidad").
--   4. Insertar 3 gastos con categorías e IVA distintos (uno con
--      deducible_pct=30, otro con iva_pct=0) y comprobar a mano que
--      iva_deducible_cents y rendimiento_neto_acumulado_cents cuadran.
--   5. Registrar una fiscal_declarations del 130 para el T1 y comprobar que
--      al pedir el resumen del T2 aparece en pagos_fraccionados_declarados_
--      previos_cents.
-- =============================================================================
