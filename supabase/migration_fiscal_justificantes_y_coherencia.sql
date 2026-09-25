-- Auditoría fiscal (2026-09-25): dos huecos reales encontrados al revisar
-- Fiscalidad como lo haría un asesor.
--
-- 1) fiscal_income no tenía ningún sitio para adjuntar el justificante
--    (factura, recibo de banco...) — a diferencia de fiscal_expenses, que sí
--    guarda la foto del recibo (recibo_base64). Mismo patrón, para ingresos.
--
-- 2) founder_fiscal_resumen() no comprobaba si lo declarado como ingreso
--    coincide con las facturas realmente emitidas (con su cadena de sellado
--    tipo VeriFactu, lo que de verdad vería Hacienda en una inspección).
--    Probado en producción: el 3T-2026 tiene 1 ingreso de 1.137,22€ y CERO
--    facturas emitidas — exactamente el tipo de desajuste que esto detecta.

alter table public.fiscal_income
  add column if not exists justificante_base64 text,
  add column if not exists justificante_filename text;

create or replace function public.founder_fiscal_resumen(p_anio integer, p_trimestre integer)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $$
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
        'base_cents', i.base_imponible_cents, 'iva_cents', i.iva_cents, 'total_cents', i.total_cents, 'anulado', i.anulado,
        'tiene_justificante', (i.justificante_base64 is not null)
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
    ),

    'facturas_emitidas_periodo', (
      select jsonb_build_object(
        'count', count(*),
        'total_cents', coalesce(sum(round(total * 100)), 0)::bigint
      )
      from facturas
      where estado <> 'rectificada' and fecha_expedicion between v_q_inicio and v_q_fin
    )
  ) into v_result;

  v_result := v_result
    || jsonb_build_object('resultado_303_cents',
         (v_result->>'iva_devengado_cents')::bigint - (v_result->>'iva_deducible_cents')::bigint)
    || jsonb_build_object('rendimiento_neto_acumulado_cents',
         (v_result->>'ingresos_netos_acumulados_cents')::bigint - (v_result->>'gastos_deducibles_acumulados_cents')::bigint)
    || jsonb_build_object('beneficio_trimestre_cents',
         (v_result->>'base_devengada_cents')::bigint - (v_result->>'base_deducible_cents')::bigint);

  v_result := v_result
    || jsonb_build_object('pago_fraccionado_20pct_acumulado_cents',
         round((v_result->>'rendimiento_neto_acumulado_cents')::numeric * 0.20)::bigint)
    || jsonb_build_object('pago_fraccionado_pendiente_130_cents',
         round((v_result->>'rendimiento_neto_acumulado_cents')::numeric * 0.20)::bigint
         - (v_result->>'pagos_fraccionados_declarados_previos_cents')::bigint);

  return v_result;
end;
$$;
