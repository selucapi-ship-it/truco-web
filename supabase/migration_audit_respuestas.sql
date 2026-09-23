-- Respuestas del cuestionario de auditoría, guardadas por cliente — para que
-- el founder (o un colaborador con acceso a ese cliente) pueda ir rellenando
-- las respuestas mientras hace la auditoría en directo, y quede guardado
-- para poder revisarlo después. Las PREGUNTAS en sí no viven en la base de
-- datos (son contenido fijo del catálogo, en admin/panel.html) — aquí solo
-- se guarda la respuesta de cada cliente a cada pregunta, identificada por
-- una clave estable (pregunta_id) que coincide con el id fijo de esa
-- pregunta en el JS del panel.

create table if not exists audit_respuestas (
  client_id uuid not null references clients(id) on delete cascade,
  pregunta_id text not null,
  respuesta text,
  updated_at timestamptz not null default now(),
  primary key (client_id, pregunta_id)
);

alter table audit_respuestas enable row level security;

drop policy if exists "client access view audit_respuestas" on audit_respuestas;
create policy "client access view audit_respuestas" on audit_respuestas
  for select using (has_client_access(client_id, 'view'));

drop policy if exists "client access upsert audit_respuestas" on audit_respuestas;
create policy "client access upsert audit_respuestas" on audit_respuestas
  for insert with check (has_client_access(client_id, 'edit'));

drop policy if exists "client access update audit_respuestas" on audit_respuestas;
create policy "client access update audit_respuestas" on audit_respuestas
  for update using (has_client_access(client_id, 'edit')) with check (has_client_access(client_id, 'edit'));

drop policy if exists "client access delete audit_respuestas" on audit_respuestas;
create policy "client access delete audit_respuestas" on audit_respuestas
  for delete using (has_client_access(client_id, 'edit'));
