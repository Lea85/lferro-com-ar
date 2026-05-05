// =============================================================
// Admin del Tablero de Cambios
// Login hardcoded: leandro / Tablero2026
// =============================================================

const ADMIN_USER = 'leandro';
const ADMIN_PASS = 'Tablero2026';
const SESSION_KEY = 'tablero-admin-secret';

const adminState = {
  users: [],
  projects: [],
  selectedProjectId: null,
  accessByProject: new Map() // projectId -> [user_id]
};

// ---------- Bootstrap ----------
const stored = localStorage.getItem(SESSION_KEY);
if (stored === ADMIN_PASS) {
  start();
} else {
  showLogin();
}

function showLogin() {
  document.getElementById('admin-auth').classList.remove('hidden');
  document.getElementById('admin-app').classList.add('hidden');

  document.getElementById('admin-form').addEventListener('submit', async e => {
    e.preventDefault();
    const u = document.getElementById('adm-user').value.trim().toLowerCase();
    const p = document.getElementById('adm-pass').value;
    const err = document.getElementById('adm-err');
    const btn = document.getElementById('adm-submit');
    err.textContent = '';

    if (u !== ADMIN_USER || p !== ADMIN_PASS) {
      err.textContent = 'Credenciales inválidas';
      return;
    }
    btn.disabled = true; btn.textContent = 'Verificando…';
    try {
      await API.adminPing(p);
      localStorage.setItem(SESSION_KEY, p);
      document.getElementById('admin-auth').classList.add('hidden');
      start();
    } catch (ex) {
      err.textContent = ex.message + ' (¿el SQL del Tablero está aplicado?)';
    } finally {
      btn.disabled = false; btn.textContent = 'Ingresar';
    }
  });
}

function start() {
  document.getElementById('admin-auth').classList.add('hidden');
  document.getElementById('admin-app').classList.remove('hidden');

  document.getElementById('adm-logout').addEventListener('click', () => {
    localStorage.removeItem(SESSION_KEY);
    location.reload();
  });

  loadAndRender();
}

async function loadAndRender() {
  const secret = localStorage.getItem(SESSION_KEY);
  try {
    [adminState.users, adminState.projects] = await Promise.all([
      API.adminListUsers(secret),
      API.adminListProjects(secret)
    ]);
    if (!adminState.selectedProjectId && adminState.projects.length > 0) {
      adminState.selectedProjectId = adminState.projects[0].id;
    }
    if (adminState.selectedProjectId) {
      const access = await API.adminListProjectAccess(secret, adminState.selectedProjectId);
      adminState.accessByProject.set(
        adminState.selectedProjectId,
        new Set(access.map(a => a.user_id))
      );
    }
    render();
  } catch (err) {
    document.getElementById('admin-root').innerHTML =
      `<div class="empty-state"><div class="e-emoji">⚠️</div>${escapeHtml(err.message)}</div>`;
  }
}

function render() {
  const root = document.getElementById('admin-root');
  root.innerHTML = `
    <div class="admin-grid">
      ${renderUsersCard()}
      ${renderAccessCard()}
    </div>
    <div class="admin-card" style="margin-top:16px;">
      <h2>📦 Proyectos del sistema</h2>
      ${renderProjectsList()}
    </div>
    <div class="admin-card" style="margin-top:16px;">
      <h2>ℹ️ Crear usuarios nuevos</h2>
      <div style="color:var(--slate-400);font-size:13px;line-height:1.6;">
        Para sumar gente al tablero, pediles que se registren ellos mismos en
        <a href="/tablero/" class="tag cyan" style="text-decoration:none;">/tablero/</a>
        eligiendo su usuario y contraseña. Una vez creada la cuenta, aparecen acá y podés asignarles acceso a los proyectos que correspondan.
      </div>
    </div>
  `;
  attachHandlers();
}

function renderUsersCard() {
  if (adminState.users.length === 0) {
    return `
      <div class="admin-card">
        <h2>👥 Usuarios registrados (0)</h2>
        <div class="empty-state" style="padding:30px;">
          <div>Todavía no hay usuarios. Pediles que se registren en <code>/tablero/</code>.</div>
        </div>
      </div>`;
  }
  return `
    <div class="admin-card">
      <h2>👥 Usuarios registrados (${adminState.users.length})</h2>
      <div class="users-table">
        ${adminState.users.map(u => `
          <div class="user-row ${u.role === 'admin' ? 'admin' : ''}">
            <span class="name">@${escapeHtml(u.username)}</span>
            <span class="role">${u.role}</span>
            <button class="btn btn-ghost btn-sm" data-action="toggle-role" data-uid="${u.id}" data-role="${u.role}">
              ${u.role === 'admin' ? 'Quitar admin' : 'Hacer admin'}
            </button>
          </div>
        `).join('')}
      </div>
    </div>`;
}

function renderAccessCard() {
  if (adminState.projects.length === 0) {
    return `
      <div class="admin-card">
        <h2>🔑 Permisos por proyecto</h2>
        <div class="empty-state" style="padding:30px;">
          <div>No hay proyectos creados todavía.</div>
        </div>
      </div>`;
  }
  const accessSet = adminState.accessByProject.get(adminState.selectedProjectId) || new Set();
  return `
    <div class="admin-card">
      <h2>🔑 Permisos por proyecto</h2>
      <div class="field" style="margin-bottom:14px;">
        <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--slate-400);margin-bottom:6px;">Proyecto</label>
        <select id="proj-select" style="width:100%;padding:10px 12px;background:var(--bg-3);border:1.5px solid var(--line-strong);color:var(--slate-100);border-radius:8px;font-family:inherit;font-size:13.5px;">
          ${adminState.projects.map(p => `
            <option value="${p.id}" ${p.id === adminState.selectedProjectId ? 'selected' : ''}>${escapeHtml(p.name)}</option>
          `).join('')}
        </select>
      </div>
      ${adminState.users.length === 0
        ? `<div class="empty-state" style="padding:20px;"><div>No hay usuarios para asignar.</div></div>`
        : `<div class="users-table">
            ${adminState.users.map(u => {
              const has = accessSet.has(u.id);
              return `
                <div class="user-row">
                  <span class="name">@${escapeHtml(u.username)}</span>
                  ${has
                    ? `<button class="btn btn-danger btn-sm" data-action="revoke" data-uid="${u.id}">✕ Quitar</button>`
                    : `<button class="btn btn-primary btn-sm" data-action="grant" data-uid="${u.id}">✓ Dar acceso</button>`}
                </div>`;
            }).join('')}
          </div>`}
    </div>`;
}

function renderProjectsList() {
  if (adminState.projects.length === 0) {
    return `<div class="empty-state" style="padding:20px;"><div>No hay proyectos.</div></div>`;
  }
  return `
    <div class="users-table">
      ${adminState.projects.map(p => `
        <div class="user-row">
          <span class="name">${escapeHtml(p.name)}</span>
          <span style="font-family:var(--mono);font-size:11px;color:var(--slate-500);">${p.id.slice(0, 8)}…</span>
          <span style="font-size:11px;color:var(--slate-500);">${fmtDate(p.created_at)}</span>
        </div>
      `).join('')}
    </div>`;
}

function attachHandlers() {
  const secret = localStorage.getItem(SESSION_KEY);

  // Cambiar proyecto seleccionado
  document.getElementById('proj-select')?.addEventListener('change', async e => {
    adminState.selectedProjectId = e.target.value;
    try {
      const access = await API.adminListProjectAccess(secret, adminState.selectedProjectId);
      adminState.accessByProject.set(
        adminState.selectedProjectId,
        new Set(access.map(a => a.user_id))
      );
      render();
    } catch (err) { toast(err.message, 'err'); }
  });

  // Grant / Revoke
  document.querySelectorAll('[data-action="grant"]').forEach(b => {
    b.addEventListener('click', async () => {
      try {
        await API.adminGrantAccess(secret, b.dataset.uid, adminState.selectedProjectId);
        const set = adminState.accessByProject.get(adminState.selectedProjectId) || new Set();
        set.add(b.dataset.uid);
        adminState.accessByProject.set(adminState.selectedProjectId, set);
        toast('Acceso otorgado ✓', 'ok');
        render();
      } catch (err) { toast(err.message, 'err'); }
    });
  });
  document.querySelectorAll('[data-action="revoke"]').forEach(b => {
    b.addEventListener('click', async () => {
      try {
        await API.adminRevokeAccess(secret, b.dataset.uid, adminState.selectedProjectId);
        const set = adminState.accessByProject.get(adminState.selectedProjectId) || new Set();
        set.delete(b.dataset.uid);
        adminState.accessByProject.set(adminState.selectedProjectId, set);
        toast('Acceso revocado', 'ok');
        render();
      } catch (err) { toast(err.message, 'err'); }
    });
  });

  // Cambiar rol
  document.querySelectorAll('[data-action="toggle-role"]').forEach(b => {
    b.addEventListener('click', async () => {
      const newRole = b.dataset.role === 'admin' ? 'user' : 'admin';
      if (!confirm(`¿Cambiar rol a "${newRole}"?`)) return;
      try {
        await API.adminSetUserRole(secret, b.dataset.uid, newRole);
        const u = adminState.users.find(x => x.id === b.dataset.uid);
        if (u) u.role = newRole;
        toast('Rol actualizado ✓', 'ok');
        render();
      } catch (err) { toast(err.message, 'err'); }
    });
  });
}
