-- =============================================================
-- Schema: TURNERO uniq+ (salón de belleza)
-- -------------------------------------------------------------
-- Pegá y ejecutá TODO este script en el SQL Editor de Supabase.
-- (Project → SQL Editor → New query → Run)
--
-- Nota sobre los nombres:
--   PostgreSQL convierte los identificadores no-quoted a minúsculas.
--   Para mantener tablas fáciles de identificar pero sin tener que
--   escribir comillas dobles en cada query, usamos el prefijo
--   "turnero_" en minúsculas. Cuando filtres en el Table Editor de
--   Supabase, todas aparecen agrupadas como turnero_*.
--
-- Crea:
--   - tablas: turnero_servicios, turnero_turnos, turnero_settings
--   - RLS: lectura de servicios pública, todo lo demás solo via RPC
--   - RPCs públicos: obtener_turnos_dia, reservar_turno
--   - RPCs admin (con secret): admin_listar_turnos, admin_cancelar_turno,
--                              admin_actualizar_turno, admin_actualizar_servicio,
--                              admin_set_password, admin_ping
--   - Admin secret hardcoded inicial: "admin"  (cámbialo desde el panel)
-- =============================================================

-- ============ EXTENSIONES ============
create extension if not exists pgcrypto with schema extensions;

-- =============================================================
-- TABLAS
-- =============================================================

-- Catálogo de servicios (pelo, masajes, manicura, etc.)
create table if not exists public.turnero_servicios (
  id           text primary key,                 -- 'pelo', 'masajes', 'manicura'
  nombre       text not null,
  emoji        text not null default '✨',
  descripcion  text,
  duracion_min int not null check (duracion_min between 5 and 480),
  capacidad    int not null default 1 check (capacidad between 1 and 20),
  precio_min   int,
  precio_max   int,
  activo       bool not null default true,
  orden        int  not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Turnos reservados
create table if not exists public.turnero_turnos (
  id                uuid primary key default gen_random_uuid(),
  servicio_id       text not null references public.turnero_servicios(id) on delete restrict,
  cliente_nombre    text not null check (char_length(trim(cliente_nombre)) between 2 and 80),
  cliente_telefono  text,
  cliente_email     text,
  fecha             date not null,
  hora_inicio       time not null,
  hora_fin          time not null,
  notas             text,
  cancelado         bool not null default false,
  cancelado_motivo  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint turnero_turnos_horas_chk check (hora_fin > hora_inicio)
);

create index if not exists turnero_turnos_fecha_idx
  on public.turnero_turnos(fecha) where not cancelado;
create index if not exists turnero_turnos_servicio_fecha_idx
  on public.turnero_turnos(servicio_id, fecha) where not cancelado;

-- Settings genéricos (admin secret, horarios de atención, etc.)
create table if not exists public.turnero_settings (
  key   text primary key,
  value text not null
);

-- =============================================================
-- DATOS INICIALES
-- =============================================================
insert into public.turnero_settings(key, value) values
  ('admin_secret',     'admin'),
  ('horario_apertura', '09:00'),  -- legacy (fallback)
  ('horario_cierre',   '20:00'),  -- legacy (fallback)
  ('horarios_semana',  '{"lun":{"abierto":true,"apertura":"09:00","cierre":"20:00"},"mar":{"abierto":true,"apertura":"09:00","cierre":"20:00"},"mie":{"abierto":true,"apertura":"09:00","cierre":"20:00"},"jue":{"abierto":true,"apertura":"09:00","cierre":"20:00"},"vie":{"abierto":true,"apertura":"09:00","cierre":"20:00"},"sab":{"abierto":true,"apertura":"10:00","cierre":"18:00"},"dom":{"abierto":false,"apertura":"09:00","cierre":"20:00"}}'),
  ('contacto',         '{"direccion":"Av. Siempreviva 742, Ciudad","telefono":"+54 11 5555 5555","wa_numero":"5491155555555","email":"hola@uniqpositivo.com","instagram":"","facebook":"","tiktok":"","mapa_query":"Av. Siempreviva 742, Ciudad"}')
on conflict (key) do nothing;

insert into public.turnero_servicios
  (id, nombre, emoji, descripcion, duracion_min, capacidad, precio_min, precio_max, orden)
values
  ('pelo',     'Corte y peinado',    '✂️',  'Corte profesional, lavado y peinado.',                  180, 3, 8000,  18000, 1),
  ('masajes',  'Masajes',            '💆',  'Sesiones descontracturantes o relax de cuerpo entero.', 60,  1, 12000, 22000, 2),
  ('manicura', 'Manicura',           '💅',  'Manicura, esmaltado tradicional o semipermanente.',     45,  1, 6000,  11000, 3)
on conflict (id) do update set
  nombre       = excluded.nombre,
  emoji        = excluded.emoji,
  descripcion  = excluded.descripcion,
  -- duracion/capacidad NO los pisamos para que el admin pueda cambiarlos
  -- desde el panel y este script sea idempotente sin sobre-escribir.
  precio_min   = coalesce(excluded.precio_min, public.turnero_servicios.precio_min),
  precio_max   = coalesce(excluded.precio_max, public.turnero_servicios.precio_max),
  orden        = excluded.orden;

-- =============================================================
-- TRIGGERS: updated_at automático
-- =============================================================
create or replace function public.turnero_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists turnero_servicios_touch on public.turnero_servicios;
create trigger turnero_servicios_touch
  before update on public.turnero_servicios
  for each row execute function public.turnero_touch_updated_at();

drop trigger if exists turnero_turnos_touch on public.turnero_turnos;
create trigger turnero_turnos_touch
  before update on public.turnero_turnos
  for each row execute function public.turnero_touch_updated_at();

-- =============================================================
-- HELPER: día de la semana → key corta (lun, mar, ...)
-- =============================================================
create or replace function public._turnero_dia_key(p_fecha date)
returns text language sql immutable as $$
  select case extract(dow from p_fecha)::int
    when 0 then 'dom' when 1 then 'lun' when 2 then 'mar' when 3 then 'mie'
    when 4 then 'jue' when 5 then 'vie' when 6 then 'sab' end;
$$;

-- =============================================================
-- HELPER: validar admin
-- =============================================================
create or replace function public._turnero_validate_admin(p_secret text)
returns void language plpgsql security definer set search_path = public as $$
declare v_secret text;
begin
  select value into v_secret from public.turnero_settings where key = 'admin_secret';
  if v_secret is null then
    raise exception 'Admin secret no configurado';
  end if;
  if p_secret is null or p_secret <> v_secret then
    raise exception 'Credenciales admin inválidas';
  end if;
end;
$$;

-- =============================================================
-- RLS
-- =============================================================
alter table public.turnero_servicios enable row level security;
alter table public.turnero_turnos    enable row level security;
alter table public.turnero_settings  enable row level security;

-- Servicios: cualquiera (incluso anon) puede leer los activos
drop policy if exists turnero_servicios_read on public.turnero_servicios;
create policy turnero_servicios_read
  on public.turnero_servicios for select
  using (activo);

-- Turnos: NO se permite acceso directo (todo via RPCs).
-- (No agregamos policies → SELECT/INSERT/UPDATE/DELETE quedan bloqueados)

-- Settings: NO se permite acceso directo (todo via RPCs).

-- =============================================================
-- RPC público: obtener configuración pública (horarios + contacto)
-- Devuelve dos JSON: horarios de la semana y datos de contacto.
-- =============================================================
create or replace function public.obtener_config_publica()
returns table(horarios_semana jsonb, contacto jsonb)
language sql stable security definer set search_path = public as $$
  select
    coalesce((select value::jsonb from public.turnero_settings where key = 'horarios_semana'),
             '{}'::jsonb) as horarios_semana,
    coalesce((select value::jsonb from public.turnero_settings where key = 'contacto'),
             '{}'::jsonb) as contacto;
$$;

grant execute on function public.obtener_config_publica() to anon, authenticated;

-- =============================================================
-- RPC: obtener turnos del día (público, sin datos personales)
-- Devuelve solo hora_inicio, hora_fin y servicio_id de turnos no
-- cancelados para que el frontend calcule slots disponibles.
-- =============================================================
create or replace function public.obtener_turnos_dia(
  p_fecha date,
  p_servicio_id text default null
) returns table(servicio_id text, hora_inicio time, hora_fin time)
language sql stable security definer set search_path = public as $$
  select t.servicio_id, t.hora_inicio, t.hora_fin
    from public.turnero_turnos t
   where t.fecha = p_fecha
     and not t.cancelado
     and (p_servicio_id is null or t.servicio_id = p_servicio_id);
$$;

grant execute on function public.obtener_turnos_dia(date, text) to anon, authenticated;

-- =============================================================
-- RPC: reservar turno (público, no requiere login)
-- Valida capacidad por solapamiento de horarios y crea el turno.
-- =============================================================
create or replace function public.reservar_turno(
  p_servicio_id     text,
  p_cliente_nombre  text,
  p_cliente_tel     text,
  p_cliente_email   text,
  p_fecha           date,
  p_hora_inicio     time,
  p_notas           text default null
) returns public.turnero_turnos
language plpgsql security definer set search_path = public as $$
declare
  v_serv  public.turnero_servicios;
  v_fin   time;
  v_count int;
  v_today date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  v_now   time := (now() at time zone 'America/Argentina/Buenos_Aires')::time;
  v_ret   public.turnero_turnos;
begin
  -- Validaciones básicas
  if p_servicio_id is null then raise exception 'Servicio requerido'; end if;
  if p_cliente_nombre is null or char_length(trim(p_cliente_nombre)) < 2 then
    raise exception 'Nombre del cliente requerido (mínimo 2 caracteres)';
  end if;
  if p_fecha is null or p_hora_inicio is null then
    raise exception 'Fecha y hora requeridas';
  end if;
  if p_fecha < v_today then
    raise exception 'No se pueden reservar turnos en fechas pasadas';
  end if;
  if p_fecha = v_today and p_hora_inicio <= v_now then
    raise exception 'No se pueden reservar turnos en horarios que ya pasaron';
  end if;

  -- Servicio
  select * into v_serv from public.turnero_servicios where id = p_servicio_id and activo;
  if not found then
    raise exception 'Servicio no encontrado o inactivo';
  end if;

  v_fin := (p_hora_inicio + (v_serv.duracion_min * interval '1 minute'))::time;

  -- Validar contra horario del día de la semana (config en horarios_semana)
  -- Fallback a settings legacy (horario_apertura/cierre) si no está configurado.
  declare
    v_dia_key  text := public._turnero_dia_key(p_fecha);
    v_dia_cfg  jsonb;
    v_apertura time;
    v_cierre   time;
  begin
    select (value::jsonb) -> v_dia_key into v_dia_cfg
      from public.turnero_settings where key = 'horarios_semana';

    if v_dia_cfg is not null then
      if not coalesce((v_dia_cfg->>'abierto')::bool, false) then
        raise exception 'El salón está cerrado ese día de la semana';
      end if;
      v_apertura := coalesce(nullif(v_dia_cfg->>'apertura','')::time, '09:00'::time);
      v_cierre   := coalesce(nullif(v_dia_cfg->>'cierre','')::time,   '20:00'::time);
    else
      select value::time into v_apertura from public.turnero_settings where key = 'horario_apertura';
      select value::time into v_cierre   from public.turnero_settings where key = 'horario_cierre';
      if v_apertura is null then v_apertura := '09:00'; end if;
      if v_cierre   is null then v_cierre   := '20:00'; end if;
    end if;

    if p_hora_inicio < v_apertura or v_fin > v_cierre then
      raise exception 'El turno debe estar entre % y % para ese día', v_apertura, v_cierre;
    end if;
  end;

  -- Validar capacidad: contar turnos del mismo servicio que se solapan
  select count(*) into v_count
    from public.turnero_turnos t
   where t.servicio_id = p_servicio_id
     and t.fecha       = p_fecha
     and not t.cancelado
     and tsrange(
            (p_fecha + t.hora_inicio)::timestamp,
            (p_fecha + t.hora_fin)::timestamp,
            '[)') &&
         tsrange(
            (p_fecha + p_hora_inicio)::timestamp,
            (p_fecha + v_fin)::timestamp,
            '[)');

  if v_count >= v_serv.capacidad then
    raise exception 'No hay disponibilidad: ya hay % turno(s) en ese horario (capacidad máx: %)', v_count, v_serv.capacidad;
  end if;

  -- Crear turno
  insert into public.turnero_turnos
    (servicio_id, cliente_nombre, cliente_telefono, cliente_email, fecha, hora_inicio, hora_fin, notas)
  values
    (p_servicio_id, trim(p_cliente_nombre), nullif(trim(coalesce(p_cliente_tel,'')),''), nullif(trim(coalesce(p_cliente_email,'')),''),
     p_fecha, p_hora_inicio, v_fin, nullif(trim(coalesce(p_notas,'')),''))
  returning * into v_ret;

  return v_ret;
end;
$$;

grant execute on function public.reservar_turno(text, text, text, text, date, time, text) to anon, authenticated;

-- =============================================================
-- RPC ADMIN: listar turnos de un día (con datos personales)
-- =============================================================
create or replace function public.admin_listar_turnos(
  p_secret text,
  p_fecha  date
) returns setof public.turnero_turnos
language plpgsql security definer set search_path = public as $$
begin
  perform public._turnero_validate_admin(p_secret);
  return query
    select * from public.turnero_turnos
     where fecha = p_fecha
     order by hora_inicio, created_at;
end;
$$;

grant execute on function public.admin_listar_turnos(text, date) to anon, authenticated;

-- =============================================================
-- RPC ADMIN: cancelar turno
-- =============================================================
create or replace function public.admin_cancelar_turno(
  p_secret text,
  p_id     uuid,
  p_motivo text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._turnero_validate_admin(p_secret);
  update public.turnero_turnos
     set cancelado = true,
         cancelado_motivo = p_motivo
   where id = p_id;
  if not found then raise exception 'Turno no encontrado'; end if;
end;
$$;

grant execute on function public.admin_cancelar_turno(text, uuid, text) to anon, authenticated;

-- =============================================================
-- RPC ADMIN: modificar turno (cliente, fecha, hora, notas, recapitalizar fin)
-- =============================================================
create or replace function public.admin_actualizar_turno(
  p_secret          text,
  p_id              uuid,
  p_cliente_nombre  text,
  p_cliente_tel     text,
  p_cliente_email   text,
  p_fecha           date,
  p_hora_inicio     time,
  p_notas           text default null
) returns public.turnero_turnos
language plpgsql security definer set search_path = public as $$
declare
  v_turno public.turnero_turnos;
  v_serv  public.turnero_servicios;
  v_fin   time;
  v_count int;
  v_ret   public.turnero_turnos;
begin
  perform public._turnero_validate_admin(p_secret);

  select * into v_turno from public.turnero_turnos where id = p_id;
  if not found then raise exception 'Turno no encontrado'; end if;

  select * into v_serv from public.turnero_servicios where id = v_turno.servicio_id;
  if not found then raise exception 'Servicio del turno no encontrado'; end if;

  v_fin := (p_hora_inicio + (v_serv.duracion_min * interval '1 minute'))::time;

  -- Re-validar capacidad excluyendo el propio turno
  select count(*) into v_count
    from public.turnero_turnos t
   where t.servicio_id = v_turno.servicio_id
     and t.fecha       = p_fecha
     and not t.cancelado
     and t.id <> p_id
     and tsrange(
            (p_fecha + t.hora_inicio)::timestamp,
            (p_fecha + t.hora_fin)::timestamp,
            '[)') &&
         tsrange(
            (p_fecha + p_hora_inicio)::timestamp,
            (p_fecha + v_fin)::timestamp,
            '[)');
  if v_count >= v_serv.capacidad then
    raise exception 'No hay disponibilidad en el nuevo horario';
  end if;

  update public.turnero_turnos
     set cliente_nombre   = trim(p_cliente_nombre),
         cliente_telefono = nullif(trim(coalesce(p_cliente_tel,'')),''),
         cliente_email    = nullif(trim(coalesce(p_cliente_email,'')),''),
         fecha            = p_fecha,
         hora_inicio      = p_hora_inicio,
         hora_fin         = v_fin,
         notas            = nullif(trim(coalesce(p_notas,'')),'')
   where id = p_id
   returning * into v_ret;

  return v_ret;
end;
$$;

grant execute on function public.admin_actualizar_turno(text, uuid, text, text, text, date, time, text) to anon, authenticated;

-- =============================================================
-- RPC ADMIN: actualizar configuración de un servicio
-- (duración, capacidad, descripción, precios, etc.)
-- =============================================================
create or replace function public.admin_actualizar_servicio(
  p_secret       text,
  p_id           text,
  p_nombre       text,
  p_emoji        text,
  p_descripcion  text,
  p_duracion_min int,
  p_capacidad    int,
  p_precio_min   int,
  p_precio_max   int,
  p_activo       bool
) returns public.turnero_servicios
language plpgsql security definer set search_path = public as $$
declare v_ret public.turnero_servicios;
begin
  perform public._turnero_validate_admin(p_secret);

  if p_duracion_min < 5 or p_duracion_min > 480 then
    raise exception 'La duración debe estar entre 5 y 480 minutos';
  end if;
  if p_capacidad < 1 or p_capacidad > 20 then
    raise exception 'La capacidad debe estar entre 1 y 20';
  end if;

  update public.turnero_servicios
     set nombre       = coalesce(p_nombre, nombre),
         emoji        = coalesce(p_emoji, emoji),
         descripcion  = p_descripcion,
         duracion_min = p_duracion_min,
         capacidad    = p_capacidad,
         precio_min   = p_precio_min,
         precio_max   = p_precio_max,
         activo       = coalesce(p_activo, activo)
   where id = p_id
   returning * into v_ret;
  if not found then raise exception 'Servicio no encontrado'; end if;
  return v_ret;
end;
$$;

grant execute on function public.admin_actualizar_servicio(text, text, text, text, text, int, int, int, int, bool) to anon, authenticated;

-- =============================================================
-- RPC ADMIN: leer settings (horarios, etc.)
-- =============================================================
create or replace function public.admin_get_settings(p_secret text)
returns table(key text, value text)
language plpgsql security definer set search_path = public as $$
begin
  perform public._turnero_validate_admin(p_secret);
  return query select s.key, s.value from public.turnero_settings s order by s.key;
end;
$$;

grant execute on function public.admin_get_settings(text) to anon, authenticated;

-- =============================================================
-- RPC ADMIN: setear un setting genérico
-- =============================================================
create or replace function public.admin_set_setting(
  p_secret text, p_key text, p_value text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._turnero_validate_admin(p_secret);
  insert into public.turnero_settings(key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value;
end;
$$;

grant execute on function public.admin_set_setting(text, text, text) to anon, authenticated;

-- =============================================================
-- RPC ADMIN: ping (validar credenciales sin efectos)
-- =============================================================
create or replace function public.admin_turnero_ping(p_secret text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform public._turnero_validate_admin(p_secret);
  return true;
end;
$$;

grant execute on function public.admin_turnero_ping(text) to anon, authenticated;

-- =============================================================
-- LISTO. Verificá:
--   1. Table Editor → tienen que aparecer turnero_servicios,
--      turnero_turnos y turnero_settings.
--   2. SQL Editor → corré: select * from public.turnero_servicios;
--      Tienen que aparecer 3 servicios (pelo, masajes, manicura).
--   3. La página pública del turnero ya puede reservar.
--   4. La página /uniqmas/admin entra con usuario "admin" / "admin".
--      Cambiá esa contraseña desde el panel apenas puedas.
--
-- Para resetear el admin password manualmente:
--   update public.turnero_settings set value = 'tu-nuevo-pass' where key = 'admin_secret';
--
-- Para limpiar todos los turnos de prueba:
--   delete from public.turnero_turnos;
--
-- Si ya corriste este script antes y querés solo agregar los settings
-- nuevos (horarios_semana / contacto) y la función obtener_config_publica,
-- volvé a correrlo: es idempotente (uses if not exists / on conflict /
-- create or replace), no rompe los datos existentes.
-- =============================================================
