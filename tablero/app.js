// =============================================================
// Tablero de Cambios - lógica principal
// =============================================================

const state = {
  profile: null,
  projects: [],
  currentProjectId: null,
  columns: [],
  tasks: [],
  search: '',
  sortables: [],
  realtimeChan: null
};

// ---------- Bootstrap ----------
(async function bootstrap() {
  const session = await Auth.getSession();
  if (!session) {
    showAuth();
    return;
  }
  await startApp();
})();

Auth.onChange(async (event, session) => {
  if (event === 'SIGNED_IN') {
    document.getElementById('auth-wrap').classList.add('hidden');
    await startApp();
  } else if (event === 'SIGNED_OUT') {
    location.reload();
  }
});

// ---------- Auth UI ----------
function showAuth() {
  document.getElementById('auth-wrap').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');

  let mode = 'login';
  const submit = document.getElementById('auth-submit');
  document.querySelectorAll('.auth-tabs button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.auth-tabs button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      mode = b.dataset.mode;
      submit.textContent = mode === 'login' ? 'Ingresar' : 'Crear cuenta';
    });
  });

  document.getElementById('auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    const user = document.getElementById('auth-user').value.trim();
    const pass = document.getElementById('auth-pass').value;
    const err = document.getElementById('auth-error');
    err.textContent = '';

    if (!/^[a-zA-Z0-9._-]{2,30}$/.test(user)) {
      err.textContent = 'Usuario inválido. Usá solo letras, números, punto, guion o guion bajo (2-30 chars).';
      return;
    }

    submit.disabled = true;
    submit.textContent = mode === 'login' ? 'Ingresando…' : 'Creando…';
    try {
      if (mode === 'login') await Auth.signIn(user, pass);
      else {
        await Auth.signUp(user, pass);
        toast('Cuenta creada ✓', 'ok');
      }
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      submit.disabled = false;
      submit.textContent = mode === 'login' ? 'Ingresar' : 'Crear cuenta';
    }
  });
}

// ---------- App start ----------
async function startApp() {
  document.getElementById('auth-wrap').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  state.profile = await Auth.getProfile();
  document.getElementById('sb-user').textContent = `@${state.profile?.username || ''}`;

  // Sidebar
  setupSidebar();
  await loadProjects();

  // Buscar
  document.getElementById('search-input').addEventListener('input', e => {
    state.search = e.target.value.toLowerCase().trim();
    renderBoard();
  });

  // Editar/eliminar proyecto
  document.getElementById('proj-edit').addEventListener('click', () => {
    if (state.currentProjectId) openEditProjectModal();
  });
  document.getElementById('proj-delete').addEventListener('click', () => {
    if (!state.currentProjectId) return;
    const p = state.projects.find(p => p.id === state.currentProjectId);
    if (!confirm(`¿Eliminar el proyecto "${p.name}" y TODAS sus tareas? Esta acción no se puede deshacer.`)) return;
    deleteCurrentProject();
  });
}

function setupSidebar() {
  document.getElementById('sb-toggle').addEventListener('click', () => {
    const sb = document.getElementById('sidebar');
    sb.classList.toggle('collapsed');
    document.getElementById('sb-toggle').textContent = sb.classList.contains('collapsed') ? '›' : '‹';
  });

  document.getElementById('sb-add-project').addEventListener('click', openCreateProjectModal);
  document.getElementById('sb-logout').addEventListener('click', async () => {
    await Auth.signOut();
  });
}

// ---------- Projects ----------
async function loadProjects() {
  try {
    state.projects = await API.listProjects();
    renderSidebar();
    if (state.projects.length === 0) {
      document.getElementById('proj-title').textContent = 'Sin proyectos';
      document.getElementById('proj-subtitle').textContent = '';
      document.getElementById('board-root').innerHTML = `
        <div class="empty-state">
          <div class="e-emoji">📋</div>
          <h3>Bienvenido</h3>
          <div>No tenés proyectos asignados. Creá uno nuevo o pedile a un admin que te dé acceso.</div>
          <div style="margin-top:18px;">
            <button class="btn btn-primary" onclick="openCreateProjectModal()">＋ Crear mi primer proyecto</button>
          </div>
        </div>`;
    } else {
      const target = state.currentProjectId && state.projects.find(p => p.id === state.currentProjectId)
        ? state.currentProjectId
        : state.projects[0].id;
      await selectProject(target);
    }
  } catch (err) {
    document.getElementById('board-root').innerHTML =
      `<div class="empty-state"><div class="e-emoji">⚠️</div>${escapeHtml(err.message)}</div>`;
  }
}

function renderSidebar() {
  const root = document.getElementById('sb-projects');
  root.innerHTML = state.projects.map(p => `
    <div class="sb-project ${p.id === state.currentProjectId ? 'active' : ''}" data-id="${p.id}">
      <span class="dot"></span>
      <span class="sb-project-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
    </div>
  `).join('');
  root.querySelectorAll('.sb-project').forEach(el => {
    el.addEventListener('click', () => selectProject(el.dataset.id));
  });
}

async function selectProject(projectId) {
  state.currentProjectId = projectId;
  renderSidebar();

  const proj = state.projects.find(p => p.id === projectId);
  if (!proj) return;
  document.getElementById('proj-title').textContent = proj.name;
  document.getElementById('proj-subtitle').textContent = proj.description || `id: ${projectId.slice(0, 8)}…`;

  document.getElementById('board-root').innerHTML = `<div class="loading">Cargando tablero…</div>`;

  try {
    [state.columns, state.tasks] = await Promise.all([
      API.listColumns(projectId),
      API.listTasks(projectId)
    ]);
    renderBoard();
    loadActivity();
    setupRealtime(projectId);
  } catch (err) {
    document.getElementById('board-root').innerHTML =
      `<div class="empty-state"><div class="e-emoji">⚠️</div>${escapeHtml(err.message)}</div>`;
  }
}

function setupRealtime(projectId) {
  if (state.realtimeChan) {
    sb.removeChannel(state.realtimeChan);
    state.realtimeChan = null;
  }
  state.realtimeChan = sb.channel('tablero-' + projectId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => {
      // Refrescar solo tasks
      API.listTasks(projectId).then(t => { state.tasks = t; renderBoard(); });
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'columns', filter: `project_id=eq.${projectId}` }, () => {
      API.listColumns(projectId).then(c => { state.columns = c; renderBoard(); });
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'activity_log', filter: `project_id=eq.${projectId}` }, loadActivity)
    .subscribe();
}

// ---------- Board (Kanban) ----------
function renderBoard() {
  const root = document.getElementById('board-root');
  if (state.columns.length === 0) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="e-emoji">📭</div>
        <h3>Sin columnas</h3>
        <div>Este proyecto no tiene columnas todavía. Creá una para empezar.</div>
        <div style="margin-top:14px;">
          <button class="btn btn-primary" onclick="addColumn()">＋ Agregar columna</button>
        </div>
      </div>`;
    return;
  }

  // Filtrar tasks por búsqueda
  const tasksByCol = {};
  for (const c of state.columns) tasksByCol[c.id] = [];
  for (const t of state.tasks) {
    const col = tasksByCol[t.column_id];
    if (!col) continue;
    if (state.search) {
      const inTitle = (t.title || '').toLowerCase().includes(state.search);
      const inDesc = (t.description || '').toLowerCase().includes(state.search);
      const inLabels = (t.labels || []).some(l => (l.name || '').toLowerCase().includes(state.search));
      if (!inTitle && !inDesc && !inLabels) continue;
    }
    col.push(t);
  }

  root.innerHTML = `
    <div class="board" id="board">
      ${state.columns.map(c => columnHtml(c, tasksByCol[c.id])).join('')}
      <button class="add-column" onclick="addColumn()">＋ Agregar columna</button>
    </div>
  `;

  initSortables();
  attachBoardHandlers();
}

function columnHtml(col, tasks) {
  return `
    <div class="column" data-col-id="${col.id}">
      <div class="column-head">
        <span class="name" contenteditable="true" data-col-id="${col.id}">${escapeHtml(col.name)}</span>
        <span class="count">${tasks.length}</span>
        <button class="btn-icon btn-sm" data-action="del-col" data-col-id="${col.id}" title="Eliminar columna">🗑</button>
      </div>
      <div class="column-tasks" data-col-id="${col.id}">
        ${tasks.map(taskHtml).join('')}
      </div>
      <button class="add-task" data-col-id="${col.id}">＋ Agregar tarea</button>
    </div>
  `;
}

function taskHtml(t) {
  const labelsHtml = (t.labels || []).map(l => `
    <span class="task-label" style="background:${l.color}22;color:${l.color};border:1px solid ${l.color}55;">${escapeHtml(l.name)}</span>
  `).join('');

  let dueHtml = '';
  if (t.due_date) {
    const due = new Date(t.due_date + 'T23:59:59');
    const days = Math.ceil((due - Date.now()) / 86400000);
    let cls = '';
    if (days < 0) cls = 'overdue';
    else if (days <= 2) cls = 'soon';
    dueHtml = `<span class="due-pill ${cls}">📅 ${fmtDate(t.due_date)}</span>`;
  }

  const prio = PRIORITY_CONFIG[t.priority] || PRIORITY_CONFIG.media;

  return `
    <div class="task" data-task-id="${t.id}">
      ${labelsHtml ? `<div class="task-labels">${labelsHtml}</div>` : ''}
      <div class="task-title">${escapeHtml(t.title)}</div>
      <div class="task-meta">
        <span class="priority-pill ${prio.class}">${prio.label}</span>
        ${dueHtml}
      </div>
    </div>
  `;
}

function initSortables() {
  state.sortables.forEach(s => s.destroy());
  state.sortables = [];

  // Sortable de tasks (entre columnas)
  document.querySelectorAll('.column-tasks').forEach(el => {
    const s = Sortable.create(el, {
      group: 'tasks',
      animation: 150,
      ghostClass: 'ghost',
      dragClass: 'dragging',
      onEnd: handleTaskMove
    });
    state.sortables.push(s);
  });

  // Sortable de columnas
  const board = document.getElementById('board');
  if (board) {
    const s = Sortable.create(board, {
      animation: 200,
      handle: '.column-head .name',
      filter: '.add-column, .add-task, .btn-icon, [contenteditable]',
      preventOnFilter: false,
      onEnd: handleColumnMove
    });
    state.sortables.push(s);
  }
}

async function handleTaskMove(evt) {
  const fromColId = evt.from.dataset.colId;
  const toColId = evt.to.dataset.colId;
  const taskId = evt.item.dataset.taskId;
  // Recolectar IDs ordenados de la columna destino
  const newOrder = Array.from(evt.to.querySelectorAll('.task')).map(el => el.dataset.taskId);

  try {
    await API.reorderTasks(toColId, newOrder);
    // Si vino de otra columna, también reordenamos la origen para limpiar positions
    if (fromColId !== toColId) {
      const fromOrder = Array.from(evt.from.querySelectorAll('.task')).map(el => el.dataset.taskId);
      if (fromOrder.length > 0) await API.reorderTasks(fromColId, fromOrder);
      // Log
      const t = state.tasks.find(x => x.id === taskId);
      const fromCol = state.columns.find(c => c.id === fromColId);
      const toCol = state.columns.find(c => c.id === toColId);
      API.logActivity(state.currentProjectId, 'task_moved', {
        task_title: t?.title,
        from: fromCol?.name,
        to: toCol?.name
      });
    }
    // Actualizar caché local
    const t = state.tasks.find(x => x.id === taskId);
    if (t) t.column_id = toColId;
    state.tasks.sort((a, b) => a.position - b.position);
  } catch (err) {
    toast(err.message, 'err');
    selectProject(state.currentProjectId);
  }
}

async function handleColumnMove(evt) {
  const colIds = Array.from(document.querySelectorAll('.column')).map(el => el.dataset.colId);
  try {
    await API.reorderColumns(state.currentProjectId, colIds);
    state.columns = colIds.map(id => state.columns.find(c => c.id === id)).filter(Boolean);
    state.columns.forEach((c, i) => c.position = i);
  } catch (err) {
    toast(err.message, 'err');
    selectProject(state.currentProjectId);
  }
}

function attachBoardHandlers() {
  // Add task
  document.querySelectorAll('.add-task').forEach(b => {
    b.addEventListener('click', () => openTaskModal({ column_id: b.dataset.colId }));
  });
  // Click en task → editar
  document.querySelectorAll('.task').forEach(el => {
    el.addEventListener('click', () => {
      const t = state.tasks.find(x => x.id === el.dataset.taskId);
      if (t) openTaskModal(t);
    });
  });
  // Renombrar columna inline
  document.querySelectorAll('.column-head .name').forEach(el => {
    el.addEventListener('blur', async () => {
      const newName = el.textContent.trim();
      const col = state.columns.find(c => c.id === el.dataset.colId);
      if (!col || newName === col.name) return;
      if (!newName) { el.textContent = col.name; return; }
      try {
        await API.updateColumn(col.id, { name: newName });
        col.name = newName;
        toast('Columna renombrada ✓', 'ok');
      } catch (err) {
        toast(err.message, 'err');
        el.textContent = col.name;
      }
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      if (e.key === 'Escape') {
        const col = state.columns.find(c => c.id === el.dataset.colId);
        el.textContent = col?.name || '';
        el.blur();
      }
    });
  });
  // Delete column
  document.querySelectorAll('[data-action="del-col"]').forEach(b => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const col = state.columns.find(c => c.id === b.dataset.colId);
      if (!col) return;
      const tasksInCol = state.tasks.filter(t => t.column_id === col.id).length;
      if (!confirm(`¿Eliminar la columna "${col.name}" y sus ${tasksInCol} tareas?`)) return;
      try {
        await API.deleteColumn(col.id);
        state.columns = state.columns.filter(c => c.id !== col.id);
        state.tasks = state.tasks.filter(t => t.column_id !== col.id);
        renderBoard();
        toast('Columna eliminada', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  });
}

// ---------- Modals ----------
function openCreateProjectModal() {
  const m = openModal(`
    <div class="modal">
      <h2>Nuevo proyecto</h2>
      <div class="modal-sub">Se crearán automáticamente las 4 columnas por defecto.</div>
      <form id="create-proj-form">
        <div class="field">
          <label>Nombre</label>
          <input type="text" id="np-name" required maxlength="80" placeholder="Ej: Migración API v2" autofocus />
        </div>
        <div class="field">
          <label>Descripción (opcional)</label>
          <textarea id="np-desc" maxlength="500" placeholder="Breve descripción"></textarea>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-action="cancel">Cancelar</button>
          <div class="right">
            <button type="submit" class="btn btn-primary">Crear proyecto</button>
          </div>
        </div>
      </form>
    </div>
  `);
  m.querySelector('[data-action="cancel"]').addEventListener('click', () => m._close());
  m.querySelector('#create-proj-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = m.querySelector('#np-name').value.trim();
    const desc = m.querySelector('#np-desc').value.trim();
    try {
      const proj = await API.createProject(name, desc);
      state.projects.unshift(proj);
      state.currentProjectId = proj.id;
      m._close();
      toast('Proyecto creado ✓', 'ok');
      await loadProjects();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

function openEditProjectModal() {
  const proj = state.projects.find(p => p.id === state.currentProjectId);
  if (!proj) return;
  const m = openModal(`
    <div class="modal">
      <h2>Editar proyecto</h2>
      <div class="modal-sub mono">id: ${proj.id}</div>
      <form id="edit-proj-form">
        <div class="field">
          <label>Nombre</label>
          <input type="text" id="ep-name" required maxlength="80" value="${escapeHtml(proj.name)}" autofocus />
        </div>
        <div class="field">
          <label>Descripción</label>
          <textarea id="ep-desc" maxlength="500">${escapeHtml(proj.description || '')}</textarea>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-action="cancel">Cancelar</button>
          <div class="right">
            <button type="submit" class="btn btn-primary">Guardar</button>
          </div>
        </div>
      </form>
    </div>
  `);
  m.querySelector('[data-action="cancel"]').addEventListener('click', () => m._close());
  m.querySelector('#edit-proj-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = m.querySelector('#ep-name').value.trim();
    const desc = m.querySelector('#ep-desc').value.trim();
    try {
      await API.updateProject(proj.id, { name, description: desc || null });
      proj.name = name; proj.description = desc;
      m._close();
      toast('Proyecto actualizado ✓', 'ok');
      renderSidebar();
      document.getElementById('proj-title').textContent = name;
      document.getElementById('proj-subtitle').textContent = desc || `id: ${proj.id.slice(0,8)}…`;
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

async function deleteCurrentProject() {
  try {
    await API.deleteProject(state.currentProjectId);
    state.projects = state.projects.filter(p => p.id !== state.currentProjectId);
    state.currentProjectId = state.projects[0]?.id || null;
    toast('Proyecto eliminado', 'ok');
    await loadProjects();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function openTaskModal(taskOrShell) {
  const isNew = !taskOrShell.id;
  const t = isNew
    ? { title: '', description: '', priority: 'media', due_date: '', labels: [], column_id: taskOrShell.column_id }
    : { ...taskOrShell };

  const m = openModal(`
    <div class="modal">
      <h2>${isNew ? 'Nueva tarea' : 'Editar tarea'}</h2>
      <div class="modal-sub mono">${isNew ? 'Crear nueva tarjeta' : 'id: ' + t.id}</div>
      <form id="task-form">
        <div class="field">
          <label>Título</label>
          <input type="text" id="t-title" required maxlength="200" value="${escapeHtml(t.title)}" autofocus />
        </div>

        <div class="field">
          <label>Descripción</label>
          <textarea id="t-desc" maxlength="2000">${escapeHtml(t.description || '')}</textarea>
        </div>

        <div class="field">
          <label>Prioridad</label>
          <div class="priority-picker" id="t-priority">
            ${['baja','media','alta'].map(p => `
              <button type="button" class="${p === t.priority ? 'selected ' + p : ''}" data-prio="${p}">${PRIORITY_CONFIG[p].label}</button>
            `).join('')}
          </div>
        </div>

        <div class="field">
          <label>Fecha de vencimiento</label>
          <input type="date" id="t-due" value="${t.due_date || ''}" />
        </div>

        <div class="field">
          <label>Etiquetas</label>
          <div class="label-picker" id="t-labels">
            ${LABEL_PRESETS.map(l => {
              const selected = (t.labels || []).some(x => x.name === l.name);
              return `<button type="button" class="label-chip ${selected ? 'selected' : ''}"
                style="background:${l.color}22;color:${l.color};"
                data-label='${JSON.stringify(l)}'>${l.name}</button>`;
            }).join('')}
          </div>
        </div>

        <div class="modal-actions">
          ${!isNew ? `<button type="button" class="btn btn-danger" data-action="delete">🗑 Eliminar</button>` : `<div></div>`}
          <div class="right">
            <button type="button" class="btn btn-ghost" data-action="cancel">Cancelar</button>
            <button type="submit" class="btn btn-primary">${isNew ? 'Crear' : 'Guardar'}</button>
          </div>
        </div>
      </form>
    </div>
  `);

  // State local del modal
  let priority = t.priority;
  let labels = [...(t.labels || [])];

  m.querySelectorAll('#t-priority button').forEach(b => {
    b.addEventListener('click', () => {
      priority = b.dataset.prio;
      m.querySelectorAll('#t-priority button').forEach(x => {
        x.className = '';
        if (x.dataset.prio === priority) x.className = 'selected ' + priority;
      });
    });
  });

  m.querySelectorAll('#t-labels button').forEach(b => {
    b.addEventListener('click', () => {
      const l = JSON.parse(b.dataset.label);
      const idx = labels.findIndex(x => x.name === l.name);
      if (idx >= 0) { labels.splice(idx, 1); b.classList.remove('selected'); }
      else { labels.push(l); b.classList.add('selected'); }
    });
  });

  m.querySelector('[data-action="cancel"]').addEventListener('click', () => m._close());
  m.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
    if (!confirm(`¿Eliminar la tarea "${t.title}"?`)) return;
    try {
      await API.deleteTask(t.id);
      state.tasks = state.tasks.filter(x => x.id !== t.id);
      API.logActivity(state.currentProjectId, 'task_deleted', { task_title: t.title });
      m._close();
      toast('Tarea eliminada', 'ok');
      renderBoard();
    } catch (err) { toast(err.message, 'err'); }
  });

  m.querySelector('#task-form').addEventListener('submit', async e => {
    e.preventDefault();
    const title = m.querySelector('#t-title').value.trim();
    const description = m.querySelector('#t-desc').value.trim();
    const due_date = m.querySelector('#t-due').value || null;

    try {
      if (isNew) {
        const colTasks = state.tasks.filter(x => x.column_id === t.column_id);
        const position = colTasks.length;
        const created = await API.createTask(t.column_id, {
          title, description: description || null, priority, due_date, position, labels
        });
        state.tasks.push(created);
        API.logActivity(state.currentProjectId, 'task_created', { task_title: title });
      } else {
        const updated = await API.updateTask(t.id, {
          title, description: description || null, priority, due_date, labels
        });
        const idx = state.tasks.findIndex(x => x.id === t.id);
        if (idx >= 0) state.tasks[idx] = { ...state.tasks[idx], ...updated };
        API.logActivity(state.currentProjectId, 'task_updated', { task_title: title });
      }
      m._close();
      toast(isNew ? 'Tarea creada ✓' : 'Tarea actualizada ✓', 'ok');
      renderBoard();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

window.openCreateProjectModal = openCreateProjectModal;

// ---------- Add column ----------
async function addColumn() {
  const name = prompt('Nombre de la nueva columna:');
  if (!name || !name.trim()) return;
  try {
    const col = await API.createColumn(state.currentProjectId, name.trim(), state.columns.length);
    state.columns.push(col);
    renderBoard();
    toast('Columna creada ✓', 'ok');
  } catch (err) { toast(err.message, 'err'); }
}
window.addColumn = addColumn;

// ---------- Activity log ----------
async function loadActivity() {
  if (!state.currentProjectId) return;
  try {
    const items = await API.listActivity(state.currentProjectId, 20);
    const panel = document.getElementById('activity-panel');
    const list = document.getElementById('activity-list');
    if (items.length === 0) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';
    list.innerHTML = items.map(it => {
      const who = it.profile?.username ? `@${it.profile.username}` : 'alguien';
      const action = humanizeAction(it.action, it.payload);
      return `
        <div class="activity-row">
          <span class="who">${escapeHtml(who)}</span>
          <span>${action}</span>
          <span class="when">${fmtRelative(it.created_at)}</span>
        </div>`;
    }).join('');
  } catch { /* ignore */ }
}

function humanizeAction(action, p) {
  const t = escapeHtml(p?.task_title || 'una tarea');
  switch (action) {
    case 'task_created': return `creó <b>${t}</b>`;
    case 'task_updated': return `editó <b>${t}</b>`;
    case 'task_deleted': return `eliminó <b>${t}</b>`;
    case 'task_moved':   return `movió <b>${t}</b> de <i>${escapeHtml(p?.from || '?')}</i> a <i>${escapeHtml(p?.to || '?')}</i>`;
    default: return action;
  }
}
