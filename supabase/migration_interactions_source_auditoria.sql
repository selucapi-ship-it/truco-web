-- Añade 'auditoria' como origen válido de interactions.source — el nuevo
-- formulario de reserva de auditoría (index.html) guarda ahí los datos del
-- prospecto antes de mostrarle el calendario de Google, en vez de perderse
-- por completo como pasaba hasta ahora.
alter table public.interactions drop constraint if exists interactions_source_check;
alter table public.interactions add constraint interactions_source_check
  check (source = any (array['checkout','chat','voice','whatsapp','portal','manual','web','auditoria']));
