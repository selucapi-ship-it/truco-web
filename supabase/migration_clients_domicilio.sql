-- Domicilio fiscal del cliente — hacía falta para poder emitir una factura
-- española completa (junto con nombre y NIF) y no se pedía en ningún sitio:
-- ni en el checkout público, ni se guardaba en clients. El flujo de
-- presupuestos ya tenía su propio campo "domicilio" a mano en cada
-- presupuesto (quotes.cliente_domicilio) — esto añade el mismo dato a la
-- ficha del cliente, para el alta directa por pago.html.

alter table public.clients add column if not exists domicilio text;

-- log_interaction() es la función que pago.html llama (vía
-- netlify/functions/save-lead.js) para dar de alta/actualizar la ficha del
-- cliente en el checkout — se le añade p_domicilio al final (con default
-- null) para no romper ninguna llamada existente que no lo mande.
create or replace function log_interaction(
  p_source text,
  p_session_id text default null,
  p_nombre text default null,
  p_email text default null,
  p_telefono text default null,
  p_negocio text default null,
  p_tipo text default null,
  p_nif text default null,
  p_nota text default null,
  p_domicilio text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
begin
  if p_email is not null and p_email <> '' then
    insert into clients (nombre, email, telefono, negocio, tipo, nif, domicilio)
    values (p_nombre, p_email, p_telefono, p_negocio, p_tipo, p_nif, p_domicilio)
    on conflict (email) do update set
      nombre = coalesce(excluded.nombre, clients.nombre),
      telefono = coalesce(excluded.telefono, clients.telefono),
      negocio = coalesce(excluded.negocio, clients.negocio),
      tipo = coalesce(excluded.tipo, clients.tipo),
      nif = coalesce(excluded.nif, clients.nif),
      domicilio = coalesce(excluded.domicilio, clients.domicilio),
      updated_at = now()
    returning id into v_client_id;

    if p_session_id is not null then
      update interactions set client_id = v_client_id
      where session_id = p_session_id and client_id is null;
    end if;
  elsif p_telefono is not null and p_telefono <> '' then
    select id into v_client_id from clients where telefono = p_telefono limit 1;

    if v_client_id is null then
      insert into clients (nombre, telefono, negocio, tipo, nif, domicilio)
      values (p_nombre, p_telefono, p_negocio, p_tipo, p_nif, p_domicilio)
      returning id into v_client_id;
    else
      update clients set
        nombre = coalesce(p_nombre, nombre),
        negocio = coalesce(p_negocio, negocio),
        tipo = coalesce(p_tipo, tipo),
        nif = coalesce(p_nif, nif),
        domicilio = coalesce(p_domicilio, domicilio),
        updated_at = now()
      where id = v_client_id;
    end if;

    if p_session_id is not null then
      update interactions set client_id = v_client_id
      where session_id = p_session_id and client_id is null;
    end if;
  end if;

  insert into interactions (client_id, session_id, source, nota)
  values (v_client_id, p_session_id, p_source, p_nota);

  return v_client_id;
end;
$$;

-- Prueba de humo:
-- select log_interaction('checkout', null, 'Test', 'test-domicilio@ejemplo.com', null, null, null, null, null, 'Calle Falsa 123, Madrid');
-- select domicilio from clients where email = 'test-domicilio@ejemplo.com'; -- debe salir 'Calle Falsa 123, Madrid'
-- delete from clients where email = 'test-domicilio@ejemplo.com';
