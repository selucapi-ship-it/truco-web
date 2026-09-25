-- Vuelve el borrado duro de clientes (quitado sin querer del panel en el
-- rediseño de RBAC) — sin esta política, RLS bloqueaba cualquier DELETE
-- sobre clients (no existía ninguna). Solo founder, y solo para limpiar
-- clientes de prueba: para clientes reales siguen existiendo "Dar de baja"
-- y el borrado RGPD, que no destruyen historial.
create policy "founder delete clients" on public.clients
  for delete
  using (is_founder());
