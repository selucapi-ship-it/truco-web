-- Asesor de rendimiento de Supabase: crm_activities/crm_contacts/crm_settings
-- tenían una política "founder: ALL" + políticas "owner" por comando aparte,
-- así que Postgres evaluaba 2 políticas permisivas en cada SELECT/INSERT/UPDATE
-- (is_founder() Y ADEMÁS crm_owns_client(), en vez de una sola con OR). Esto
-- las fusiona en una política por comando, MISMO permiso resultante, la mitad
-- de evaluaciones. Tablas prácticamente vacías ahora mismo (feature de
-- 2026-09-21, sin clientes reales usándola todavía) — riesgo mínimo.

-- ═══ crm_contacts — founder ALL + owner select/insert/update/delete,
-- las 4 acciones tenían exactamente la misma condición owner ⇒ se puede
-- colapsar todo en una sola política FOR ALL sin cambiar nada. ═══
drop policy if exists "crm contacts founder" on public.crm_contacts;
drop policy if exists "crm contacts owner select" on public.crm_contacts;
drop policy if exists "crm contacts owner insert" on public.crm_contacts;
drop policy if exists "crm contacts owner update" on public.crm_contacts;
drop policy if exists "crm contacts owner delete" on public.crm_contacts;
create policy "crm contacts founder or owner" on public.crm_contacts
  for all
  using (is_founder() or crm_owns_client(client_id))
  with check (is_founder() or crm_owns_client(client_id));

-- ═══ crm_settings — founder ALL + owner select/insert/update (SIN owner
-- delete: solo founder podía borrar). No se puede colapsar en una sola FOR ALL
-- sin ampliar permisos, así que select/insert/update se fusionan y delete se
-- deja aparte, solo para founder, igual que antes. ═══
drop policy if exists "crm settings founder" on public.crm_settings;
drop policy if exists "crm settings owner select" on public.crm_settings;
drop policy if exists "crm settings owner insert" on public.crm_settings;
drop policy if exists "crm settings owner update" on public.crm_settings;
create policy "crm settings founder or owner select" on public.crm_settings
  for select
  using (is_founder() or crm_owns_client(client_id));
create policy "crm settings founder or owner insert" on public.crm_settings
  for insert
  with check (is_founder() or crm_owns_client(client_id));
create policy "crm settings founder or owner update" on public.crm_settings
  for update
  using (is_founder() or crm_owns_client(client_id))
  with check (is_founder() or crm_owns_client(client_id));
create policy "crm settings founder delete" on public.crm_settings
  for delete
  using (is_founder());

-- ═══ crm_activities — founder ALL + owner select + owner insert (con la
-- condición extra de que sea una nota ligada a un contacto suyo). Sin owner
-- update/delete: solo founder. Select/insert se fusionan; update/delete
-- quedan solo para founder, igual que antes. ═══
drop policy if exists "crm activities founder" on public.crm_activities;
drop policy if exists "crm activities owner select" on public.crm_activities;
drop policy if exists "crm activities owner insert note" on public.crm_activities;
create policy "crm activities founder or owner select" on public.crm_activities
  for select
  using (is_founder() or crm_owns_client(client_id));
create policy "crm activities founder or owner insert" on public.crm_activities
  for insert
  with check (
    is_founder()
    or (
      crm_owns_client(client_id)
      and kind = 'nota'
      and exists (
        select 1 from crm_contacts k
        where k.id = crm_activities.contact_id and k.client_id = crm_activities.client_id
      )
    )
  );
create policy "crm activities founder update" on public.crm_activities
  for update
  using (is_founder())
  with check (is_founder());
create policy "crm activities founder delete" on public.crm_activities
  for delete
  using (is_founder());
