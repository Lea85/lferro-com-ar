-- =============================================================
-- Schema: Prode Fifa 2026
-- -------------------------------------------------------------
-- Pegá y ejecutá TODO este script en el SQL Editor de Supabase.
-- (Project → SQL Editor → New query → Run)
--
-- Crea:
--   - tablas: teams, matches, players, predictions, app_settings
--   - vistas: leaderboard, matches_full, players_public
--   - funciones RPC: register, login, place_prediction y admin_*
--   - trigger: recálculo automático de puntos al cargar resultados
--   - seed: 48 equipos clasificados al Mundial 2026 (sorteo
--           oficial FIFA del 5/12/2025) + 12 partidos de apertura
--   - admin secret hardcoded: "Prode2026" (modificable en app_settings)
--
-- Lógica de puntos por partido:
--   - Acertar el ganador (o empate)         → 3 puntos
--   - Acertar exacto goles del local         → 1 punto extra
--   - Acertar exacto goles del visitante     → 1 punto extra
--   (máximo posible: 5 puntos)
--
-- Bloqueo de predicciones: 1 hora antes del start_time del partido.
-- =============================================================

-- ============ EXTENSIONES ============
-- pgcrypto se usa para hashear contraseñas (crypt + gen_salt).
-- En Supabase ya viene instalada en el schema "extensions".
-- Si no estuviera, este create la instala. Si ya existe, no hace nada.
create extension if not exists pgcrypto with schema extensions;

-- ============ LIMPIEZA OPCIONAL ============
-- Descomentar si querés re-crear todo de cero
-- drop view  if exists leaderboard cascade;
-- drop view  if exists matches_full cascade;
-- drop view  if exists players_public cascade;
-- drop view  if exists match_predictions_stats cascade;
-- drop table if exists predictions cascade;
-- drop table if exists matches cascade;
-- drop table if exists players cascade;
-- drop table if exists teams cascade;
-- drop table if exists app_settings cascade;

-- =============================================================
-- TABLAS
-- =============================================================

create table if not exists public.teams (
  id           smallint primary key,
  name         text not null,
  country_code text not null,        -- ISO 3166-1 alpha-2 (lowercase). Para banderas.
  group_letter char(1)               -- A, B, C, ... (opcional)
);

create table if not exists public.matches (
  id            uuid primary key default gen_random_uuid(),
  home_team_id  smallint not null references public.teams(id),
  away_team_id  smallint not null references public.teams(id),
  start_time    timestamptz not null,
  phase         text not null default 'group',
  -- phases: 'group', 'r32', 'r16', 'qf', 'sf', 'tp' (3er puesto), 'final'
  home_goals    smallint,
  away_goals    smallint,
  finished      boolean not null default false,
  bracket_slot  text,                -- ej: 'QF1', 'SF2', etc. (para vista de llaves)
  created_at    timestamptz default now(),
  constraint matches_diff_teams check (home_team_id <> away_team_id),
  constraint matches_phase_ok   check (phase in ('group','r32','r16','qf','sf','tp','final')),
  constraint matches_goals_pair check ((home_goals is null) = (away_goals is null)),
  constraint matches_goals_range check (
    (home_goals is null or home_goals between 0 and 30) and
    (away_goals is null or away_goals between 0 and 30)
  )
);

create index if not exists matches_start_idx on public.matches (start_time);
create index if not exists matches_phase_idx on public.matches (phase);

create table if not exists public.players (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  password_hash text not null,
  auth_token    uuid not null default gen_random_uuid(),
  is_admin      boolean not null default false,
  created_at    timestamptz default now(),
  constraint players_name_len check (char_length(trim(name)) between 2 and 30)
);

create table if not exists public.predictions (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references public.players(id) on delete cascade,
  match_id    uuid not null references public.matches(id) on delete cascade,
  home_goals  smallint not null,
  away_goals  smallint not null,
  points      int not null default 0,
  updated_at  timestamptz not null default now(),
  unique (player_id, match_id),
  check (home_goals between 0 and 30),
  check (away_goals between 0 and 30)
);

create index if not exists pred_match_idx  on public.predictions (match_id);
create index if not exists pred_player_idx on public.predictions (player_id);

create table if not exists public.app_settings (
  key   text primary key,
  value text not null
);

insert into public.app_settings (key, value)
values ('admin_secret', 'Prode2026')
on conflict (key) do nothing;

-- =============================================================
-- FUNCIONES INTERNAS
-- =============================================================

-- Cálculo de puntos
create or replace function public.calc_points(
  p_home_pred int, p_away_pred int,
  p_home_real int, p_away_real int
) returns int
language sql immutable as $$
  select case
    when p_home_real is null or p_away_real is null then 0
    else
      (case when sign(p_home_pred - p_away_pred) = sign(p_home_real - p_away_real) then 3 else 0 end)
      + (case when p_home_pred = p_home_real then 1 else 0 end)
      + (case when p_away_pred = p_away_real then 1 else 0 end)
  end;
$$;

-- Trigger: cuando se actualizan los goles de un partido, recalcular puntos
create or replace function public.trg_recalc_match() returns trigger
language plpgsql as $$
begin
  if (new.home_goals is distinct from old.home_goals)
     or (new.away_goals is distinct from old.away_goals) then
    update public.predictions
      set points = public.calc_points(home_goals, away_goals, new.home_goals, new.away_goals)
      where match_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists matches_recalc on public.matches;
create trigger matches_recalc
  after update on public.matches
  for each row execute function public.trg_recalc_match();

-- Validación de token de jugador
create or replace function public._validate_token(p_player_id uuid, p_token uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  select auth_token into v from public.players where id = p_player_id;
  if v is null or v <> p_token then
    raise exception 'Sesión inválida. Cerrá y volvé a entrar.';
  end if;
end;
$$;

-- Validación de admin
create or replace function public._validate_admin(p_secret text)
returns void language plpgsql security definer set search_path = public as $$
declare v_secret text;
begin
  select value into v_secret from public.app_settings where key = 'admin_secret';
  if p_secret is null or v_secret <> p_secret then
    raise exception 'Acceso de administrador denegado';
  end if;
end;
$$;

-- =============================================================
-- AUTH RPCS
-- =============================================================

-- Registrar nuevo jugador
create or replace function public.register(p_name text, p_password text)
returns table(id uuid, name text, auth_token uuid, is_admin boolean)
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_token uuid; v_clean text;
begin
  v_clean := trim(p_name);
  if char_length(v_clean) < 2 then raise exception 'El nombre debe tener al menos 2 caracteres'; end if;
  if char_length(v_clean) > 30 then raise exception 'El nombre es demasiado largo (máx 30)'; end if;
  if char_length(p_password) < 4 then raise exception 'La contraseña debe tener al menos 4 caracteres'; end if;

  begin
    insert into public.players (name, password_hash)
    values (v_clean, extensions.crypt(p_password, extensions.gen_salt('bf', 8)))
    returning players.id, players.auth_token into v_id, v_token;
  exception when unique_violation then
    raise exception 'Ya existe un jugador con ese nombre';
  end;

  return query select v_id, v_clean, v_token, false;
end;
$$;

grant execute on function public.register(text, text) to anon, authenticated;

-- Login
create or replace function public.login(p_name text, p_password text)
returns table(id uuid, name text, auth_token uuid, is_admin boolean)
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_hash text; v_token uuid; v_admin boolean; v_name text;
begin
  select pl.id, pl.password_hash, pl.auth_token, pl.is_admin, pl.name
    into v_id, v_hash, v_token, v_admin, v_name
    from public.players pl where pl.name = trim(p_name);

  if v_id is null or v_hash <> extensions.crypt(p_password, v_hash) then
    raise exception 'Usuario o contraseña incorrectos';
  end if;

  return query select v_id, v_name, v_token, v_admin;
end;
$$;

grant execute on function public.login(text, text) to anon, authenticated;

-- Cargar / actualizar predicción (validando bloqueo 1h y dueño)
create or replace function public.place_prediction(
  p_player_id uuid, p_token uuid,
  p_match_id  uuid,
  p_home int, p_away int
) returns public.predictions
language plpgsql security definer set search_path = public as $$
declare v_match public.matches; v_row public.predictions;
begin
  perform public._validate_token(p_player_id, p_token);

  select * into v_match from public.matches where id = p_match_id;
  if v_match.id is null then raise exception 'Partido no encontrado'; end if;

  if v_match.finished then
    raise exception 'El partido ya terminó, no podés modificar la predicción';
  end if;

  if now() >= v_match.start_time - interval '1 hour' then
    raise exception 'Las predicciones cierran 1 hora antes del inicio del partido';
  end if;

  if p_home is null or p_away is null
     or p_home < 0 or p_home > 30
     or p_away < 0 or p_away > 30 then
    raise exception 'Los goles deben estar entre 0 y 30';
  end if;

  insert into public.predictions (player_id, match_id, home_goals, away_goals)
  values (p_player_id, p_match_id, p_home, p_away)
  on conflict (player_id, match_id) do update
    set home_goals = excluded.home_goals,
        away_goals = excluded.away_goals,
        updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.place_prediction(uuid, uuid, uuid, int, int) to anon, authenticated;

-- =============================================================
-- ADMIN RPCS
-- =============================================================

create or replace function public.admin_set_match_result(
  p_secret text,
  p_match_id uuid,
  p_home int, p_away int
) returns public.matches
language plpgsql security definer set search_path = public as $$
declare v_row public.matches;
begin
  perform public._validate_admin(p_secret);

  if p_home is not null and (p_home < 0 or p_home > 30) then raise exception 'Goles inválidos'; end if;
  if p_away is not null and (p_away < 0 or p_away > 30) then raise exception 'Goles inválidos'; end if;

  update public.matches
    set home_goals = p_home,
        away_goals = p_away,
        finished   = (p_home is not null and p_away is not null)
    where id = p_match_id
    returning * into v_row;

  if v_row.id is null then raise exception 'Partido no encontrado'; end if;
  return v_row;
end;
$$;

grant execute on function public.admin_set_match_result(text, uuid, int, int) to anon, authenticated;

create or replace function public.admin_create_match(
  p_secret      text,
  p_home_team   smallint,
  p_away_team   smallint,
  p_start       timestamptz,
  p_phase       text,
  p_bracket_slot text default null
) returns public.matches
language plpgsql security definer set search_path = public as $$
declare v_row public.matches;
begin
  perform public._validate_admin(p_secret);
  insert into public.matches (home_team_id, away_team_id, start_time, phase, bracket_slot)
  values (p_home_team, p_away_team, p_start, p_phase, p_bracket_slot)
  returning * into v_row;
  return v_row;
end;
$$;

grant execute on function public.admin_create_match(text, smallint, smallint, timestamptz, text, text) to anon, authenticated;

create or replace function public.admin_delete_match(p_secret text, p_match_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._validate_admin(p_secret);
  delete from public.matches where id = p_match_id;
end;
$$;

grant execute on function public.admin_delete_match(text, uuid) to anon, authenticated;

create or replace function public.admin_recalc_all(p_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._validate_admin(p_secret);
  update public.predictions p
    set points = public.calc_points(p.home_goals, p.away_goals, m.home_goals, m.away_goals)
    from public.matches m
    where p.match_id = m.id;
end;
$$;

grant execute on function public.admin_recalc_all(text) to anon, authenticated;

create or replace function public.admin_create_team(
  p_secret text, p_id smallint, p_name text, p_country_code text, p_group char default null
) returns public.teams
language plpgsql security definer set search_path = public as $$
declare v_row public.teams;
begin
  perform public._validate_admin(p_secret);
  insert into public.teams (id, name, country_code, group_letter)
  values (p_id, p_name, lower(p_country_code), p_group)
  on conflict (id) do update set
    name = excluded.name,
    country_code = excluded.country_code,
    group_letter = excluded.group_letter
  returning * into v_row;
  return v_row;
end;
$$;

grant execute on function public.admin_create_team(text, smallint, text, text, char) to anon, authenticated;

-- =============================================================
-- VISTAS
-- =============================================================

-- Vista pública de jugadores (sin password ni token)
create or replace view public.players_public as
  select id, name, is_admin, created_at from public.players;

grant select on public.players_public to anon, authenticated;

-- Stats de predicciones por partido (helper interno)
create or replace view public.match_predictions_stats as
  select
    match_id,
    count(*)::int                                  as total,
    count(*) filter (where points = 5)::int        as exact_count,
    count(*) filter (where points >= 3)::int       as winner_count
  from public.predictions
  group by match_id;

grant select on public.match_predictions_stats to anon, authenticated;

-- Vista enriquecida de partidos
create or replace view public.matches_full as
  select
    m.id, m.start_time, m.phase, m.home_goals, m.away_goals,
    m.finished, m.bracket_slot, m.created_at,
    m.home_team_id, ht.name as home_name, ht.country_code as home_cc, ht.group_letter as home_group,
    m.away_team_id, at.name as away_name, at.country_code as away_cc, at.group_letter as away_group,
    coalesce(s.total, 0)        as predictions_count,
    coalesce(s.exact_count, 0)  as exact_count,
    coalesce(s.winner_count, 0) as winner_count,
    -- "mood": 'fire' = batacazo (pocos acertaron), 'ice' = predecible (casi todos acertaron)
    case
      when m.finished and coalesce(s.total, 0) >= 3
        and (s.winner_count::float / nullif(s.total, 0)::float) < 0.20 then 'fire'
      when m.finished and coalesce(s.total, 0) >= 3
        and (s.winner_count::float / nullif(s.total, 0)::float) > 0.80 then 'ice'
      else null
    end as mood
  from public.matches m
  join public.teams ht on ht.id = m.home_team_id
  join public.teams at on at.id = m.away_team_id
  left join public.match_predictions_stats s on s.match_id = m.id;

grant select on public.matches_full to anon, authenticated;

-- Leaderboard
create or replace view public.leaderboard as
  select
    p.id,
    p.name,
    coalesce(sum(case when m.finished then pr.points end), 0)::int          as total_points,
    count(pr.id)::int                                                       as predictions_count,
    count(*) filter (where m.finished)::int                                 as scored_count,
    count(*) filter (where m.finished and pr.points = 5)::int               as exact_count,
    count(*) filter (where m.finished and pr.points >= 3)::int              as winner_count
  from public.players p
  left join public.predictions pr on pr.player_id = p.id
  left join public.matches m      on m.id = pr.match_id
  group by p.id, p.name
  order by total_points desc, p.name asc;

grant select on public.leaderboard to anon, authenticated;

-- =============================================================
-- ROW LEVEL SECURITY
-- =============================================================

alter table public.teams        enable row level security;
alter table public.matches      enable row level security;
alter table public.predictions  enable row level security;
alter table public.players      enable row level security;
alter table public.app_settings enable row level security;

-- Lectura abierta a teams, matches y predictions
drop policy if exists teams_read       on public.teams;
drop policy if exists matches_read     on public.matches;
drop policy if exists predictions_read on public.predictions;

create policy teams_read       on public.teams       for select to anon, authenticated using (true);
create policy matches_read     on public.matches     for select to anon, authenticated using (true);
create policy predictions_read on public.predictions for select to anon, authenticated using (true);

-- players y app_settings: SIN policies → solo accesibles vía RPC (security definer)

-- =============================================================
-- REALTIME
-- =============================================================

-- Detectar si la tabla ya está en la publication antes de agregarla
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'matches'
  ) then
    alter publication supabase_realtime add table public.matches;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'predictions'
  ) then
    alter publication supabase_realtime add table public.predictions;
  end if;
exception when others then null;
end $$;

-- =============================================================
-- SEED: 48 equipos clasificados al Mundial 2026 + partidos
-- -------------------------------------------------------------
-- Fuente: Sorteo oficial FIFA del 5 de diciembre de 2025 en
-- Washington D.C. El Mundial 2026 se juega del 11 de junio al
-- 19 de julio en USA, México y Canadá, con 48 equipos divididos
-- en 12 grupos de 4 (A-L).
--
-- Country codes ISO 3166-1 alpha-2 (lowercase). Para Inglaterra
-- y Escocia se usan los códigos extendidos 'gb-eng' y 'gb-sct'
-- soportados por flagcdn.com.
--
-- ⚠️ Si ya corriste una versión ANTERIOR del schema con los seed
-- viejos (32 equipos / partidos relativos a hoy), descomentá este
-- bloque para limpiar partidos y equipos antes de re-sembrar:
--
-- delete from public.predictions;
-- delete from public.matches;
-- delete from public.teams;
-- =============================================================

insert into public.teams (id, name, country_code, group_letter) values
  -- Grupo A
  ( 1, 'México',                'mx',     'A'),
  ( 2, 'Sudáfrica',             'za',     'A'),
  ( 3, 'Corea del Sur',         'kr',     'A'),
  ( 4, 'Chequia',               'cz',     'A'),
  -- Grupo B
  ( 5, 'Canadá',                'ca',     'B'),
  ( 6, 'Bosnia y Herzegovina',  'ba',     'B'),
  ( 7, 'Qatar',                 'qa',     'B'),
  ( 8, 'Suiza',                 'ch',     'B'),
  -- Grupo C
  ( 9, 'Brasil',                'br',     'C'),
  (10, 'Marruecos',             'ma',     'C'),
  (11, 'Haití',                 'ht',     'C'),
  (12, 'Escocia',               'gb-sct', 'C'),
  -- Grupo D
  (13, 'Estados Unidos',        'us',     'D'),
  (14, 'Paraguay',              'py',     'D'),
  (15, 'Australia',             'au',     'D'),
  (16, 'Turquía',               'tr',     'D'),
  -- Grupo E
  (17, 'Alemania',              'de',     'E'),
  (18, 'Curazao',               'cw',     'E'),
  (19, 'Costa de Marfil',       'ci',     'E'),
  (20, 'Ecuador',               'ec',     'E'),
  -- Grupo F
  (21, 'Países Bajos',          'nl',     'F'),
  (22, 'Japón',                 'jp',     'F'),
  (23, 'Suecia',                'se',     'F'),
  (24, 'Túnez',                 'tn',     'F'),
  -- Grupo G
  (25, 'Bélgica',               'be',     'G'),
  (26, 'Egipto',                'eg',     'G'),
  (27, 'Irán',                  'ir',     'G'),
  (28, 'Nueva Zelanda',         'nz',     'G'),
  -- Grupo H
  (29, 'España',                'es',     'H'),
  (30, 'Cabo Verde',            'cv',     'H'),
  (31, 'Arabia Saudita',        'sa',     'H'),
  (32, 'Uruguay',               'uy',     'H'),
  -- Grupo I
  (33, 'Francia',               'fr',     'I'),
  (34, 'Senegal',               'sn',     'I'),
  (35, 'Noruega',               'no',     'I'),
  (36, 'Irak',                  'iq',     'I'),
  -- Grupo J
  (37, 'Argentina',             'ar',     'J'),
  (38, 'Argelia',               'dz',     'J'),
  (39, 'Austria',               'at',     'J'),
  (40, 'Jordania',              'jo',     'J'),
  -- Grupo K
  (41, 'Portugal',              'pt',     'K'),
  (42, 'RD del Congo',          'cd',     'K'),
  (43, 'Uzbekistán',            'uz',     'K'),
  (44, 'Colombia',              'co',     'K'),
  -- Grupo L
  (45, 'Inglaterra',            'gb-eng', 'L'),
  (46, 'Croacia',               'hr',     'L'),
  (47, 'Ghana',                 'gh',     'L'),
  (48, 'Panamá',                'pa',     'L')
on conflict (id) do update set
  name         = excluded.name,
  country_code = excluded.country_code,
  group_letter = excluded.group_letter;

-- Partidos de apertura: 1 por grupo (12 partidos), del 11 al 17 de junio 2026.
-- Las horas son aproximadas (en UTC). El admin puede editarlas / agregar más.
-- México vs Sudáfrica abre el torneo en el Estadio Azteca el 11/06.
insert into public.matches (home_team_id, away_team_id, start_time, phase) values
  -- Grupo A (apertura)
  ( 1,  2, '2026-06-11 19:00:00+00', 'group'),  -- México - Sudáfrica
  -- Grupo B
  ( 5,  8, '2026-06-12 19:00:00+00', 'group'),  -- Canadá - Suiza
  -- Grupo C
  ( 9, 10, '2026-06-13 22:00:00+00', 'group'),  -- Brasil - Marruecos
  -- Grupo D
  (13, 16, '2026-06-12 22:00:00+00', 'group'),  -- USA - Turquía
  -- Grupo E
  (17, 18, '2026-06-14 19:00:00+00', 'group'),  -- Alemania - Curazao
  -- Grupo F
  (21, 22, '2026-06-13 19:00:00+00', 'group'),  -- Países Bajos - Japón
  -- Grupo G
  (25, 26, '2026-06-14 22:00:00+00', 'group'),  -- Bélgica - Egipto
  -- Grupo H
  (29, 30, '2026-06-15 19:00:00+00', 'group'),  -- España - Cabo Verde
  -- Grupo I
  (33, 34, '2026-06-15 22:00:00+00', 'group'),  -- Francia - Senegal
  -- Grupo J
  (37, 38, '2026-06-16 19:00:00+00', 'group'),  -- Argentina - Argelia
  -- Grupo K
  (41, 42, '2026-06-16 22:00:00+00', 'group'),  -- Portugal - RD del Congo
  -- Grupo L
  (45, 46, '2026-06-17 19:00:00+00', 'group')   -- Inglaterra - Croacia
on conflict do nothing;

-- =============================================================
-- LISTO. Verificá:
--   1. Table Editor → tienen que aparecer las 5 tablas.
--   2. Database → Functions → tienen que aparecer las RPC.
--   3. Database → Replication → activá realtime para matches y predictions
--      si no quedó automático.
--
-- Para cambiar el password de admin:
--   update public.app_settings set value = 'OtroPassword' where key = 'admin_secret';
--
-- Para vaciar todo (cuidado):
--   truncate predictions, matches, players restart identity cascade;
-- =============================================================
