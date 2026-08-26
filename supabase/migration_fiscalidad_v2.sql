-- =============================================================================
-- MIGRACIÓN — Fiscalidad v2: gastos fijos (plantillas) y categoría de vehículo
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase (pegar todo → Run).
-- Requiere migration_fiscalidad.sql ya aplicada (usa fiscal_expenses, is_founder()).
--
-- Qué añade:
--   1) Categoría 'desplazamientos_vehiculo' en fiscal_expenses — con aviso
--      propio en el panel, porque la gasolina de un coche de uso mixto NO es
--      deducible en IRPF salvo afectación exclusiva del vehículo (ver
--      caveat en el formulario). No se le pone un % deducible por defecto
--      distinto a los demás porque cada caso es distinto — lo decide el
--      founder con la información delante.
--   2) fiscal_expense_templates — gastos fijos mensuales (cuota de
--      autónomo, suscripciones SaaS, etc.) que se aplican con un clic en
--      vez de teclearlos cada mes.
--
-- Idempotente a propósito, mismo criterio que las migraciones anteriores.
-- =============================================================================


-- =============================================================================
-- 1) Añadir 'desplazamientos_vehiculo' a la categoría de fiscal_expenses.
-- =============================================================================
alter table fiscal_expenses drop constraint if exists fiscal_expenses_categoria_check;
alter table fiscal_expenses add constraint fiscal_expenses_categoria_check check (categoria in (
  'software_saas', 'suministros_vivienda', 'equipos_informaticos', 'marketing',
  'comisiones_bancarias', 'formacion', 'cuota_autonomo', 'gestoria_puntual',
  'material_oficina', 'desplazamientos_vehiculo', 'otros'
));


-- =============================================================================
-- 2) fiscal_expense_templates — gastos fijos que se repiten cada mes
--    (cuota de autónomo, Supabase, Netlify, dominio, etc.). "Aplicar este
--    mes" en el panel crea un fiscal_expenses real por cada plantilla
--    activa que todavía no tenga su gasto de este mes — nunca duplica.
-- =============================================================================
create table if not exists fiscal_expense_templates (
  id uuid primary key default gen_random_uuid(),
  concepto text not null,
  categoria text not null default 'otros' check (categoria in (
    'software_saas', 'suministros_vivienda', 'equipos_informaticos', 'marketing',
    'comisiones_bancarias', 'formacion', 'cuota_autonomo', 'gestoria_puntual',
    'material_oficina', 'desplazamientos_vehiculo', 'otros'
  )),
  importe_base_cents int not null check (importe_base_cents >= 0),
  iva_pct numeric(5,2) not null default 21,
  deducible_pct numeric(5,2) not null default 100 check (deducible_pct between 0 and 100),
  proveedor_nombre text,
  proveedor_nif text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table fiscal_expense_templates enable row level security;
drop policy if exists "founder all fiscal_expense_templates" on fiscal_expense_templates;
create policy "founder all fiscal_expense_templates" on fiscal_expense_templates for all using (is_founder()) with check (is_founder());


-- =============================================================================
-- FIN — prueba de humo:
--   1. Crear una plantilla (ej. "Cuota autónomo", 290€ base, 0% IVA, 100%
--      deducible) y pulsar "Aplicar gastos fijos de este mes" dos veces
--      seguidas → debe crear el gasto la primera vez y NO duplicarlo la
--      segunda.
--   2. Añadir un gasto con categoría 'desplazamientos_vehiculo' y comprobar
--      que founder_fiscal_resumen() lo suma con normalidad (ninguna lógica
--      de cálculo distingue por categoría, solo por deducible_pct).
-- =============================================================================
