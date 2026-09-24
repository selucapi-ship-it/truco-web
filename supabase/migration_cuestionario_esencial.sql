-- Cuestionario esencial (cuestionario-esencial.html) — formulario corto que un
-- prospecto/cliente rellena por su cuenta cuando no ha habido tiempo de hacer
-- la auditoría completa por llamada. Reutiliza audit_respuestas (misma tabla,
-- mismos pregunta_id que el guion de auditoría del panel) para que las
-- respuestas aparezcan solas en la ficha del cliente, sin duplicar nada.
--
-- El logo se guarda como base64 directamente en `clients`, igual que ya se
-- hacen las fotos de ticket en fiscal_expenses — este proyecto no usa Supabase
-- Storage en ningún sitio, así que no hace falta montar un bucket nuevo solo
-- para esto.
alter table public.clients add column if not exists logo_base64 text;
alter table public.clients add column if not exists logo_filename text;

comment on column public.clients.logo_base64 is 'Logo del cliente subido desde cuestionario-esencial.html, como data URL base64 (igual que las fotos de ticket de fiscal_expenses).';
