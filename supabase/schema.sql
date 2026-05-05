-- =============================================================
-- Schema: Prode Francisco
-- -------------------------------------------------------------
-- Pegá y ejecutá TODO este script en el SQL Editor de Supabase.
-- (Project → SQL Editor → New query → Run)
--
-- Crea:
--   - tabla public.bets (con constraints, columna generada y unique)
--   - Row Level Security activado
--   - Policy: cualquiera puede leer (SELECT) las apuestas
--   - Funciones RPC SECURITY DEFINER:
--       - place_bet(name, date_key, slot_id) → inserta validando
--       - delete_bet(id, name)               → borra validando dueño
--   - Realtime habilitado en la tabla bets
--
-- IMPORTANTE: NO se permiten INSERT/UPDATE/DELETE directos desde
-- el front. Toda escritura va por las funciones RPC, que validan
-- las reglas del prode (slot único, máx 3 apuestas por persona,
-- rango de fechas, etc.).
-- =============================================================

-- Limpieza opcional (descomentar si querés re-crear de cero)
-- drop table if exists public.bets cascade;
-- drop function if exists public.place_bet(text, date, smallint);
-- drop function if exists public.delete_bet(uuid, text);

-- -------------------------------------------------------------
-- 1. Tabla principal
-- -------------------------------------------------------------
create table if not exists public.bets (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  -- Columna generada para matchear personas ignorando mayúsculas/espacios
  name_normalized  text generated always as (lower(btrim(name))) stored,
  date_key         date not null,
  slot_id          smallint not null,
  created_at       timestamptz not null default now(),

  constraint bets_name_not_empty   check (btrim(name) <> ''),
  constraint bets_name_max_len     check (char_length(name) <= 30),
  constraint bets_date_in_range    check (date_key between date '2026-05-06' and date '2026-06-30'),
  constraint bets_slot_in_range    check (slot_id between 0 and 7),
  constraint bets_unique_slot      unique (date_key, slot_id)
);

-- Índices para queries frecuentes
create index if not exists bets_date_idx     on public.bets (date_key);
create index if not exists bets_name_norm_idx on public.bets (name_normalized);

-- -------------------------------------------------------------
-- 2. Row Level Security
-- -------------------------------------------------------------
alter table public.bets enable row level security;

-- Lectura abierta para anónimos y usuarios autenticados
drop policy if exists "bets_select_all" on public.bets;
create policy "bets_select_all"
  on public.bets
  for select
  to anon, authenticated
  using (true);

-- Sin policies de INSERT/UPDATE/DELETE → solo se puede escribir
-- a través de las funciones RPC (security definer) de abajo.

-- -------------------------------------------------------------
-- 3. Función RPC: place_bet
-- -------------------------------------------------------------
create or replace function public.place_bet(
  p_name      text,
  p_date_key  date,
  p_slot_id   smallint
)
returns public.bets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_norm text := lower(btrim(p_name));
  v_count int;
  v_row   public.bets;
begin
  if v_norm is null or v_norm = '' then
    raise exception 'El nombre no puede estar vacío';
  end if;

  if char_length(p_name) > 30 then
    raise exception 'El nombre es demasiado largo (máx 30)';
  end if;

  if p_date_key < date '2026-05-06' or p_date_key > date '2026-06-30' then
    raise exception 'La fecha está fuera del rango permitido';
  end if;

  if p_slot_id < 0 or p_slot_id > 7 then
    raise exception 'Slot inválido';
  end if;

  -- Lock para evitar carreras al chequear máximo de apuestas
  perform pg_advisory_xact_lock(hashtext(v_norm));

  select count(*) into v_count
  from public.bets
  where name_normalized = v_norm;

  if v_count >= 3 then
    raise exception 'Ya usaste tus 3 apuestas';
  end if;

  -- El UNIQUE (date_key, slot_id) ya nos protege del doble booking,
  -- pero capturamos el error para devolver un mensaje amable.
  begin
    insert into public.bets (name, date_key, slot_id)
    values (btrim(p_name), p_date_key, p_slot_id)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'Ese slot ya fue tomado por otra persona';
  end;

  return v_row;
end;
$$;

-- Permitir que anónimos puedan ejecutar la función (las validaciones
-- viven adentro, así que es seguro).
grant execute on function public.place_bet(text, date, smallint) to anon, authenticated;

-- -------------------------------------------------------------
-- 4. Función RPC: delete_bet
-- -------------------------------------------------------------
-- Permite borrar una apuesta SOLO si el "name" coincide (normalizado)
-- con el dueño del registro. Como no hay login real, esto es un
-- chequeo "honor system": evita que alguien borre apuestas ajenas
-- desde la UI normal, pero un usuario malicioso puede pasar otro
-- nombre. Para algo más fuerte, ver sección "Endurecimiento".
create or replace function public.delete_bet(
  p_id    uuid,
  p_name  text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_norm text := lower(btrim(coalesce(p_name, '')));
  v_owner text;
begin
  select name_normalized into v_owner
  from public.bets
  where id = p_id;

  if v_owner is null then
    raise exception 'La apuesta no existe';
  end if;

  if v_owner <> v_norm then
    raise exception 'Solo podés borrar tus propias apuestas';
  end if;

  delete from public.bets where id = p_id;
end;
$$;

grant execute on function public.delete_bet(uuid, text) to anon, authenticated;

-- -------------------------------------------------------------
-- 5. Realtime
-- -------------------------------------------------------------
-- Hace que el front se actualice automáticamente cuando alguien
-- agrega o borra una apuesta.
alter publication supabase_realtime add table public.bets;

-- =============================================================
-- LISTO. Ya podés usar el prode.
-- -------------------------------------------------------------
-- Endurecimiento opcional (recomendado si tenés muchos amigos):
--   - Agregar una passphrase de grupo: añadir un parámetro p_secret
--     a las funciones y compararlo con un valor guardado.
--   - Rate limit: usar la extensión pg_cron para limpiar intentos.
--   - Ban de nombres ofensivos / duplicados con caracteres raros.
-- =============================================================
