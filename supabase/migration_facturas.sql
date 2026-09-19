-- =============================================================================
-- MIGRACIÓN — Facturas reales de TRUCOtechnology (numeración legal + hash)
-- =============================================================================
-- Ejecutar UNA sola vez, entera, en el SQL Editor de Supabase del sitio
-- PRINCIPAL de TRUCO → pegar todo → Run.
-- Requiere migration_client_access_control.sql ya aplicada (usa is_founder()).
--
-- CONTEXTO LEGAL (investigado 2026-09-18, no asumido):
-- El Real Decreto-ley 15/2025 aplazó por segunda vez el Reglamento VERI*FACTU:
-- obligatorio para autónomos (persona física) desde el 1 de julio de 2027, no
-- antes. O sea: hoy NO hace falta transmisión en tiempo real a la AEAT ni
-- código QR. Lo que SÍ es obligatorio desde siempre (Real Decreto 1619/2012,
-- sin cambios) es la numeración CORRELATIVA SIN HUECOS dentro de cada serie,
-- los datos mínimos de emisor/receptor, y que una factura ya emitida no se
-- edite ni se borre — un error se corrige con una factura RECTIFICATIVA
-- nueva, nunca modificando la original.
--
-- Este esquema ya deja preparado el encadenamiento por hash (mismo formato
-- verificado byte a byte contra los ejemplos oficiales de la AEAT que se usó
-- para arreglar TruKi, ver memoria truki-verifactu-migration-research) para
-- que activar VERI*FACTU de verdad antes de julio de 2027 sea añadir la
-- transmisión SOAP + QR, no rehacer la numeración ni el encadenado.
-- =============================================================================

create table if not exists facturas (
  id uuid primary key default gen_random_uuid(),
  serie text not null default 'A',
  anio int not null,
  numero int not null,
  numero_completo text generated always as (serie || '-' || anio || '-' || lpad(numero::text, 4, '0')) stored,

  -- Vínculos opcionales de origen (nunca se usan para leer datos en vivo —
  -- todo lo del cliente se copia/congela abajo, porque una factura no puede
  -- cambiar si el cliente edita después su ficha).
  client_id uuid references clients(id) on delete set null,
  quote_id uuid references quotes(id) on delete set null,

  -- Datos del cliente, CONGELADOS en el momento de emitir — una factura real
  -- nunca debe cambiar de contenido después, ni siquiera si el cliente
  -- corrige su NIF más tarde (eso se resuelve con una rectificativa).
  cliente_nombre text not null,
  cliente_nif text,
  cliente_domicilio text,
  cliente_email text,

  lineas jsonb not null default '[]'::jsonb,
  base_imponible numeric not null,
  tipo_iva numeric not null default 21,
  cuota_iva numeric not null,
  total numeric not null,

  concepto text not null default 'Servicios de departamento tecnológico externalizado',
  fecha_expedicion date not null default current_date,
  notas text,

  estado text not null default 'emitida' check (estado in ('emitida', 'rectificada', 'anulada')),
  -- Solo para facturas rectificativas: a qué factura corrigen y por qué
  -- (R1 cubre el caso normal de "error en los datos", que es el único
  -- previsible para TRUCO; R2-R5 son supuestos legales muy específicos
  -- —concurso de acreedores, créditos incobrables...— que no aplican aquí,
  -- así que no se modela un desplegable con todos, solo se deja el campo
  -- libre para el día que hiciera falta).
  factura_rectificada_id uuid references facturas(id),
  tipo_rectificativa text check (tipo_rectificativa is null or tipo_rectificativa in ('R1','R2','R3','R4','R5')),
  motivo_rectificacion text,

  -- Encadenamiento por hash — mismo formato que usa TruKi (verificado contra
  -- los ejemplos oficiales de la AEAT): sha-256 en mayúsculas de
  -- "IDEmisorFactura=...&NumSerieFactura=...&FechaExpedicionFactura=DD-MM-YYYY
  -- &TipoFactura=F1&CuotaTotal=...&ImporteTotal=...&Huella=<hash_anterior o
  -- vacío>&FechaHoraHusoGenRegistro=<ISO8601 con offset>". No se transmite a
  -- ningún sitio todavía (eso es VERI*FACTU, julio 2027) — de momento es solo
  -- una prueba de integridad interna: si alguien manipulase una factura ya
  -- emitida a mano en la base de datos, el hash de todas las posteriores
  -- dejaría de cuadrar.
  hash_anterior text not null default '',
  hash_registro text not null,
  fecha_hora_generacion timestamptz not null default now(),

  created_at timestamptz not null default now(),
  unique (serie, anio, numero)
);
create index if not exists facturas_client_id_idx on facturas(client_id);
create index if not exists facturas_quote_id_idx on facturas(quote_id);
create index if not exists facturas_serie_anio_idx on facturas(serie, anio);

alter table facturas enable row level security;
-- Una factura real nunca se edita ni se borra desde la aplicación — solo
-- founder puede verlas y solo emitir_factura() (más abajo, security definer)
-- puede crearlas. Sin policy de UPDATE/DELETE para nadie: ni siquiera el
-- founder puede tocarlas desde el panel, a propósito.
drop policy if exists "founder ve facturas" on facturas;
create policy "founder ve facturas" on facturas for select using (is_founder());

-- =============================================================================
-- emitir_factura() — único camino para crear una factura. Calcula el
-- correlativo siguiente DENTRO de la transacción con un bloqueo de
-- aviso (pg_advisory_xact_lock) para que dos emisiones simultáneas nunca
-- puedan repetir número ni dejar un hueco — el bloqueo se libera solo al
-- terminar la transacción.
-- =============================================================================
create or replace function emitir_factura(
  p_serie text,
  p_cliente_nombre text,
  p_cliente_nif text,
  p_cliente_domicilio text,
  p_cliente_email text,
  p_lineas jsonb,
  p_concepto text default 'Servicios de departamento tecnológico externalizado',
  p_client_id uuid default null,
  p_quote_id uuid default null,
  p_tipo_iva numeric default 21,
  p_notas text default null,
  p_factura_rectificada_id uuid default null,
  p_tipo_rectificativa text default null,
  p_motivo_rectificacion text default null
) returns facturas
language plpgsql security definer set search_path = public as $$
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
  if not is_founder() then
    raise exception 'Solo el founder puede emitir facturas';
  end if;

  -- Bloqueo exclusivo por serie+año mientras dure esta transacción — evita
  -- la condición de carrera de dos facturas emitidas a la vez sin tener que
  -- mantener una tabla de contadores aparte.
  perform pg_advisory_xact_lock(hashtext(p_serie || ':' || v_anio::text));

  select coalesce(max(numero), 0) + 1 into v_numero
  from facturas where serie = p_serie and anio = v_anio;

  select coalesce(sum((l->>'precio')::numeric), 0) into v_base
  from jsonb_array_elements(p_lineas) l;
  v_iva := round(v_base * (p_tipo_iva / 100), 2);
  v_total := v_base + v_iva;

  -- El hash_anterior es el de la ÚLTIMA factura emitida en TODA la tabla
  -- (no solo esta serie) — es una cadena única, igual que exige la AEAT:
  -- cada registro enlaza con el inmediatamente anterior en el tiempo real de
  -- emisión, sin importar la serie.
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
  -- pgcrypto vive en el esquema "extensions" en Supabase, no en "public" —
  -- por eso se cualifica explícitamente en vez de fiarse del search_path.
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
$$;
revoke all on function emitir_factura(text, text, text, text, text, jsonb, text, uuid, uuid, numeric, text, uuid, text, text) from public, anon, authenticated;
grant execute on function emitir_factura(text, text, text, text, text, jsonb, text, uuid, uuid, numeric, text, uuid, text, text) to authenticated;
-- (el chequeo real de permiso lo hace is_founder() dentro de la función — se
-- concede a "authenticated" en vez de a nadie porque si no, ni el propio
-- founder logueado como usuario normal podría llamarla vía PostgREST/RPC)

-- =============================================================================
-- FIN — prueba de humo:
--   1. select emitir_factura('A','Cliente de prueba','12345678Z',null,null,
--        '[{"descripcion":"Test","precio":100}]'::jsonb);
--      → debe devolver numero=1 (o el siguiente correlativo si ya hay
--        facturas), hash_anterior='' si es la primera de la tabla.
--   2. Repetir la llamada → numero debe ser el correlativo+1, hash_anterior
--      debe ser el hash_registro de la anterior.
--   3. update facturas set total = 999 where id = '<la que sea>'; debe fallar
--      por RLS (no hay policy de UPDATE para nadie).
-- =============================================================================
