// =============================================================
// uniq+ · Panel admin
// Login: usuario "admin" + secret guardado en turnero_settings
// =============================================================

const ADMIN_USER = 'admin';
const SESSION_KEY = 'uniqmas-admin-secret';

const adm = {
  secret: null,
  servicios: [],
  agendaFecha: null,
  turnos: [],
  editingTurno: null,
  editingServ: null,
  settings: {}
};

// ---------- Toggle ojito password ----------
document.addEventListener('click', e => {
  const btn = e.target.closest && e.target.closest('.pwd-toggle');
  if (!btn) return;
  e.preventDefault();
  const id = btn.dataset.target;
  const input = id ? document.getElementById(id) : btn.parentElement.querySelector('input');
  if (!input) return;
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.textContent = showing ? '👁' : '🙈';
});

// ---------- Bootstrap ----------
(async function bootstrap() {
  const stored = localStorage.getItem(SESSION_KEY);
  if (stored) {
    try {
      await API.adminPing(stored);
      adm.secret = stored;
      await startPanel();
      return;
    } catch {
      localStorage.removeItem(SESSION_KEY);
    }
  }
  showLogin();
})();

function showLogin() {
  document.getElementById('adm-login-wrap').classList.remove('hidden');
  document.getElementById('adm-panel').classList.add('hidden');
  document.getElementById('adm-nav').style.display = 'none';
  document.getElementById('adm-logout').style.display = 'none';

  const form = document.getElementById('adm-login-form');
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const u = document.getElementById('adm-user').value.trim().toLowerCase();
    const p = document.getElementById('adm-pass').value;
    const err = document.getElementById('adm-login-err');
    const btn = document.getElementById('adm-login-submit');
    err.textContent = '';
    if (u !== ADMIN_USER) { err.textContent = `Usuario incorrecto. Probá con "${ADMIN_USER}".`; return; }
    btn.disabled = true; btn.textContent = 'Verificando…';
    try {
      await API.adminPing(p);
      localStorage.setItem(SESSION_KEY, p);
      adm.secret = p;
      await startPanel();
    } catch (ex) {
      err.textContent = ex.message + ' (¿corriste el SQL del turnero en Supabase?)';
    } finally {
      btn.disabled = false; btn.textContent = 'Ingresar';
    }
  });
}

async function startPanel() {
  document.getElementById('adm-login-wrap').classList.add('hidden');
  document.getElementById('adm-panel').classList.remove('hidden');
  document.getElementById('adm-nav').style.display = '';
  document.getElementById('adm-logout').style.display = '';

  document.getElementById('adm-logout').onclick = () => {
    if (!confirm('¿Cerrar sesión?')) return;
    localStorage.removeItem(SESSION_KEY);
    location.reload();
  };

  // Tabs
  document.querySelectorAll('.tab').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  // Init agenda con hoy
  adm.agendaFecha = todayIso();
  document.getElementById('agenda-date').value = adm.agendaFecha;
  document.getElementById('agenda-date').addEventListener('change', e => loadAgenda(e.target.value));
  document.getElementById('agenda-prev').addEventListener('click', () => shiftDate(-1));
  document.getElementById('agenda-next').addEventListener('click', () => shiftDate(1));
  document.getElementById('agenda-today').addEventListener('click', () => loadAgenda(todayIso()));
  document.getElementById('agenda-refresh').addEventListener('click', () => loadAgenda(adm.agendaFecha));

  // Pre-cargar servicios
  try {
    adm.servicios = await API.adminListarServicios(adm.secret);
  } catch (err) { toast(err.message, 'err'); }

  await loadAgenda(adm.agendaFecha);

  // Setup tab modals
  setupTurnoModal();
  setupServicioModal();
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.adm-tab').forEach(s => s.classList.add('hidden'));
  const target = document.getElementById('tab-' + name);
  if (target) target.classList.remove('hidden');
  if (name === 'servicios') renderServiciosAdmin();
  if (name === 'ajustes')   loadAjustes();
}

function shiftDate(delta) {
  const d = new Date(adm.agendaFecha + 'T00:00');
  d.setDate(d.getDate() + delta);
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  document.getElementById('agenda-date').value = iso;
  loadAgenda(iso);
}

// ---------- Agenda ----------
async function loadAgenda(fecha) {
  adm.agendaFecha = fecha;
  const root = document.getElementById('agenda-root');
  root.innerHTML = `<div class="loading-card">Cargando agenda…</div>`;
  try {
    adm.turnos = await API.adminListarTurnos(adm.secret, fecha);
    renderAgenda();
  } catch (err) {
    root.innerHTML = `<div class="empty-day">⚠️ ${escapeHtml(err.message)}</div>`;
  }
}

function renderAgenda() {
  const root = document.getElementById('agenda-root');
  const stats = document.getElementById('agenda-stats');
  const total = adm.turnos.length;
  const activos = adm.turnos.filter(t => !t.cancelado).length;

  // Stats
  const porServ = {};
  adm.turnos.filter(t => !t.cancelado).forEach(t => {
    porServ[t.servicio_id] = (porServ[t.servicio_id] || 0) + 1;
  });
  stats.innerHTML = `
    <span class="stat-pill">📅 <b>${escapeHtml(fmtFecha(adm.agendaFecha))}</b></span>
    <span class="stat-pill">Total: <b>${total}</b></span>
    <span class="stat-pill">Activos: <b>${activos}</b></span>
    ${Object.entries(porServ).map(([id, n]) => {
      const s = adm.servicios.find(x => x.id === id);
      return `<span class="stat-pill">${s ? s.emoji : '✨'} ${escapeHtml(s?.nombre || id)}: <b>${n}</b></span>`;
    }).join('')}
  `;

  if (total === 0) {
    root.innerHTML = `<div class="empty-day">📭 No hay turnos para este día.</div>`;
    return;
  }

  root.innerHTML = adm.turnos.map(t => {
    const s = adm.servicios.find(x => x.id === t.servicio_id);
    const dur = s ? s.duracion_min : '';
    const tel = t.cliente_telefono ? `<span><span class="ico">📞</span> ${escapeHtml(t.cliente_telefono)}</span>` : '';
    const eml = t.cliente_email ? `<span><span class="ico">📧</span> ${escapeHtml(t.cliente_email)}</span>` : '';
    const notas = t.notas ? `<span><span class="ico">📝</span> ${escapeHtml(t.notas)}</span>` : '';
    return `
      <div class="turno-card ${t.cancelado ? 'cancelado' : ''}" data-id="${t.id}">
        <div class="t-time">
          ${fmtHora(t.hora_inicio)}
          <span class="t-dur">${fmtHora(t.hora_inicio)} – ${fmtHora(t.hora_fin)}${dur ? ' · ' + dur + ' min' : ''}</span>
        </div>
        <div class="t-info">
          <div class="t-name">${escapeHtml(t.cliente_nombre)} ${t.cancelado ? '<span class="t-cancelado-tag">cancelado</span>' : ''}</div>
          <div class="t-meta">${tel}${eml}${notas}</div>
        </div>
        <div class="t-serv">${s ? s.emoji : '✨'} ${escapeHtml(s?.nombre || t.servicio_id)}</div>
      </div>
    `;
  }).join('');

  root.querySelectorAll('.turno-card').forEach(card => {
    card.addEventListener('click', () => openTurnoModal(card.dataset.id));
  });
}

// ---------- Modal de turno ----------
function setupTurnoModal() {
  const overlay = document.getElementById('turno-modal');
  document.getElementById('tm-cancel').addEventListener('click', () => closeOverlay(overlay));
  overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(overlay); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('show')) closeOverlay(overlay);
  });

  document.getElementById('tm-cancelar').addEventListener('click', async () => {
    if (!adm.editingTurno) return;
    const motivo = prompt('Motivo de la cancelación (opcional):') || null;
    if (motivo === null && !confirm('¿Cancelar el turno sin motivo?')) return;
    try {
      await API.adminCancelarTurno(adm.secret, adm.editingTurno.id, motivo);
      toast('Turno cancelado', 'ok');
      closeOverlay(overlay);
      await loadAgenda(adm.agendaFecha);
    } catch (err) { toast(err.message, 'err'); }
  });

  document.getElementById('turno-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!adm.editingTurno) return;
    const err = document.getElementById('tm-err');
    err.textContent = '';
    try {
      await API.adminActualizarTurno(adm.secret, adm.editingTurno.id, {
        cliente_nombre: document.getElementById('tm-nombre').value.trim(),
        cliente_tel:    document.getElementById('tm-tel').value.trim(),
        cliente_email:  document.getElementById('tm-email').value.trim(),
        fecha:          document.getElementById('tm-fecha').value,
        hora_inicio:    document.getElementById('tm-hora').value + ':00',
        notas:          document.getElementById('tm-notas').value.trim()
      });
      toast('Turno actualizado ✓', 'ok');
      closeOverlay(overlay);
      await loadAgenda(adm.agendaFecha);
    } catch (ex) { err.textContent = ex.message; }
  });
}

function openTurnoModal(id) {
  const t = adm.turnos.find(x => x.id === id);
  if (!t) return;
  adm.editingTurno = t;
  document.getElementById('tm-nombre').value = t.cliente_nombre || '';
  document.getElementById('tm-tel').value = t.cliente_telefono || '';
  document.getElementById('tm-email').value = t.cliente_email || '';
  document.getElementById('tm-fecha').value = t.fecha;
  document.getElementById('tm-hora').value = (t.hora_inicio || '').slice(0, 5);
  document.getElementById('tm-notas').value = t.notas || '';
  document.getElementById('tm-err').textContent = '';
  document.getElementById('tm-cancelar').style.display = t.cancelado ? 'none' : '';
  openOverlay(document.getElementById('turno-modal'));
}

// ---------- Servicios ----------
function renderServiciosAdmin() {
  const root = document.getElementById('serv-root');
  if (adm.servicios.length === 0) {
    root.innerHTML = `<div class="loading-card">No hay servicios cargados.</div>`;
    return;
  }
  root.innerHTML = adm.servicios.map(s => `
    <div class="serv-card ${s.activo ? '' : 'inactivo'}">
      <div class="serv-card-head">
        <div class="serv-emoji">${s.emoji}</div>
        <label class="switch" title="Activar / desactivar">
          <input type="checkbox" data-toggle-serv="${s.id}" ${s.activo ? 'checked' : ''}>
          <span class="switch-slider"></span>
          <span class="switch-label">${s.activo ? 'activo' : 'inactivo'}</span>
        </label>
      </div>
      <h3>${escapeHtml(s.nombre)}</h3>
      <div class="serv-desc">${escapeHtml(s.descripcion || '')}</div>
      <div class="serv-meta">
        <span class="pill">⏱ ${s.duracion_min} min</span>
        <span class="pill">${s.capacidad > 1 ? '👥 ' + s.capacidad + ' simultáneos' : '🔒 1 a la vez'}</span>
        ${(s.precio_min || s.precio_max) ? `<span class="pill gold">💰 ${fmtMoney(s.precio_min || 0)}${s.precio_max && s.precio_max !== s.precio_min ? ' – ' + fmtMoney(s.precio_max) : ''}</span>` : ''}
      </div>
      <div class="serv-actions">
        <button class="btn btn-primary" type="button" data-edit-serv="${s.id}">Editar</button>
      </div>
    </div>
  `).join('');
  root.querySelectorAll('[data-edit-serv]').forEach(b => {
    b.addEventListener('click', () => openServicioModal(b.dataset.editServ));
  });
  root.querySelectorAll('[data-toggle-serv]').forEach(c => {
    c.addEventListener('change', () => toggleServicioActivo(c.dataset.toggleServ, c.checked));
  });
}

async function toggleServicioActivo(id, activo) {
  const s = adm.servicios.find(x => x.id === id);
  if (!s) return;
  try {
    const updated = await API.adminActualizarServicio(adm.secret, id, {
      nombre:       s.nombre,
      emoji:        s.emoji,
      descripcion:  s.descripcion,
      duracion_min: s.duracion_min,
      capacidad:    s.capacidad,
      precio_min:   s.precio_min,
      precio_max:   s.precio_max,
      activo
    });
    const idx = adm.servicios.findIndex(x => x.id === id);
    if (idx >= 0) adm.servicios[idx] = updated;
    toast(`Servicio ${activo ? 'activado' : 'desactivado'} ✓`, 'ok');
    renderServiciosAdmin();
  } catch (err) {
    toast(err.message, 'err');
    renderServiciosAdmin();
  }
}

function setupServicioModal() {
  const overlay = document.getElementById('serv-modal');
  document.getElementById('sf-cancel').addEventListener('click', () => closeOverlay(overlay));
  overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(overlay); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('show')) closeOverlay(overlay);
  });

  document.getElementById('serv-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!adm.editingServ) return;
    const err = document.getElementById('sf-err');
    err.textContent = '';
    try {
      const updated = await API.adminActualizarServicio(adm.secret, adm.editingServ.id, {
        nombre:       document.getElementById('sf-nombre').value.trim(),
        emoji:        document.getElementById('sf-emoji').value.trim() || '✨',
        descripcion:  document.getElementById('sf-desc').value.trim(),
        duracion_min: parseInt(document.getElementById('sf-dur').value, 10),
        capacidad:    parseInt(document.getElementById('sf-cap').value, 10),
        precio_min:   document.getElementById('sf-pmin').value ? parseInt(document.getElementById('sf-pmin').value, 10) : null,
        precio_max:   document.getElementById('sf-pmax').value ? parseInt(document.getElementById('sf-pmax').value, 10) : null,
        activo:       document.getElementById('sf-activo').checked
      });
      // Actualizar local
      const idx = adm.servicios.findIndex(x => x.id === updated.id);
      if (idx >= 0) adm.servicios[idx] = updated;
      toast('Servicio actualizado ✓', 'ok');
      closeOverlay(overlay);
      renderServiciosAdmin();
    } catch (ex) { err.textContent = ex.message; }
  });
}

function openServicioModal(id) {
  const s = adm.servicios.find(x => x.id === id);
  if (!s) return;
  adm.editingServ = s;
  document.getElementById('serv-modal-title').textContent = `Editar: ${s.nombre}`;
  document.getElementById('sf-emoji').value = s.emoji || '';
  document.getElementById('sf-nombre').value = s.nombre || '';
  document.getElementById('sf-desc').value = s.descripcion || '';
  document.getElementById('sf-dur').value = s.duracion_min;
  document.getElementById('sf-cap').value = s.capacidad;
  document.getElementById('sf-pmin').value = s.precio_min ?? '';
  document.getElementById('sf-pmax').value = s.precio_max ?? '';
  document.getElementById('sf-activo').checked = s.activo;
  document.getElementById('sf-err').textContent = '';
  openOverlay(document.getElementById('serv-modal'));
}

// ---------- Ajustes ----------
async function loadAjustes() {
  try {
    adm.settings = await API.adminGetSettings(adm.secret);
  } catch (err) { toast(err.message, 'err'); return; }

  // ----- Horarios por día de la semana -----
  let horarios;
  try {
    horarios = JSON.parse(adm.settings['horarios_semana'] || 'null') || defaultHorariosSemana();
  } catch { horarios = defaultHorariosSemana(); }
  // merge con defaults para asegurar todas las claves
  const def = defaultHorariosSemana();
  WEEK_KEYS.forEach(k => {
    if (!horarios[k] || typeof horarios[k] !== 'object') horarios[k] = def[k];
    horarios[k].apertura = (horarios[k].apertura || '09:00').slice(0, 5);
    horarios[k].cierre   = (horarios[k].cierre   || '20:00').slice(0, 5);
    horarios[k].abierto  = horarios[k].abierto !== false && horarios[k].abierto !== 'false';
  });

  const wg = document.getElementById('week-grid');
  wg.innerHTML = WEEK_KEYS.map(k => `
    <div class="week-row ${horarios[k].abierto ? '' : 'closed'}" data-day="${k}">
      <label class="week-toggle">
        <input type="checkbox" data-week-open ${horarios[k].abierto ? 'checked' : ''}>
        <span class="week-day">${WEEK_LABELS[k]}</span>
      </label>
      <div class="week-times">
        <input type="time" data-week-from value="${horarios[k].apertura}" ${horarios[k].abierto ? '' : 'disabled'} />
        <span class="sep">→</span>
        <input type="time" data-week-to   value="${horarios[k].cierre}"   ${horarios[k].abierto ? '' : 'disabled'} />
      </div>
    </div>
  `).join('');

  wg.querySelectorAll('[data-week-open]').forEach(chk => {
    chk.addEventListener('change', () => {
      const row = chk.closest('.week-row');
      const open = chk.checked;
      row.classList.toggle('closed', !open);
      row.querySelectorAll('input[type="time"]').forEach(i => i.disabled = !open);
    });
  });

  document.getElementById('set-week-save').onclick = async () => {
    const out = {};
    let valid = true;
    wg.querySelectorAll('.week-row').forEach(row => {
      const k = row.dataset.day;
      const open = row.querySelector('[data-week-open]').checked;
      const from = row.querySelector('[data-week-from]').value || '09:00';
      const to   = row.querySelector('[data-week-to]').value   || '20:00';
      if (open && to <= from) valid = false;
      out[k] = { abierto: open, apertura: from, cierre: to };
    });
    if (!valid) { toast('Hay días con cierre menor o igual a la apertura.', 'err'); return; }
    try {
      await API.adminSetSetting(adm.secret, 'horarios_semana', JSON.stringify(out));
      toast('Horarios guardados ✓', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };

  // ----- Datos de contacto -----
  let contacto = {};
  try { contacto = JSON.parse(adm.settings['contacto'] || '{}') || {}; } catch { contacto = {}; }
  document.getElementById('ct-set-direccion').value = contacto.direccion  || '';
  document.getElementById('ct-set-telefono').value  = contacto.telefono   || '';
  document.getElementById('ct-set-wa').value        = contacto.wa_numero  || '';
  document.getElementById('ct-set-email').value     = contacto.email      || '';
  document.getElementById('ct-set-mapa').value      = contacto.mapa_query || '';
  document.getElementById('ct-set-ig').value        = contacto.instagram  || '';
  document.getElementById('ct-set-fb').value        = contacto.facebook   || '';
  document.getElementById('ct-set-tt').value        = contacto.tiktok     || '';

  document.getElementById('set-contacto-save').onclick = async () => {
    const out = {
      direccion:  document.getElementById('ct-set-direccion').value.trim(),
      telefono:   document.getElementById('ct-set-telefono').value.trim(),
      wa_numero:  String(document.getElementById('ct-set-wa').value || '').replace(/\D+/g, ''),
      email:      document.getElementById('ct-set-email').value.trim(),
      mapa_query: document.getElementById('ct-set-mapa').value.trim(),
      instagram:  document.getElementById('ct-set-ig').value.trim(),
      facebook:   document.getElementById('ct-set-fb').value.trim(),
      tiktok:     document.getElementById('ct-set-tt').value.trim()
    };
    try {
      await API.adminSetSetting(adm.secret, 'contacto', JSON.stringify(out));
      toast('Contacto guardado ✓', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };

  // ----- Cambiar contraseña -----
  document.getElementById('set-pass-save').onclick = async () => {
    const np = document.getElementById('set-newpass').value;
    if (!np || np.length < 4) { toast('Mínimo 4 caracteres', 'err'); return; }
    if (!confirm('¿Cambiar la contraseña de admin?')) return;
    try {
      await API.adminSetSetting(adm.secret, 'admin_secret', np);
      adm.secret = np;
      localStorage.setItem(SESSION_KEY, np);
      document.getElementById('set-newpass').value = '';
      toast('Contraseña actualizada ✓', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
}

// ---------- Helpers de overlay ----------
function openOverlay(overlay) {
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => overlay.classList.add('show'));
}
function closeOverlay(overlay) {
  overlay.classList.remove('show');
  setTimeout(() => overlay.classList.add('hidden'), 250);
}
