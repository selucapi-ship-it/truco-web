-- MIGRACIÓN — optimización de rendimiento detectada por el performance advisor
-- de Supabase (31 ago 2026): 55 avisos de "multiple_permissive_policies" (en
-- realidad 11 solapamientos reales, contados x5 por cada rol interno de
-- Postgres), 7 de "auth_rls_initplan" (auth.uid()/auth.role() sin envolver en
-- una subconsulta, se reevalúa fila a fila) y 12 claves foráneas sin índice.
--
-- Deliberadamente NO se tocan los 7 avisos de "unused_index" — con tan poco
-- tráfico real todavía, que un índice no se haya usado aún no significa que
-- sobre; se revisará más adelante con datos de uso reales.
--
-- Cada bloque de política se comprobó contra la definición REAL en
-- producción (pg_policies) antes de escribir esto, no contra los ficheros
-- de migración locales, que ya se ha visto otras veces que pueden no
-- reflejar el estado real aplicado.
-- =============================================================================

-- ── client_automations — fusiona SELECT + envuelve auth.uid() ──
drop policy if exists "client read own client_automations" on public.client_automations;
drop policy if exists "staff read client_automations" on public.client_automations;
create policy "read client_automations" on public.client_automations for select
using (
  exists (select 1 from clients c where c.id = client_automations.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'view')
);

-- ── client_solutions — fusiona SELECT + envuelve auth.uid() ──
drop policy if exists "client read own client_solutions" on public.client_solutions;
drop policy if exists "staff read client_solutions" on public.client_solutions;
create policy "read client_solutions" on public.client_solutions for select
using (
  exists (select 1 from clients c where c.id = client_solutions.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'view')
);

-- ── clients — fusiona SELECT + envuelve auth.uid() ──
drop policy if exists "client read own row" on public.clients;
drop policy if exists "staff read clients" on public.clients;
create policy "read clients" on public.clients for select
using (
  auth_user_id = (select auth.uid())
  or has_client_access(id, 'view')
);

-- ── interactions — fusiona DELETE, INSERT y SELECT (3 políticas) + envuelve auth.uid() ──
drop policy if exists "founder delete anon interactions" on public.interactions;
drop policy if exists "staff delete client interactions" on public.interactions;
create policy "delete interactions" on public.interactions for delete
using (
  (is_founder() and client_id is null)
  or (client_id is not null and has_client_access(client_id, 'edit'))
);

drop policy if exists "founder insert anon manual interactions" on public.interactions;
drop policy if exists "staff insert client manual interactions" on public.interactions;
create policy "insert interactions" on public.interactions for insert
with check (
  (is_founder() and client_id is null and source = 'manual')
  or (client_id is not null and source = 'manual' and has_client_access(client_id, 'edit'))
);

drop policy if exists "client read own portal interactions" on public.interactions;
drop policy if exists "founder read anon interactions" on public.interactions;
drop policy if exists "staff read client interactions" on public.interactions;
create policy "read interactions" on public.interactions for select
using (
  (source = 'portal' and exists (select 1 from clients c where c.id = interactions.client_id and c.auth_user_id = (select auth.uid())))
  or (is_founder() and client_id is null)
  or (client_id is not null and has_client_access(client_id, 'view'))
);

-- ── payments — fusiona SELECT + envuelve auth.uid() ──
drop policy if exists "client read own payments" on public.payments;
drop policy if exists "staff read payments" on public.payments;
create policy "read payments" on public.payments for select
using (
  exists (select 1 from clients c where c.id = payments.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'view')
);

-- ── tasks — fusiona SELECT + envuelve auth.uid() ──
drop policy if exists "client read own tasks" on public.tasks;
drop policy if exists "staff read tasks" on public.tasks;
create policy "read tasks" on public.tasks for select
using (
  exists (select 1 from clients c where c.id = tasks.client_id and c.auth_user_id = (select auth.uid()))
  or has_client_access(client_id, 'view')
);

-- ── truki_gastos — solo envuelve auth.role(), sin solapamiento que fusionar ──
drop policy if exists "authenticated all gastos" on public.truki_gastos;
create policy "authenticated all gastos" on public.truki_gastos
for all using ((select auth.role()) = 'authenticated') with check ((select auth.role()) = 'authenticated');

-- ── pricing_offers — "founder write" (ALL) solapaba con "public read" (SELECT,
-- sin condición) solo en SELECT. Como "public read" ya deja ver todo sin
-- condición, separar el founder a solo escritura no le quita nada. ──
drop policy if exists "founder write pricing_offers" on public.pricing_offers;
create policy "founder insert pricing_offers" on public.pricing_offers for insert with check (is_founder());
create policy "founder update pricing_offers" on public.pricing_offers for update using (is_founder()) with check (is_founder());
create policy "founder delete pricing_offers" on public.pricing_offers for delete using (is_founder());
-- "public read pricing_offers" (qual = true) se queda tal cual, sola.

-- ── tier_config — mismo caso exacto que pricing_offers ──
drop policy if exists "founder all tier_config" on public.tier_config;
create policy "founder insert tier_config" on public.tier_config for insert with check (is_founder());
create policy "founder update tier_config" on public.tier_config for update using (is_founder()) with check (is_founder());
create policy "founder delete tier_config" on public.tier_config for delete using (is_founder());
-- "public read tier_config" (qual = true) se queda tal cual, sola.

-- ── solutions_catalog — CUIDADO: aquí "public read" SÍ tiene condición
-- (active = true), así que separar sin más dejaría al founder sin ver las
-- soluciones inactivas del catálogo. Se fusiona el SELECT en vez de separarlo. ──
drop policy if exists "founder all solutions_catalog" on public.solutions_catalog;
drop policy if exists "public read active solutions_catalog" on public.solutions_catalog;
create policy "read solutions_catalog" on public.solutions_catalog for select
using (is_founder() or active = true);
create policy "founder insert solutions_catalog" on public.solutions_catalog for insert with check (is_founder());
create policy "founder update solutions_catalog" on public.solutions_catalog for update using (is_founder()) with check (is_founder());
create policy "founder delete solutions_catalog" on public.solutions_catalog for delete using (is_founder());

-- =============================================================================
-- Índices que faltan en claves foráneas (12 avisos) — sobre todo columnas de
-- auditoría (created_by, granted_by, requested_by), justo en las tablas de
-- fiscalidad y control de acceso que más se usan ahora mismo.
-- =============================================================================
create index if not exists client_automations_solution_key_idx on public.client_automations(solution_key);
create index if not exists data_retention_requests_client_id_idx on public.data_retention_requests(client_id);
create index if not exists data_retention_requests_requested_by_idx on public.data_retention_requests(requested_by);
create index if not exists fiscal_declarations_created_by_idx on public.fiscal_declarations(created_by);
create index if not exists fiscal_expenses_created_by_idx on public.fiscal_expenses(created_by);
create index if not exists fiscal_expenses_template_id_idx on public.fiscal_expenses(template_id);
create index if not exists fiscal_income_created_by_idx on public.fiscal_income(created_by);
create index if not exists staff_client_access_granted_by_idx on public.staff_client_access(granted_by);
create index if not exists staff_roles_created_by_idx on public.staff_roles(created_by);
create index if not exists tasks_assignee_id_idx on public.tasks(assignee_id);
create index if not exists tasks_created_by_idx on public.tasks(created_by);
create index if not exists truki_gastos_created_by_idx on public.truki_gastos(created_by);

-- =============================================================================
-- FIN — prueba de humo recomendada: volver a correr el performance advisor
-- (mcp Supabase → get_advisors, type=performance) y confirmar que los avisos
-- de multiple_permissive_policies y auth_rls_initplan para estas tablas han
-- desaparecido, y que un cliente real sigue viendo exactamente lo mismo que
-- veía antes (nadie ha perdido ni ganado acceso, solo se ha optimizado cómo
-- se comprueba).
-- =============================================================================
