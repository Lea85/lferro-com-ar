// =============================================================
// Admin: cargar resultados, crear/borrar partidos, recalcular,
//        crear llaves de fases eliminatorias.
//
// Login hardcodeado: leandro / Prode2026
// El password también es el "secret" enviado a Supabase para
// validar las RPC admin_*.
// =============================================================

const ADMIN_USER = 'leandro';
const ADMIN_PASS = 'Prode2026';

let teams = [];
let matches = [];

const PHASES = [
  { id: 'group', label: 'Fase de Grupos' },
  { id: 'r32',   label: '32avos' },
  { id: 'r16',   label: 'Octavos' },
  { id: 'qf',    label: 'Cuartos' },
  { id: 'sf',    label: 'Semifinal' },
  { id: 'tp',    label: '3er Puesto' },
  { id: 'final', label: 'Final' }
];

// === Auth ===
const stored = AdminSession.get();
if (stored === ADMIN_PASS) {
  start();
} else {
  showLogin();
}

function showLogin() {
  document.getElementById('admin-gate').classList.remove('hidden');
  document.getElementById('admin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = document.getElementById('admin-user').value.trim().toLowerCase();
    const p = document.getElementById('admin-pass').value;
    const err = document.getElementById('admin-error');
    const btn = document.getElementById('admin-submit');
    err.textContent = '';

    if (u !== ADMIN_USER || p !== ADMIN_PASS) {
      err.textContent = 'Credenciales inválidas';
      return;
    }
    btn.disabled = true; btn.textContent = 'Verificando…';
    try {
      // Doble validación contra el server por si cambiaron el secret en Supabase
      await API.adminValidate(p);
      AdminSession.set(p);
      document.getElementById('admin-gate').classList.add('hidden');
      start();
    } catch (ex) {
      err.textContent = ex.message + ' (¿cambiaste el admin_secret en Supabase?)';
    } finally {
      btn.disabled = false; btn.textContent = 'Ingresar';
    }
  });
}

function logout() {
  AdminSession.clear();
  location.reload();
}

async function start() {
  document.getElementById('admin-user-box').innerHTML = `
    <span class="user-name">🔐 admin</span>
    <button class="btn-ghost" id="admin-logout">Salir</button>
  `;
  document.getElementById('admin-logout').addEventListener('click', logout);
  await loadAndRender();

  if (sb) {
    sb.channel('fifa-admin')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, loadAndRender)
      .subscribe();
  }
}

async function loadAndRender() {
  try {
    [teams, matches] = await Promise.all([API.listTeams(), API.listMatches()]);
    render();
  } catch (err) {
    document.getElementById('admin-root').innerHTML =
      `<div class="empty-state"><div class="e-emoji">⚠️</div>${escapeHtml(err.message)}</div>`;
  }
}

function render() {
  const root = document.getElementById('admin-root');
  root.innerHTML = `
    ${renderCreateMatchSection()}
    ${renderResultsSection()}
    ${renderToolsSection()}
  `;
  attachHandlers();
}

// ==================== Crear partido ====================
function renderCreateMatchSection() {
  const teamOpts = teams.map(t =>
    `<option value="${t.id}">${escapeHtml(t.name)}${t.group_letter ? ' (Gr.'+t.group_letter+')' : ''}</option>`
  ).join('');
  const phaseOpts = PHASES.map(p => `<option value="${p.id}">${p.label}</option>`).join('');

  return `
    <section class="admin-section">
      <h2>➕ Crear / habilitar partido</h2>
      <p style="color:var(--ink-mute);font-size:13px;margin:-8px 0 14px;">
        Para fases eliminatorias, elegí la fase y opcionalmente el slot de bracket (ej: <code>QF1</code>, <code>SF2</code>).
      </p>
      <form id="create-match-form" class="admin-form-row">
        <div>
          <label>Local</label>
          <select id="cm-home" required>${teamOpts}</select>
        </div>
        <div>
          <label>Visitante</label>
          <select id="cm-away" required>${teamOpts}</select>
        </div>
        <div>
          <label>Fecha y hora</label>
          <input type="datetime-local" id="cm-start" required />
        </div>
        <div>
          <label>Fase</label>
          <select id="cm-phase">${phaseOpts}</select>
        </div>
        <div>
          <label>Bracket (opcional)</label>
          <input type="text" id="cm-slot" placeholder="QF1, SF1…" maxlength="10" />
        </div>
        <button class="btn-primary" type="submit" style="grid-column:1/-1;margin-top:6px;">Crear partido</button>
      </form>
    </section>
  `;
}

// ==================== Cargar resultados ====================
function renderResultsSection() {
  const sorted = [...matches].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  if (sorted.length === 0) {
    return `
      <section class="admin-section">
        <h2>📊 Cargar resultados</h2>
        <div class="empty-state"><div class="e-emoji">⚽</div>No hay partidos cargados.</div>
      </section>
    `;
  }
  return `
    <section class="admin-section">
      <h2>📊 Cargar resultados</h2>
      <p style="color:var(--ink-mute);font-size:13px;margin:-8px 0 14px;">
        Al cargar el resultado, los puntos de las predicciones se recalculan automáticamente (trigger en BD).
      </p>
      ${sorted.map(adminMatchRow).join('')}
    </section>
  `;
}

function adminMatchRow(m) {
  const phaseTag = `<span class="tag ${m.phase}">${PHASE_LABELS[m.phase] || m.phase}</span>`;
  const finishedTag = m.finished ? `<span class="tag finished">JUGADO</span>` : '';
  return `
    <div class="admin-match-row" data-mid="${m.id}">
      <div class="teams-mini">
        <span class="flag" style="display:inline-block;width:24px;height:16px;background-image:url('${flagUrl(m.home_cc)}');background-size:cover;border-radius:2px;"></span>
        <span style="font-weight:600;">${escapeHtml(m.home_name)}</span>
        <span style="color:var(--ink-mute)"> vs </span>
        <span style="font-weight:600;">${escapeHtml(m.away_name)}</span>
        <span class="flag" style="display:inline-block;width:24px;height:16px;background-image:url('${flagUrl(m.away_cc)}');background-size:cover;border-radius:2px;"></span>
        ${phaseTag} ${finishedTag}
      </div>
      <div class="when">${fmtDateTime(m.start_time)}</div>
      <input type="number" min="0" max="30" class="score-input adm-home"
             value="${m.home_goals ?? ''}" placeholder="–" />
      <input type="number" min="0" max="30" class="score-input adm-away"
             value="${m.away_goals ?? ''}" placeholder="–" />
      <button class="btn-primary btn-sm adm-save">Guardar</button>
      <button class="btn-danger btn-sm adm-del" title="Borrar partido">🗑</button>
    </div>
  `;
}

// ==================== Tools ====================
function renderToolsSection() {
  return `
    <section class="admin-section">
      <h2>⚙️ Herramientas</h2>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn-gold" id="tool-recalc">🔄 Recalcular todos los puntos</button>
        <button class="btn-ghost" id="tool-bracket-info" disabled style="opacity:0.5;">🏆 Vista de llaves (próximamente)</button>
      </div>
      <p style="color:var(--ink-mute);font-size:12px;margin-top:10px;">
        El recálculo es por si modificaste manualmente predicciones o querés forzar la actualización tras un cambio en los puntajes.
      </p>
    </section>
  `;
}

// ==================== Handlers ====================
function attachHandlers() {
  // Crear partido
  const cf = document.getElementById('create-match-form');
  if (cf) {
    cf.addEventListener('submit', async e => {
      e.preventDefault();
      const home = parseInt(document.getElementById('cm-home').value, 10);
      const away = parseInt(document.getElementById('cm-away').value, 10);
      const startLocal = document.getElementById('cm-start').value;
      const phase = document.getElementById('cm-phase').value;
      const slot = document.getElementById('cm-slot').value.trim() || null;

      if (home === away) { toast('Local y visitante deben ser distintos', 'err'); return; }
      if (!startLocal) { toast('Fecha requerida', 'err'); return; }

      const startISO = new Date(startLocal).toISOString();
      try {
        await API.adminCreateMatch(AdminSession.get(), home, away, startISO, phase, slot);
        toast('Partido creado ✅', 'ok');
        await loadAndRender();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  }

  // Resultados
  document.querySelectorAll('.admin-match-row').forEach(row => {
    const mid = row.dataset.mid;
    row.querySelector('.adm-save').addEventListener('click', async () => {
      const h = row.querySelector('.adm-home').value;
      const a = row.querySelector('.adm-away').value;
      const home = h === '' ? null : parseInt(h, 10);
      const away = a === '' ? null : parseInt(a, 10);
      try {
        await API.adminSetResult(AdminSession.get(), mid, home, away);
        toast(home == null ? 'Resultado limpiado' : `Resultado ${home}-${away} guardado ✅`, 'ok');
        await loadAndRender();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    row.querySelector('.adm-del').addEventListener('click', async () => {
      if (!confirm('¿Borrar este partido y sus predicciones?')) return;
      try {
        await API.adminDeleteMatch(AdminSession.get(), mid);
        toast('Partido eliminado', 'ok');
        await loadAndRender();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  });

  // Tools
  document.getElementById('tool-recalc')?.addEventListener('click', async () => {
    try {
      await API.adminRecalcAll(AdminSession.get());
      toast('Recalculado ✅', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}
