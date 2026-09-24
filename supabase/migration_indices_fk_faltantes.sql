-- Asesor de rendimiento de Supabase (get_advisors, 2026-09-24): 5 claves
-- foráneas sin índice de cobertura — cada join/filtro por esa columna hace un
-- escaneo completo de la tabla en vez de usar un índice. Puramente aditivo:
-- no cambia ninguna consulta ni ningún resultado, solo acelera las que ya
-- filtran por estas columnas (ficha de cliente, facturas rectificativas, etc).
create index if not exists crm_activities_client_id_idx on public.crm_activities(client_id);
create index if not exists documentos_firmados_client_id_idx on public.documentos_firmados(client_id);
create index if not exists facturas_factura_rectificada_id_idx on public.facturas(factura_rectificada_id);
create index if not exists reservas_creadas_client_id_idx on public.reservas_creadas(client_id);
create index if not exists whatsapp_sessions_client_id_idx on public.whatsapp_sessions(client_id);
