// =============================================================
// Lib compartida del Prode Fifa 2026
// =============================================================

const cfg = window.PRODE_FIFA_CONFIG || {};
const SUPA_OK =
  cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_URL.includes('YOUR-PROJECT') &&
  !cfg.SUPABASE_ANON_KEY.includes('YOUR-ANON');

let sb = null;
if (SUPA_OK && window.supabase) {
  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
}

// Lock de bloqueo: 1 hora antes
const LOCK_MS = 60 * 60 * 1000;

// ===== Toggle mostrar/ocultar contraseña (delegado en document) =====
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

// ===== Sesión =====
const SESSION_KEY = 'prode-fifa-session';
const ADMIN_SESSION_KEY = 'prode-fifa-admin';

const Session = {
  get() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch { return null; }
  },
  set(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); },
  clear() { localStorage.removeItem(SESSION_KEY); }
};

const AdminSession = {
  get() { return localStorage.getItem(ADMIN_SESSION_KEY); },
  set(secret) { localStorage.setItem(ADMIN_SESSION_KEY, secret); },
  clear() { localStorage.removeItem(ADMIN_SESSION_KEY); }
};

// ===== API =====
const API = {
  async login(name, password) {
    if (!sb) throw new Error('Supabase no configurado');
    const { data, error } = await sb.rpc('login', { p_name: name, p_password: password });
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data[0] : data;
  },

  async register(name, password) {
    if (!sb) throw new Error('Supabase no configurado');
    const { data, error } = await sb.rpc('register', { p_name: name, p_password: password });
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data[0] : data;
  },

  async listMatches() {
    if (!sb) return [];
    const { data, error } = await sb
      .from('matches_full')
      .select('*')
      .order('start_time', { ascending: true });
    if (error) throw new Error(error.message);
    return data || [];
  },

  async listMyPredictions(playerId) {
    if (!sb || !playerId) return [];
    const { data, error } = await sb
      .from('predictions')
      .select('*')
      .eq('player_id', playerId);
    if (error) throw new Error(error.message);
    return data || [];
  },

  async listAllPredictions() {
    if (!sb) return [];
    const { data, error } = await sb.from('predictions').select('*');
    if (error) throw new Error(error.message);
    return data || [];
  },

  async placePrediction(playerId, token, matchId, home, away) {
    if (!sb) throw new Error('Supabase no configurado');
    const { data, error } = await sb.rpc('place_prediction', {
      p_player_id: playerId,
      p_token: token,
      p_match_id: matchId,
      p_home: home,
      p_away: away
    });
    if (error) throw new Error(error.message);
    return data;
  },

  async leaderboard() {
    if (!sb) return [];
    const { data, error } = await sb.from('leaderboard').select('*');
    if (error) throw new Error(error.message);
    return data || [];
  },

  async listTeams() {
    if (!sb) return [];
    const { data, error } = await sb.from('teams').select('*').order('name');
    if (error) throw new Error(error.message);
    return data || [];
  },

  async listPlayers() {
    if (!sb) return [];
    const { data, error } = await sb.from('players_public').select('*').order('name');
    if (error) throw new Error(error.message);
    return data || [];
  },

  // ===== Admin =====
  async adminSetResult(secret, matchId, home, away) {
    const { data, error } = await sb.rpc('admin_set_match_result', {
      p_secret: secret, p_match_id: matchId,
      p_home: home, p_away: away
    });
    if (error) throw new Error(error.message);
    return data;
  },

  async adminCreateMatch(secret, home, away, startISO, phase, bracketSlot) {
    const { data, error } = await sb.rpc('admin_create_match', {
      p_secret: secret,
      p_home_team: home,
      p_away_team: away,
      p_start: startISO,
      p_phase: phase,
      p_bracket_slot: bracketSlot || null
    });
    if (error) throw new Error(error.message);
    return data;
  },

  async adminDeleteMatch(secret, matchId) {
    const { error } = await sb.rpc('admin_delete_match', {
      p_secret: secret, p_match_id: matchId
    });
    if (error) throw new Error(error.message);
  },

  async adminRecalcAll(secret) {
    const { error } = await sb.rpc('admin_recalc_all', { p_secret: secret });
    if (error) throw new Error(error.message);
  },

  // Validación rápida del secret admin: intenta un recálculo "vacío" inofensivo
  async adminValidate(secret) {
    // No hay un endpoint dedicado: usamos recalc_all como ping (es idempotente).
    const { error } = await sb.rpc('admin_recalc_all', { p_secret: secret });
    if (error) throw new Error('Credenciales de admin inválidas');
  }
};

// ===== Helpers de UI =====

// Convierte 'ar' -> 🇦🇷 usando Regional Indicator Symbols.
function flagEmoji(cc) {
  if (!cc || cc.length !== 2) return '🏳️';
  return cc.toUpperCase().replace(/./g, c => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

// URL a una imagen de bandera (resolución mediana)
function flagUrl(cc) {
  if (!cc) return '';
  return `https://flagcdn.com/w80/${cc.toLowerCase()}.png`;
}

const PHASE_LABELS = {
  group:  'Fase de Grupos',
  r32:    '32avos de Final',
  r16:    'Octavos de Final',
  qf:     'Cuartos de Final',
  sf:     'Semifinal',
  tp:     'Tercer Puesto',
  final:  'FINAL'
};

function fmtDateTime(iso) {
  return new Date(iso).toLocaleString('es-AR', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit'
  });
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function isLocked(startISO) {
  return Date.now() >= new Date(startISO).getTime() - LOCK_MS;
}

function timeUntilLock(startISO) {
  return new Date(startISO).getTime() - LOCK_MS - Date.now();
}

function fmtCountdown(ms) {
  if (ms <= 0) return 'Cerrado';
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// Toast
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

// Header común
function renderHeader(activeTab) {
  const session = Session.get();
  const el = document.getElementById('header');
  if (!el) return;
  const tabs = [
    { id: 'home',    label: 'Partidos', href: './' },
    { id: 'ranking', label: 'Ranking',  href: './ranking.html' }
  ];
  el.innerHTML = `
    <a href="/" class="back" title="Volver al inicio">←</a>
    <div class="brand">
      <div class="brand-logo">⚽</div>
      <div>
        <h1>Prode Fifa 2026</h1>
        <p>Predicciones entre amigos</p>
      </div>
    </div>
    <nav class="tabs">
      ${tabs.map(t => `
        <a href="${t.href}" class="tab ${t.id === activeTab ? 'active' : ''}">${t.label}</a>
      `).join('')}
    </nav>
    <div class="user-box">
      ${session
        ? `<span class="user-name" title="${escapeHtml(session.name)}">👤 ${escapeHtml(session.name)}</span>
           <button class="btn-ghost" id="logout-btn">Salir</button>`
        : ''}
    </div>
  `;
  const lb = document.getElementById('logout-btn');
  if (lb) lb.addEventListener('click', () => {
    Session.clear();
    location.reload();
  });
}

// ===== Auth UI (modal de login/register) =====
function renderAuthGate(onLogin) {
  const root = document.getElementById('auth-gate');
  if (!root) return;
  root.classList.remove('hidden');
  root.innerHTML = `
    <div class="auth-card">
      <div class="auth-logo">⚽</div>
      <h2>Bienvenido al Prode Fifa 2026</h2>
      <p class="auth-sub">Ingresá con tu nombre y contraseña. Si no tenés cuenta, creala.</p>

      <div class="auth-tabs">
        <button class="auth-tab active" data-mode="login">Ingresar</button>
        <button class="auth-tab" data-mode="register">Registrarse</button>
      </div>

      <form id="auth-form" autocomplete="off">
        <label>Nombre</label>
        <input type="text" id="auth-name" maxlength="30" required placeholder="Tu nombre" />
        <label>Contraseña</label>
        <div class="password-wrap">
          <input type="password" id="auth-pass" minlength="4" required placeholder="Mínimo 4 caracteres" />
          <button type="button" class="pwd-toggle" data-target="auth-pass" aria-label="Mostrar contraseña" title="Mostrar/ocultar contraseña">👁</button>
        </div>
        <button class="btn-primary" type="submit" id="auth-submit">Ingresar</button>
        <div class="auth-error" id="auth-error"></div>
      </form>
    </div>
  `;

  let mode = 'login';
  const submit = document.getElementById('auth-submit');
  document.querySelectorAll('.auth-tab').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      mode = b.dataset.mode;
      submit.textContent = mode === 'login' ? 'Ingresar' : 'Crear cuenta';
    });
  });

  document.getElementById('auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = document.getElementById('auth-name').value.trim();
    const pass = document.getElementById('auth-pass').value;
    const err = document.getElementById('auth-error');
    err.textContent = '';
    submit.disabled = true;
    submit.textContent = mode === 'login' ? 'Ingresando…' : 'Creando…';
    try {
      const session = mode === 'login'
        ? await API.login(name, pass)
        : await API.register(name, pass);
      Session.set(session);
      root.classList.add('hidden');
      onLogin?.(session);
    } catch (ex) {
      err.textContent = ex.message || 'Error desconocido';
    } finally {
      submit.disabled = false;
      submit.textContent = mode === 'login' ? 'Ingresar' : 'Crear cuenta';
    }
  });
}

// Verificar sesión: si no hay, mostrar login. Si hay, ejecutar onReady.
function requireAuth(onReady) {
  const session = Session.get();
  if (session) { onReady(session); return; }
  renderAuthGate(s => onReady(s));
}
