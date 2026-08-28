-- =============================================================================
-- MIGRACIÓN — founder_fiscal_resumen: permitir llamada con service_role
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase (pegar todo → Run).
-- Requiere migration_fiscalidad.sql ya aplicada (redefine founder_fiscal_resumen).
--
-- Qué resuelve: el script local de generación de trimestrales
-- (scripts/trimestral.js) llama a founder_fiscal_resumen() desde fuera del
-- navegador, con la service_role key. is_founder() comprueba auth.uid() (la
-- sesión de usuario autenticado), no la clave usada en la petición — la
-- service_role bypassa las políticas RLS, pero NO este chequeo manual dentro
-- de la función, así que la llamada fallaba con "Solo el founder puede ver
-- la fiscalidad" aunque se usara la clave correcta.
--
-- La service_role key es en sí misma un JWT con el claim role=service_role,
-- así que auth.role() (lee ese claim de la petición) es la forma estándar de
-- Supabase de detectarla dentro de una función. Se añade como alternativa a
-- is_founder(), nunca la sustituye — desde el navegador (anon/authenticated)
-- sigue exigiendo is_founder() exactamente igual que antes.
--
-- Idempotente a propósito, mismo criterio que las migraciones anteriores.
-- =============================================================================

create or replace function founder_fiscal_resumen(p_anio int, p_trimestre int) returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_result jsonb;
  v_q_inicio date;
  v_q_fin date;
  v_anio_inicio date;
begin
  if not (is_founder() or auth.role() = 'service_role') then
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

-- Nota: no se toca "grant ... to authenticated" — el service_role de Postgres
-- salta cualquier grant/revoke, así que la llamada con esa clave funciona
-- igual sin necesidad de un grant explícito a "service_role".

-- =============================================================================
-- FIN — prueba de humo:
--   1. Con curl y la ANON key (sin sesión de founder): sigue fallando con
--      "Solo el founder puede ver la fiscalidad", igual que antes de esta
--      migración.
--   2. Con curl y la SERVICE_ROLE key: devuelve el jsonb completo, sin
--      excepción.
--        curl -s "$SUPABASE_URL/rest/v1/rpc/founder_fiscal_resumen" \
--          -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
--          -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
--          -H "Content-Type: application/json" \
--          -d '{"p_anio":2026,"p_trimestre":1}'
--   3. Desde el panel (admin/panel.html), como founder autenticado, la
--      pestaña Fiscalidad sigue funcionando exactamente igual que antes.
-- =============================================================================
