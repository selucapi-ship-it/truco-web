-- Registro de llamadas del asistente de voz (teléfono y web) + tope mensual por número.
create table if not exists voice_calls (
  id uuid primary key default gen_random_uuid(),
  room text,
  channel text not null default 'phone' check (channel in ('phone','web')),
  caller_number text,
  nombre text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_s int,
  booked boolean not null default false,
  end_reason text,
  transcript jsonb not null default '[]'::jsonb
);
create index if not exists voice_calls_started_idx on voice_calls (started_at desc);

create table if not exists voice_number_usage (
  caller_number text not null,
  month date not null,
  calls int not null default 0,
  primary key (caller_number, month)
);

alter table voice_calls enable row level security;
alter table voice_number_usage enable row level security;
drop policy if exists "founder read voice_calls" on voice_calls;
create policy "founder read voice_calls" on voice_calls for select using (is_founder());
drop policy if exists "founder delete voice_calls" on voice_calls;
create policy "founder delete voice_calls" on voice_calls for delete using (is_founder());
drop policy if exists "founder read voice_number_usage" on voice_number_usage;
create policy "founder read voice_number_usage" on voice_number_usage for select using (is_founder());

-- Cuenta una llamada nueva de ese número este mes; si ya alcanzó el tope no la cuenta y devuelve allowed=false.
create or replace function voice_call_gate(p_number text, p_limit int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_month date := date_trunc('month', now() at time zone 'Europe/Madrid')::date;
  v_calls int;
begin
  insert into voice_number_usage (caller_number, month, calls) values (p_number, v_month, 0)
    on conflict do nothing;
  select calls into v_calls from voice_number_usage where caller_number = p_number and month = v_month for update;
  if v_calls >= p_limit then
    return jsonb_build_object('allowed', false, 'calls', v_calls);
  end if;
  update voice_number_usage set calls = calls + 1 where caller_number = p_number and month = v_month;
  return jsonb_build_object('allowed', true, 'calls', v_calls + 1);
end;
$$;
revoke all on function voice_call_gate(text, int) from public, anon, authenticated;
grant execute on function voice_call_gate(text, int) to service_role;

create or replace function voice_purge_old() returns void
language sql security definer set search_path = public as $$
  delete from voice_calls where started_at < now() - interval '180 days';
  delete from voice_number_usage where month < (now() - interval '400 days')::date;
$$;
revoke all on function voice_purge_old() from public, anon, authenticated;
grant execute on function voice_purge_old() to service_role;

-- Números bloqueados por el founder (botón "Bloquear número" del panel)
create table if not exists blocked_numbers (
  number text primary key,
  reason text,
  blocked_at timestamptz not null default now()
);
alter table blocked_numbers enable row level security;
drop policy if exists "founder read blocked_numbers" on blocked_numbers;
create policy "founder read blocked_numbers" on blocked_numbers for select using (is_founder());
drop policy if exists "founder insert blocked_numbers" on blocked_numbers;
create policy "founder insert blocked_numbers" on blocked_numbers for insert with check (is_founder());
drop policy if exists "founder delete blocked_numbers" on blocked_numbers;
create policy "founder delete blocked_numbers" on blocked_numbers for delete using (is_founder());
-- voice_call_gate se redefinió para rechazar números de blocked_numbers (devuelve blocked=true).

-- Clientes registrados (status='cliente' con su teléfono en la ficha): sin tope mensual de llamadas.
-- voice_call_gate se redefinió para saltarse el tope cuando el número coincide con el de un cliente.
