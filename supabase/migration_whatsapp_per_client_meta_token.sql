-- Puente TEMPORAL mientras se resuelve la Advanced Access de TRUCOchat
-- (Meta App Review, ~20 días desde 2026-09-13). Founder decidió (mismo día)
-- que, mientras tanto, se puede dar de alta a un cliente real creando una
-- app de Meta dedicada bajo el Business Manager DE ESE CLIENTE ("Direct
-- Developer" — no necesita Advanced Access porque solo sirve a su propio
-- negocio, no a terceros). Eso significa que el token para mandar mensajes
-- ya NO es siempre el system-user compartido de TRUCO
-- (META_WHATSAPP_SYSTEM_TOKEN) — puede ser el token propio de la app de ese
-- cliente.
--
-- Diseño explícitamente ADITIVO Y REVERSIBLE (petición directa del founder:
-- "no quiero que se cambie para siempre solo quiero que sea hasta que se me
-- apruebe"): la columna es opcional. Si tiene valor, se usa ese token
-- (cliente con app dedicada). Si es NULL (comportamiento de siempre), se
-- sigue usando el token compartido de TRUCO. Cuando TRUCOchat obtenga
-- Advanced Access, los clientes NUEVOS simplemente no rellenan esta columna
-- y siguen el modelo compartido de siempre — no hace falta migrar nada de
-- los que ya la tengan rellena, ni revertir esta migración.

alter table client_whatsapp_bot_config
  add column if not exists meta_access_token text;

comment on column client_whatsapp_bot_config.meta_access_token is
  'Token de acceso de la app de Meta dedicada de ESTE cliente (modelo "Direct Developer", puente temporal mientras TRUCOchat espera Advanced Access). NULL = usar el token compartido de TRUCO (META_WHATSAPP_SYSTEM_TOKEN), que sigue siendo el caso normal/futuro.';

-- La RPC tiene que devolver la columna nueva para que el webhook la reciba.
drop function if exists get_whatsapp_bot_config_by_phone_number_id(text);
create function get_whatsapp_bot_config_by_phone_number_id(p_phone_number_id text)
returns table (
  client_id uuid,
  nombre_negocio text,
  nombre_asistente text,
  horario_atencion jsonb,
  tono text,
  mensaje_bienvenida text,
  mensaje_ausencia text,
  faq jsonb,
  catalogo jsonb,
  meta_access_token text
)
language sql
security definer
stable
set search_path = public
as $$
  select
    cfg.client_id, cfg.nombre_negocio, cfg.nombre_asistente, cfg.horario_atencion,
    cfg.tono, cfg.mensaje_bienvenida, cfg.mensaje_ausencia, cfg.faq, cfg.catalogo,
    cfg.meta_access_token
  from client_whatsapp_bot_config cfg
  join client_automations ca
    on ca.client_id = cfg.client_id and ca.solution_key = 'whatsapp' and ca.status = 'live'
  where cfg.meta_phone_number_id = p_phone_number_id and cfg.activo = true;
$$;

revoke all on function get_whatsapp_bot_config_by_phone_number_id from public, anon, authenticated;
grant execute on function get_whatsapp_bot_config_by_phone_number_id to service_role;

-- Prueba de humo (ejecutar a mano tras aplicar la migración):
-- 1. select * from get_whatsapp_bot_config_by_phone_number_id('un_phone_number_id_de_prueba');
--    -- debe seguir devolviendo la fila de siempre, ahora con meta_access_token (NULL si no se ha puesto).
-- 2. update client_whatsapp_bot_config set meta_access_token = 'token_de_prueba' where client_id = '...';
--    -- volver a llamar a la RPC y confirmar que meta_access_token viaja con el valor puesto.
