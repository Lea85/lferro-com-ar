// =============================================================
// Lib del Tablero de Cambios
//   - Cliente Supabase (Auth + DB)
//   - API wrapper
//   - Helpers UI: toast, modal, dom
// =============================================================

const cfg = window.TABLERO_CONFIG || {};
const SUPA_OK =
  cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_URL.includes('YOUR-PROJECT') &&
  !cfg.SUPABASE_ANON_KEY.includes('YOUR-ANON');

let sb = null;
if (SUPA_OK && window.supabase) {
  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: window.localStorage,
      storageKey: 'tablero-auth'
    }
  });
}

// ===== Auth (Supabase Auth con seudo-email) =====
function usernameToEmail(username) {
  return `${username.trim().toLowerCase()}@${cfg.EMAIL_DOMAIN}`;
}

const Auth = {
  async signIn(username, password) {
    if (!sb) throw new Error('Supabase no configurado');
    const { data, error } = await sb.auth.signInWithPassword({
      email: usernameToEmail(username),
      password
    });
    if (error) throw new Error(translateAuthError(error));
    return data;
  },

  async signUp(username, password) {
    if (!sb) throw new Error('Supabase no configurado');
    const { data, error } = await sb.auth.signUp({
      email: usernameToEmail(username),
      password,
      options: { data: { username: username.trim() } }
    });
    if (error) throw new Error(translateAuthError(error));
    return data;
  },

  async signOut() {
    if (!sb) return;
    await sb.auth.signOut();
  },

  async getSession() {
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session;
  },

  async getProfile() {
    const session = await this.getSession();
    if (!session) return null;
    const { data, error } = await sb
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .single();
    if (error) return { id: session.user.id, username: 'desconocido', role: 'user' };
    return data;
  },

  onChange(cb) {
    if (!sb) return { unsubscribe: () => {} };
    return sb.auth.onAuthStateChange((event, session) => cb(event, session));
  }
};

function translateAuthError(error) {
  // Siempre logueo el error original para diagnostico
  console.warn('[Auth] error original:', error);
  const msg = (error?.message || '').trim();
  const status = error?.status || error?.code || '';
  const lower = msg.toLowerCase();
  if (lower.includes('invalid login credentials')) return 'Usuario o contraseña incorrectos. ¿Tal vez nunca creaste la cuenta? Probá la pestaña "Crear cuenta".';
  if (lower.includes('user already registered') || lower.includes('already been registered')) return 'Ese usuario ya existe. Probá ingresar con tu contraseña.';
  if (lower.includes('password should be at least')) return 'La contraseña debe tener al menos 6 caracteres.';
  if (lower.includes('weak password') || lower.includes('weak_password')) return 'La contraseña es demasiado débil. Usá al menos 6 caracteres.';
  if (lower.includes('rate limit') || lower.includes('rate_limit') || lower.includes('too many')) {
    return 'Demasiados intentos. Esperá 5-10 minutos antes de volver a probar.';
  }
  if (lower.includes('email address') && lower.includes('invalid')) {
    return 'Usuario inválido. Usá solo letras, números, punto, guion o guion bajo.';
  }
  if (lower.includes('signup') && lower.includes('disabled')) {
    return 'El registro está deshabilitado en Supabase. Activalo en Authentication → Providers → Email.';
  }
  if (lower.includes('email') && (lower.includes('confirmation') || lower.includes('confirm'))) {
    return 'Tenés activada la confirmación por email. Desactivala en Supabase: Authentication → Providers → Email → "Confirm email" en OFF.';
  }
  if (lower.includes('email not confirmed')) {
    return 'El usuario existe pero requiere confirmación por email. Desactivá "Confirm email" en Supabase Authentication.';
  }
  if (lower.includes('database error')) {
    return `Error en la base: ${msg}. ¿Corriste el SQL del Tablero (supabase/tablero-schema.sql) en Supabase?`;
  }
  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('network error')) {
    return 'No se pudo conectar con Supabase. Revisá la conexión a internet o si la red corporativa bloquea supabase.co.';
  }
  if (lower.includes('not configured') || lower.includes('supabase no')) {
    return 'Supabase no está configurado. Falta tablero/assets/config.js o las credenciales son inválidas.';
  }
  // Si no matcheo nada, devuelvo el mensaje crudo + status para diagnosticar
  const suffix = status ? ` (${status})` : '';
  return (msg || 'Error desconocido al autenticar') + suffix;
}

// ===== Toggle de mostrar/ocultar contraseña (delegado en document) =====
document.addEventListener('click', e => {
  const btn = e.target.closest && e.target.closest('.pwd-toggle');
  if (!btn) return;
  e.preventDefault();
  const targetId = btn.dataset.target;
  const input = targetId ? document.getElementById(targetId) : btn.parentElement?.querySelector('input');
  if (!input) return;
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.textContent = showing ? '👁' : '🙈';
  btn.setAttribute('aria-label', showing ? 'Mostrar contraseña' : 'Ocultar contraseña');
});

// ===== API =====
const API = {
  // Projects
  async listProjects() {
    const { data, error } = await sb
      .from('projects')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data || [];
  },

  async createProject(name, description) {
    const { data, error } = await sb.rpc('create_project_with_defaults', {
      p_name: name,
      p_description: description || null
    });
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data[0] : data;
  },

  async updateProject(id, fields) {
    const { error } = await sb.from('projects').update(fields).eq('id', id);
    if (error) throw new Error(error.message);
  },

  async deleteProject(id) {
    const { error } = await sb.from('projects').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  // Columns
  async listColumns(projectId) {
    const { data, error } = await sb
      .from('columns')
      .select('*')
      .eq('project_id', projectId)
      .order('position');
    if (error) throw new Error(error.message);
    return data || [];
  },

  async createColumn(projectId, name, position) {
    const { data, error } = await sb
      .from('columns')
      .insert({ project_id: projectId, name, position })
      .select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  async updateColumn(id, fields) {
    const { error } = await sb.from('columns').update(fields).eq('id', id);
    if (error) throw new Error(error.message);
  },

  async deleteColumn(id) {
    const { error } = await sb.from('columns').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  async reorderColumns(projectId, columnIds) {
    const { error } = await sb.rpc('reorder_columns', {
      p_project_id: projectId, p_column_ids: columnIds
    });
    if (error) throw new Error(error.message);
  },

  // Tasks
  async listTasks(projectId) {
    const { data, error } = await sb
      .from('tasks')
      .select('*, column:columns!inner(project_id)')
      .eq('column.project_id', projectId)
      .order('position');
    if (error) throw new Error(error.message);
    return (data || []).map(t => { delete t.column; return t; });
  },

  async createTask(columnId, fields) {
    const { data, error } = await sb
      .from('tasks')
      .insert({ column_id: columnId, ...fields })
      .select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  async updateTask(id, fields) {
    const { data, error } = await sb
      .from('tasks').update(fields).eq('id', id)
      .select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  async deleteTask(id) {
    const { error } = await sb.from('tasks').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  async reorderTasks(columnId, taskIds) {
    const { error } = await sb.rpc('reorder_tasks', {
      p_column_id: columnId, p_task_ids: taskIds
    });
    if (error) throw new Error(error.message);
  },

  // Profiles
  async listProfiles() {
    const { data, error } = await sb.from('profiles').select('*').order('username');
    if (error) throw new Error(error.message);
    return data || [];
  },

  // Activity log
  async listActivity(projectId, limit = 30) {
    const { data, error } = await sb
      .from('activity_log')
      .select('*, profile:profiles(username)')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return data || [];
  },

  async logActivity(projectId, action, payload) {
    try {
      await sb.rpc('log_activity', {
        p_project_id: projectId, p_action: action, p_payload: payload || {}
      });
    } catch { /* no critical */ }
  },

  // Admin
  async adminPing(secret) {
    const { error } = await sb.rpc('admin_ping', { p_secret: secret });
    if (error) throw new Error(error.message);
  },
  async adminListUsers(secret) {
    const { data, error } = await sb.rpc('admin_list_users', { p_secret: secret });
    if (error) throw new Error(error.message);
    return data || [];
  },
  async adminListProjects(secret) {
    const { data, error } = await sb.rpc('admin_list_projects', { p_secret: secret });
    if (error) throw new Error(error.message);
    return data || [];
  },
  async adminListProjectAccess(secret, projectId) {
    const { data, error } = await sb.rpc('admin_list_project_access', {
      p_secret: secret, p_project_id: projectId
    });
    if (error) throw new Error(error.message);
    return data || [];
  },
  async adminGrantAccess(secret, userId, projectId) {
    const { error } = await sb.rpc('admin_grant_access', {
      p_secret: secret, p_user_id: userId, p_project_id: projectId
    });
    if (error) throw new Error(error.message);
  },
  async adminRevokeAccess(secret, userId, projectId) {
    const { error } = await sb.rpc('admin_revoke_access', {
      p_secret: secret, p_user_id: userId, p_project_id: projectId
    });
    if (error) throw new Error(error.message);
  },
  async adminSetUserRole(secret, userId, role) {
    const { error } = await sb.rpc('admin_set_user_role', {
      p_secret: secret, p_user_id: userId, p_role: role
    });
    if (error) throw new Error(error.message);
  }
};

// ===== Helpers UI =====
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function toast(msg, type) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = 'toast show ' + (type || '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2800);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtRelative(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'hace un momento';
  const min = Math.floor(sec / 60);
  if (min < 60) return `hace ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `hace ${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `hace ${d}d`;
  return fmtDate(iso);
}

const PRIORITY_CONFIG = {
  baja:  { label: 'Baja',  color: '#22d3ee', class: 'baja' },
  media: { label: 'Media', color: '#fbbf24', class: 'media' },
  alta:  { label: 'Alta',  color: '#ef4444', class: 'alta' }
};

const LABEL_PRESETS = [
  { name: 'Bug',       color: '#ef4444' },
  { name: 'Feature',   color: '#06b6d4' },
  { name: 'Refactor',  color: '#a855f7' },
  { name: 'Docs',      color: '#22c55e' },
  { name: 'Urgente',   color: '#f59e0b' },
  { name: 'Research',  color: '#8b5cf6' }
];

// Modal genérico
function openModal(html, onClose) {
  const overlay = el(`<div class="modal-overlay">${html}</div>`);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal(overlay, onClose);
  });
  // ESC para cerrar
  const escHandler = e => {
    if (e.key === 'Escape') {
      closeModal(overlay, onClose);
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
  // expose close fn
  overlay._close = () => closeModal(overlay, onClose);
  setTimeout(() => overlay.classList.add('show'), 10);
  return overlay;
}

function closeModal(overlay, onClose) {
  overlay.classList.remove('show');
  setTimeout(() => {
    overlay.remove();
    onClose?.();
  }, 200);
}
