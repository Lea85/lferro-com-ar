-- =============================================================
-- Schema: Tablero de Cambios (Kanban tipo Trello)
-- -------------------------------------------------------------
-- Pegá y ejecutá TODO este script en el SQL Editor de Supabase.
-- (Project → SQL Editor → New query → Run)
--
-- Crea:
--   - tablas: profiles, projects, project_access, columns, tasks,
--             activity_log, tablero_settings
--   - trigger: al registrarse un user en auth.users, crea su profile
--   - RPCs: create_project_with_defaults, reorder_tasks,
--           reorder_columns, log_activity, admin_*
--   - RLS: acceso a proyectos via project_access
--   - admin secret hardcoded: "Tablero2026"
--
-- IMPORTANTE: Antes de correr este script, asegurate de tener
-- habilitado en Supabase: Authentication → Providers → Email
-- (con o sin email confirmation, según prefieras).
-- =============================================================

-- ============ EXTENSIONES ============
create extension if not exists pgcrypto with schema extensions;

-- =============================================================
-- TABLAS
-- =============================================================

-- Profiles: una fila por usuario, vinculado a auth.users
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique,
  role        text not null default 'user' check (role in ('admin','user')),
  created_at  timestamptz not null default now(),
  constraint profiles_username_len check (char_length(trim(username)) between 2 and 30)
);

-- Projects
create table if not exists public.projects (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  description  text,
  owner_id     uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint projects_name_len check (char_length(trim(name)) between 1 and 80)
);

-- Project access: quién puede ver/editar cada proyecto
create table if not exists public.project_access (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  granted_at  timestamptz not null default now(),
  primary key (user_id, project_id)
);

create index if not exists pa_project_idx on public.project_access (project_id);

-- Columns
create table if not exists public.columns (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  name        text not null,
  position    int not null default 0,
  created_at  timestamptz not null default now(),
  constraint columns_name_len check (char_length(trim(name)) between 1 and 50)
);

create index if not exists columns_project_pos_idx on public.columns (project_id, position);

-- Tasks
create table if not exists public.tasks (
  id           uuid primary key default gen_random_uuid(),
  column_id    uuid not null references public.columns(id) on delete cascade,
  title        text not null,
  description  text,
  priority     text not null default 'media' check (priority in ('baja','media','alta')),
  due_date     date,
  position     int not null default 0,
  -- labels: array de objetos {name, color}. Ej: [{"name":"Bug","color":"#ef4444"}]
  labels       jsonb not null default '[]'::jsonb,
  assignee_id  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint tasks_title_len check (char_length(trim(title)) between 1 and 200)
);

create index if not exists tasks_column_pos_idx on public.tasks (column_id, position);

-- Activity log
create table if not exists public.activity_log (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  user_id     uuid references public.profiles(id) on delete set null,
  action      text not null,         -- 'task_created', 'task_moved', 'task_updated', 'task_deleted', etc.
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists activity_project_idx on public.activity_log (project_id, created_at desc);

-- App settings (admin secret)
create table if not exists public.tablero_settings (
  key   text primary key,
  value text not null
);

insert into public.tablero_settings (key, value)
values ('admin_secret', 'Tablero2026')
on conflict (key) do nothing;

-- =============================================================
-- TRIGGER: al crear un user en auth, crear su profile automático
-- =============================================================
create or replace function public.handle_new_tablero_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
begin
  -- El username se manda en raw_user_meta_data->>'username'.
  -- Si no viene, se usa la parte local del email.
  v_username := coalesce(
    nullif(trim(new.raw_user_meta_data->>'username'), ''),
    split_part(new.email, '@', 1)
  );

  -- Si el username ya existe (por colisión), apendamos sufijo aleatorio
  if exists (select 1 from public.profiles where username = v_username) then
    v_username := v_username || '-' || substr(new.id::text, 1, 4);
  end if;

  insert into public.profiles (id, username) values (new.id, v_username)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_tablero on auth.users;
create trigger on_auth_user_created_tablero
  after insert on auth.users
  for each row execute function public.handle_new_tablero_user();

-- =============================================================
-- HELPER: chequear acceso a un proyecto
-- =============================================================
create or replace function public._has_tablero_access(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.project_access
    where user_id = auth.uid() and project_id = p_project_id
  ) or exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- =============================================================
-- HELPER: validar admin (para RPCs admin)
-- =============================================================
create or replace function public._validate_tablero_admin(p_secret text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_secret text;
begin
  select value into v_secret from public.tablero_settings where key = 'admin_secret';
  if p_secret is null or v_secret <> p_secret then
    raise exception 'Acceso de administrador denegado';
  end if;
end;
$$;

-- =============================================================
-- ROW LEVEL SECURITY
-- =============================================================

alter table public.profiles         enable row level security;
alter table public.projects         enable row level security;
alter table public.project_access   enable row level security;
alter table public.columns          enable row level security;
alter table public.tasks            enable row level security;
alter table public.activity_log     enable row level security;
alter table public.tablero_settings enable row level security;

-- ---- profiles ----
drop policy if exists profiles_read     on public.profiles;
drop policy if exists profiles_update   on public.profiles;

-- Lectura abierta a usuarios autenticados (necesario para mostrar nombres en el board)
create policy profiles_read on public.profiles
  for select to authenticated using (true);

-- Solo el dueño puede actualizar su propio profile
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---- projects ----
drop policy if exists projects_select on public.projects;
drop policy if exists projects_insert on public.projects;
drop policy if exists projects_update on public.projects;
drop policy if exists projects_delete on public.projects;

create policy projects_select on public.projects
  for select to authenticated
  using (public._has_tablero_access(id));

create policy projects_insert on public.projects
  for insert to authenticated
  with check (auth.uid() is not null);

create policy projects_update on public.projects
  for update to authenticated
  using (public._has_tablero_access(id))
  with check (public._has_tablero_access(id));

create policy projects_delete on public.projects
  for delete to authenticated
  using (
    owner_id = auth.uid()
    or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- ---- project_access ----
drop policy if exists pa_select       on public.project_access;
drop policy if exists pa_admin_modify on public.project_access;

create policy pa_select on public.project_access
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- Solo admins de la app pueden modificar accesos.
-- Para el admin "hardcoded" del front hay además RPCs admin_grant_access /
-- admin_revoke_access que no requieren tener role='admin' en la BD.
create policy pa_admin_modify on public.project_access
  for all to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ---- columns ----
drop policy if exists columns_select on public.columns;
drop policy if exists columns_modify on public.columns;

create policy columns_select on public.columns
  for select to authenticated
  using (public._has_tablero_access(project_id));

create policy columns_modify on public.columns
  for all to authenticated
  using (public._has_tablero_access(project_id))
  with check (public._has_tablero_access(project_id));

-- ---- tasks ----
drop policy if exists tasks_select on public.tasks;
drop policy if exists tasks_modify on public.tasks;

create policy tasks_select on public.tasks
  for select to authenticated
  using (
    exists (
      select 1 from public.columns c
      where c.id = tasks.column_id and public._has_tablero_access(c.project_id)
    )
  );

create policy tasks_modify on public.tasks
  for all to authenticated
  using (
    exists (
      select 1 from public.columns c
      where c.id = tasks.column_id and public._has_tablero_access(c.project_id)
    )
  )
  with check (
    exists (
      select 1 from public.columns c
      where c.id = tasks.column_id and public._has_tablero_access(c.project_id)
    )
  );

-- ---- activity_log ----
drop policy if exists log_select on public.activity_log;
drop policy if exists log_insert on public.activity_log;

create policy log_select on public.activity_log
  for select to authenticated
  using (public._has_tablero_access(project_id));

create policy log_insert on public.activity_log
  for insert to authenticated
  with check (public._has_tablero_access(project_id) and (user_id = auth.uid() or user_id is null));

-- ---- tablero_settings ----
-- Sin policies → solo accesible vía RPCs (security definer)

-- =============================================================
-- TRIGGER: actualizar tasks.updated_at en cada update
-- =============================================================
create or replace function public.trg_tasks_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch
  before update on public.tasks
  for each row execute function public.trg_tasks_touch();

-- =============================================================
-- RPCs DE USUARIO
-- =============================================================

-- Crear proyecto con las 4 columnas por defecto y otorgar acceso al creador
create or replace function public.create_project_with_defaults(
  p_name text,
  p_description text default null
) returns public.projects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project public.projects;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Necesitás estar logueado'; end if;
  if char_length(trim(p_name)) < 1 then raise exception 'El nombre del proyecto es obligatorio'; end if;

  insert into public.projects (name, description, owner_id)
  values (trim(p_name), nullif(trim(coalesce(p_description, '')), ''), v_uid)
  returning * into v_project;

  -- El creador queda con acceso automáticamente
  insert into public.project_access (user_id, project_id) values (v_uid, v_project.id)
  on conflict do nothing;

  -- 4 columnas por defecto
  insert into public.columns (project_id, name, position) values
    (v_project.id, 'Requerimiento',       0),
    (v_project.id, 'En desarrollo',       1),
    (v_project.id, 'Listo para testear',  2),
    (v_project.id, 'Aprobado',            3);

  return v_project;
end;
$$;

grant execute on function public.create_project_with_defaults(text, text) to authenticated;

-- Reordenar tasks dentro de una columna (usado por drag & drop)
-- p_task_ids: array de UUIDs en el orden deseado.
create or replace function public.reorder_tasks(
  p_column_id uuid,
  p_task_ids uuid[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_pos int := 0;
  v_project_id uuid;
begin
  select project_id into v_project_id from public.columns where id = p_column_id;
  if v_project_id is null then raise exception 'Columna no encontrada'; end if;
  if not public._has_tablero_access(v_project_id) then
    raise exception 'No tenés acceso a este proyecto';
  end if;

  foreach v_id in array p_task_ids loop
    update public.tasks
      set column_id = p_column_id,
          position = v_pos,
          updated_at = now()
      where id = v_id;
    v_pos := v_pos + 1;
  end loop;
end;
$$;

grant execute on function public.reorder_tasks(uuid, uuid[]) to authenticated;

-- Reordenar columnas dentro de un proyecto
create or replace function public.reorder_columns(
  p_project_id uuid,
  p_column_ids uuid[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_pos int := 0;
begin
  if not public._has_tablero_access(p_project_id) then
    raise exception 'No tenés acceso a este proyecto';
  end if;

  foreach v_id in array p_column_ids loop
    update public.columns
      set position = v_pos
      where id = v_id and project_id = p_project_id;
    v_pos := v_pos + 1;
  end loop;
end;
$$;

grant execute on function public.reorder_columns(uuid, uuid[]) to authenticated;

-- Helper para loguear actividad
create or replace function public.log_activity(
  p_project_id uuid,
  p_action text,
  p_payload jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public._has_tablero_access(p_project_id) then return; end if;
  insert into public.activity_log (project_id, user_id, action, payload)
  values (p_project_id, auth.uid(), p_action, coalesce(p_payload, '{}'::jsonb));
end;
$$;

grant execute on function public.log_activity(uuid, text, jsonb) to authenticated;

-- =============================================================
-- RPCs DE ADMIN (validan secret hardcoded)
-- =============================================================

create or replace function public.admin_list_users(p_secret text)
returns table(id uuid, username text, role text, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  perform public._validate_tablero_admin(p_secret);
  return query
    select p.id, p.username, p.role, p.created_at
    from public.profiles p
    order by p.username;
end;
$$;

grant execute on function public.admin_list_users(text) to anon, authenticated;

create or replace function public.admin_list_projects(p_secret text)
returns setof public.projects
language plpgsql security definer set search_path = public as $$
begin
  perform public._validate_tablero_admin(p_secret);
  return query select * from public.projects order by created_at desc;
end;
$$;

grant execute on function public.admin_list_projects(text) to anon, authenticated;

create or replace function public.admin_list_project_access(p_secret text, p_project_id uuid)
returns table(user_id uuid, username text, granted_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  perform public._validate_tablero_admin(p_secret);
  return query
    select pa.user_id, p.username, pa.granted_at
    from public.project_access pa
    join public.profiles p on p.id = pa.user_id
    where pa.project_id = p_project_id
    order by p.username;
end;
$$;

grant execute on function public.admin_list_project_access(text, uuid) to anon, authenticated;

create or replace function public.admin_grant_access(
  p_secret text, p_user_id uuid, p_project_id uuid
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._validate_tablero_admin(p_secret);
  insert into public.project_access (user_id, project_id)
  values (p_user_id, p_project_id)
  on conflict do nothing;
end;
$$;

grant execute on function public.admin_grant_access(text, uuid, uuid) to anon, authenticated;

create or replace function public.admin_revoke_access(
  p_secret text, p_user_id uuid, p_project_id uuid
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._validate_tablero_admin(p_secret);
  delete from public.project_access
  where user_id = p_user_id and project_id = p_project_id;
end;
$$;

grant execute on function public.admin_revoke_access(text, uuid, uuid) to anon, authenticated;

create or replace function public.admin_set_user_role(
  p_secret text, p_user_id uuid, p_role text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._validate_tablero_admin(p_secret);
  if p_role not in ('admin','user') then raise exception 'Rol inválido'; end if;
  update public.profiles set role = p_role where id = p_user_id;
end;
$$;

grant execute on function public.admin_set_user_role(text, uuid, text) to anon, authenticated;

-- ============ RESETEAR CONTRASEÑA DE OTRO USUARIO ============
-- Permite al admin del Tablero cambiar la contraseña de cualquier usuario.
-- Actualiza directamente auth.users.encrypted_password con bcrypt (que es
-- el mismo algoritmo que usa Supabase Auth internamente, formato $2a$/$2b$).
create or replace function public.admin_reset_password(
  p_secret text, p_user_id uuid, p_new_password text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._validate_tablero_admin(p_secret);
  if p_new_password is null or char_length(p_new_password) < 6 then
    raise exception 'La nueva contraseña debe tener al menos 6 caracteres';
  end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf', 10)),
         updated_at = now()
   where id = p_user_id;
  if not found then
    raise exception 'Usuario no encontrado';
  end if;
end;
$$;

grant execute on function public.admin_reset_password(text, uuid, text) to anon, authenticated;

-- Eliminar usuario completo (perfil + auth.users)
create or replace function public.admin_delete_user(
  p_secret text, p_user_id uuid
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._validate_tablero_admin(p_secret);
  -- Borra de auth.users; el cascade en profiles (id references auth.users)
  -- limpia profile, project_access, etc.
  delete from auth.users where id = p_user_id;
  if not found then
    raise exception 'Usuario no encontrado';
  end if;
end;
$$;

grant execute on function public.admin_delete_user(text, uuid) to anon, authenticated;

-- Ping para validar credenciales admin sin efectos colaterales
create or replace function public.admin_ping(p_secret text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform public._validate_tablero_admin(p_secret);
  return true;
end;
$$;

grant execute on function public.admin_ping(text) to anon, authenticated;

-- =============================================================
-- REALTIME
-- =============================================================
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
  ) then alter publication supabase_realtime add table public.tasks; end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'columns'
  ) then alter publication supabase_realtime add table public.columns; end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'projects'
  ) then alter publication supabase_realtime add table public.projects; end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity_log'
  ) then alter publication supabase_realtime add table public.activity_log; end if;
exception when others then null;
end $$;

-- =============================================================
-- LISTO. Verificá:
--   1. Table Editor → tienen que aparecer las 7 tablas.
--   2. Authentication → Providers → Email habilitado.
--   3. Si querés desactivar el email confirmation (recomendado para
--      uso interno entre amigos): Authentication → Providers →
--      Email → "Confirm email" en OFF.
--
-- Para cambiar el password de admin:
--   update public.tablero_settings set value = 'OtroPassword' where key = 'admin_secret';
--
-- Para borrar todo (cuidado):
--   truncate activity_log, tasks, columns, project_access, projects, profiles cascade;
-- =============================================================
