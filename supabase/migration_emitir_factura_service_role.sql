-- Permite que el webhook de Stripe (service_role, sin sesión de founder
-- detrás) emita la factura automáticamente en cuanto se confirma un pago.
-- Antes, is_founder() a secas bloqueaba cualquier llamada servidor a
-- servidor con "Solo el founder puede emitir facturas".
--
-- Probado en directo (2026-09-25) con una llamada REST real usando la
-- service_role key, exactamente como hará stripe-webhook.js: la factura se
-- generó bien numerada (A-2026-0001) con su cadena de sellado, y se borró
-- después por ser una prueba.
create or replace function public.emitir_factura(p_serie text, p_cliente_nombre text, p_cliente_nif text, p_cliente_domicilio text, p_cliente_email text, p_lineas jsonb, p_concepto text DEFAULT 'Servicios de departamento tecnológico externalizado'::text, p_client_id uuid DEFAULT NULL::uuid, p_quote_id uuid DEFAULT NULL::uuid, p_tipo_iva numeric DEFAULT 21, p_notas text DEFAULT NULL::text, p_factura_rectificada_id uuid DEFAULT NULL::uuid, p_tipo_rectificativa text DEFAULT NULL::text, p_motivo_rectificacion text DEFAULT NULL::text)
RETURNS facturas
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_anio int := extract(year from current_date);
  v_numero int;
  v_base numeric;
  v_iva numeric;
  v_total numeric;
  v_ultimo_hash text;
  v_fecha_hora timestamptz := now();
  v_cadena text;
  v_hash text;
  v_row facturas;
begin
  if not (is_founder() or auth.role() = 'service_role') then
    raise exception 'Solo el founder puede emitir facturas';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_serie || ':' || v_anio::text));

  select coalesce(max(numero), 0) + 1 into v_numero
  from facturas where serie = p_serie and anio = v_anio;

  select coalesce(sum((l->>'precio')::numeric), 0) into v_base
  from jsonb_array_elements(p_lineas) l;
  v_iva := round(v_base * (p_tipo_iva / 100), 2);
  v_total := v_base + v_iva;

  select hash_registro into v_ultimo_hash
  from facturas order by fecha_hora_generacion desc, created_at desc limit 1;
  v_ultimo_hash := coalesce(v_ultimo_hash, '');

  v_cadena := 'IDEmisorFactura=48523326L' ||
    '&NumSerieFactura=' || p_serie || '-' || v_anio::text || '-' || lpad(v_numero::text, 4, '0') ||
    '&FechaExpedicionFactura=' || to_char(current_date, 'DD-MM-YYYY') ||
    '&TipoFactura=' || case when p_factura_rectificada_id is not null then 'R1' else 'F1' end ||
    '&CuotaTotal=' || v_iva::text ||
    '&ImporteTotal=' || v_total::text ||
    '&Huella=' || v_ultimo_hash ||
    '&FechaHoraHusoGenRegistro=' || to_char(v_fecha_hora, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM');
  v_hash := upper(encode(extensions.digest(v_cadena, 'sha256'), 'hex'));

  insert into facturas (
    serie, anio, numero, client_id, quote_id,
    cliente_nombre, cliente_nif, cliente_domicilio, cliente_email,
    lineas, base_imponible, tipo_iva, cuota_iva, total,
    concepto, notas,
    factura_rectificada_id, tipo_rectificativa, motivo_rectificacion,
    hash_anterior, hash_registro, fecha_hora_generacion
  ) values (
    p_serie, v_anio, v_numero, p_client_id, p_quote_id,
    p_cliente_nombre, p_cliente_nif, p_cliente_domicilio, p_cliente_email,
    p_lineas, v_base, p_tipo_iva, v_iva, v_total,
    coalesce(p_concepto, 'Servicios de departamento tecnológico externalizado'), p_notas,
    p_factura_rectificada_id, p_tipo_rectificativa, p_motivo_rectificacion,
    v_ultimo_hash, v_hash, v_fecha_hora
  ) returning * into v_row;

  if p_factura_rectificada_id is not null then
    update facturas set estado = 'rectificada' where id = p_factura_rectificada_id;
  end if;

  return v_row;
end;
$function$;
