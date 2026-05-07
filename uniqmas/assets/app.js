// =============================================================
// uniq+ · App pública (catálogo + flujo de reserva + contacto)
// =============================================================

const state = {
  servicios: [],
  selServicio: null,
  selFecha: null,
  selHora: null,
  turnosDelDia: [],
  horariosSemana: defaultHorariosSemana(),
  contacto: {}
};

// ---------- Bootstrap ----------
(async function bootstrap() {
  try {
    // En paralelo: servicios + config pública (horarios + contacto)
    const [servicios, config] = await Promise.all([
      API.listarServicios(),
      API.getConfigPublica().catch(err => {
        console.warn('No se pudo cargar configuración pública, uso defaults:', err);
        return { horarios_semana: {}, contacto: {} };
      })
    ]);
    state.servicios = servicios;
    state.horariosSemana = mergeHorarios(config.horarios_semana);
    state.contacto = config.contacto || {};

    renderServiciosLanding();
    renderServiciosBooking();
    renderContacto();
    setupForm();
    setupOkModal();
  } catch (err) {
    console.error('Error inicial:', err);
    document.getElementById('services-grid').innerHTML =
      `<div class="loading-card">⚠️ No se pudieron cargar los servicios. Recargá la página.</div>`;
    toast(err.message, 'err');
  }
})();

function mergeHorarios(raw) {
  const def = defaultHorariosSemana();
  if (!raw || typeof raw !== 'object') return def;
  WEEK_KEYS.forEach(k => {
    if (raw[k] && typeof raw[k] === 'object') {
      def[k] = {
        abierto:  raw[k].abierto !== false && raw[k].abierto !== 'false',
        apertura: (raw[k].apertura || def[k].apertura).slice(0, 5),
        cierre:   (raw[k].cierre   || def[k].cierre).slice(0, 5)
      };
    }
  });
  return def;
}

// ---------- Servicios (landing) ----------
function renderServiciosLanding() {
  const root = document.getElementById('services-grid');
  if (state.servicios.length === 0) {
    root.innerHTML = `<div class="loading-card">Próximamente publicamos los servicios disponibles.</div>`;
    return;
  }
  root.innerHTML = state.servicios.map(s => `
    <article class="service-card">
      <div class="service-emoji">${s.emoji}</div>
      <h3>${escapeHtml(s.nombre)}</h3>
      <p class="desc">${escapeHtml(s.descripcion || '')}</p>
      <div class="meta">
        <span class="pill">⏱ ${s.duracion_min} min</span>
        ${s.capacidad > 1 ? `<span class="pill cap">👥 ${s.capacidad} simultáneos</span>` : `<span class="pill cap">🔒 1 a la vez</span>`}
      </div>
      ${(s.precio_min || s.precio_max) ? `
        <div class="price">
          ${s.precio_min && s.precio_max && s.precio_min !== s.precio_max
            ? `Desde <b>${fmtMoney(s.precio_min)}</b> a ${fmtMoney(s.precio_max)}`
            : `<b>${fmtMoney(s.precio_min || s.precio_max)}</b>`}
        </div>` : ''}
      <a href="#reservar" class="reserve" data-pre-select="${s.id}">Reservar →</a>
    </article>
  `).join('');

  root.querySelectorAll('[data-pre-select]').forEach(a => {
    a.addEventListener('click', () => {
      const id = a.dataset.preSelect;
      setTimeout(() => selectServicio(id), 250);
    });
  });
}

// ---------- Servicios (chips dentro del booking) ----------
function renderServiciosBooking() {
  const root = document.getElementById('bk-services');
  if (state.servicios.length === 0) {
    root.innerHTML = `<div class="hint">No hay servicios disponibles ahora.</div>`;
    return;
  }
  root.innerHTML = state.servicios.map(s => `
    <button type="button" class="chip" data-id="${s.id}">
      <span class="chip-emoji">${s.emoji}</span>
      <span>
        ${escapeHtml(s.nombre)}
        <span class="chip-meta">${s.duracion_min} min · ${s.capacidad > 1 ? s.capacidad + ' simultáneos' : '1 a la vez'}</span>
      </span>
    </button>
  `).join('');
  root.querySelectorAll('.chip').forEach(b => {
    b.addEventListener('click', () => selectServicio(b.dataset.id));
  });

  const fechaInput = document.getElementById('bk-fecha');
  fechaInput.min = todayIso();
  const max = new Date();
  max.setDate(max.getDate() + 90);
  fechaInput.max = `${max.getFullYear()}-${pad(max.getMonth()+1)}-${pad(max.getDate())}`;
  fechaInput.addEventListener('change', () => selectFecha(fechaInput.value));
}

function selectServicio(id) {
  const s = state.servicios.find(x => x.id === id);
  if (!s) return;
  state.selServicio = s;
  state.selHora = null;
  state.turnosDelDia = [];

  document.querySelectorAll('#bk-services .chip').forEach(c => {
    c.classList.toggle('selected', c.dataset.id === id);
  });
  document.getElementById('step-fecha').classList.remove('disabled');
  document.getElementById('step-hora').classList.add('disabled');
  document.getElementById('step-datos').classList.add('disabled');
  document.getElementById('bk-slots').innerHTML = `<div class="hint">Elegí un día.</div>`;

  if (state.selFecha) selectFecha(state.selFecha);
}

async function selectFecha(fechaIso) {
  if (!fechaIso) return;
  if (!state.selServicio) { toast('Primero elegí un servicio', 'err'); return; }
  state.selFecha = fechaIso;
  state.selHora = null;
  document.getElementById('step-hora').classList.remove('disabled');
  document.getElementById('step-datos').classList.add('disabled');

  const slotsRoot = document.getElementById('bk-slots');

  // Validar día abierto en el cliente para feedback inmediato
  const diaKey = diaKeyFromIso(fechaIso);
  const cfgDia = state.horariosSemana[diaKey];
  if (!cfgDia || !cfgDia.abierto) {
    slotsRoot.innerHTML = `<div class="hint hint-warn">El salón no abre los <b>${WEEK_LABELS[diaKey].toLowerCase()}</b>. Probá otro día.</div>`;
    return;
  }

  slotsRoot.innerHTML = `<div class="hint">Cargando disponibilidad…</div>`;
  try {
    const turnos = await API.turnosDelDia(fechaIso, state.selServicio.id);
    state.turnosDelDia = turnos;
    renderSlots();
  } catch (err) {
    slotsRoot.innerHTML = `<div class="hint" style="color:var(--danger)">${escapeHtml(err.message)}</div>`;
  }
}

function renderSlots() {
  const slotsRoot = document.getElementById('bk-slots');
  const s = state.selServicio;
  if (!s || !state.selFecha) return;

  const diaKey  = diaKeyFromIso(state.selFecha);
  const cfgDia  = state.horariosSemana[diaKey];
  if (!cfgDia || !cfgDia.abierto) {
    slotsRoot.innerHTML = `<div class="hint hint-warn">El salón no abre los <b>${WEEK_LABELS[diaKey].toLowerCase()}</b>.</div>`;
    return;
  }
  const apertura = cfgDia.apertura;
  const cierre   = cfgDia.cierre;
  const duracion = s.duracion_min;
  const cap      = s.capacidad;

  const slots = [];
  let cur = apertura;
  while (true) {
    const fin = addMinutesToHm(cur, duracion);
    if (fin > cierre) break;
    slots.push(cur);
    cur = fin;
  }

  if (slots.length === 0) {
    slotsRoot.innerHTML = `<div class="hint">No hay slots disponibles para este servicio en el horario de ese día (${apertura} – ${cierre}).</div>`;
    return;
  }

  const today = todayIso();
  const now = nowHm();

  slotsRoot.innerHTML = slots.map(hi => {
    const hf = addMinutesToHm(hi, duracion);
    const reserved = state.turnosDelDia.filter(t => {
      const ti = (t.hora_inicio || '').slice(0, 5);
      const tf = (t.hora_fin || '').slice(0, 5);
      return ti < hf && tf > hi;
    }).length;
    const isPast = state.selFecha < today || (state.selFecha === today && hi <= now);
    const isFull = reserved >= cap;
    const isSel  = state.selHora === hi;

    let cls = 'slot';
    if (isPast) cls += ' past';
    else if (isFull) cls += ' full';
    if (isSel) cls += ' selected';

    const capLabel = cap > 1
      ? (isPast ? 'pasado' : (isFull ? 'lleno' : `${cap - reserved}/${cap} libres`))
      : (isPast ? 'pasado' : (isFull ? 'reservado' : 'libre'));

    return `<button type="button" class="${cls}" data-hi="${hi}" ${isPast || isFull ? 'disabled' : ''}>
      ${hi}
      <span class="slot-cap">${capLabel}</span>
    </button>`;
  }).join('');

  slotsRoot.querySelectorAll('button.slot').forEach(b => {
    b.addEventListener('click', () => {
      if (b.disabled) return;
      state.selHora = b.dataset.hi;
      renderSlots();
      document.getElementById('step-datos').classList.remove('disabled');
      renderResumen();
      document.getElementById('bk-nombre').focus({ preventScroll: false });
    });
  });
}

function renderResumen() {
  const r = document.getElementById('bk-resumen');
  if (!state.selServicio || !state.selFecha || !state.selHora) {
    r.innerHTML = '';
    return;
  }
  const s = state.selServicio;
  r.innerHTML = `
    <b>${s.emoji} ${escapeHtml(s.nombre)}</b><br/>
    📅 ${fmtFecha(state.selFecha)}<br/>
    🕒 ${state.selHora} · duración: ${s.duracion_min} min
  `;
}

// ---------- Form de datos ----------
function setupForm() {
  document.getElementById('bk-form').addEventListener('submit', async e => {
    e.preventDefault();
    const err = document.getElementById('bk-error');
    const submit = document.getElementById('bk-submit');
    err.textContent = '';

    if (!state.selServicio || !state.selFecha || !state.selHora) {
      err.textContent = 'Completá los pasos 1, 2 y 3 antes de confirmar.';
      return;
    }
    const nombre = document.getElementById('bk-nombre').value.trim();
    const tel    = document.getElementById('bk-tel').value.trim();
    const email  = document.getElementById('bk-email').value.trim();
    const notas  = document.getElementById('bk-notas').value.trim();
    if (nombre.length < 2) {
      err.textContent = 'Decinos tu nombre para reservar.';
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Reservando…';
    try {
      const turno = await API.reservar({
        servicio_id:    state.selServicio.id,
        cliente_nombre: nombre,
        cliente_tel:    tel,
        cliente_email:  email,
        fecha:          state.selFecha,
        hora_inicio:    state.selHora,
        notas
      });
      const okText = document.getElementById('ok-text');
      okText.innerHTML = `
        Te esperamos para tu turno de <b>${escapeHtml(state.selServicio.nombre)}</b><br/>
        el <b>${fmtFecha(turno.fecha)}</b> a las <b>${fmtHora(turno.hora_inicio)} hs</b>.<br/><br/>
        Si necesitás cancelar o reprogramar, llamanos al teléfono del salón.
      `;
      openOkModal();
      document.getElementById('bk-form').reset();
      state.selHora = null;
      const turnos = await API.turnosDelDia(state.selFecha, state.selServicio.id);
      state.turnosDelDia = turnos;
      renderSlots();
      renderResumen();
      document.getElementById('step-datos').classList.add('disabled');
    } catch (ex) {
      console.error(ex);
      err.textContent = ex.message || 'No se pudo reservar el turno';
    } finally {
      submit.disabled = false;
      submit.textContent = 'Confirmar mi turno';
    }
  });
}

// ---------- Contacto ----------
function renderContacto() {
  const c = state.contacto || {};
  const direccion = (c.direccion || '').trim();
  const telVis    = (c.telefono  || '').trim();
  const waNum     = onlyDigits(c.wa_numero || c.telefono || '');
  const email     = (c.email     || '').trim();
  const mapaQ     = (c.mapa_query || direccion || '').trim();

  // Dirección (link a Google Maps)
  const dirA = document.getElementById('ct-direccion');
  if (direccion) {
    dirA.textContent = direccion;
    dirA.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(direccion)}`;
    showRow('ct-row-direccion', true);
  } else {
    showRow('ct-row-direccion', false);
  }

  // Teléfono → WhatsApp
  const telA = document.getElementById('ct-telefono');
  if (telVis || waNum) {
    telA.textContent = telVis || ('+' + waNum);
    if (waNum) {
      telA.href = `https://wa.me/${waNum}?text=${encodeURIComponent('Hola uniq+, quisiera consultar por un turno.')}`;
    } else {
      telA.href = '#';
      telA.removeAttribute('target');
    }
    showRow('ct-row-telefono', true);
  } else {
    showRow('ct-row-telefono', false);
  }

  // Email
  const mailA = document.getElementById('ct-email');
  if (email) {
    mailA.textContent = email;
    mailA.href = 'mailto:' + email;
    showRow('ct-row-email', true);
  } else {
    showRow('ct-row-email', false);
  }

  // Horario semanal compactado
  const horarioEl = document.getElementById('ct-horario');
  horarioEl.innerHTML = horarioCompactoHtml(state.horariosSemana);

  // Redes sociales
  const redesEl = document.getElementById('ct-redes');
  const redes = [];
  if (c.instagram) redes.push({ label: 'Instagram', icon: 'IG', url: ensureUrl(c.instagram, 'https://instagram.com/') });
  if (c.facebook)  redes.push({ label: 'Facebook',  icon: 'FB', url: ensureUrl(c.facebook,  'https://facebook.com/')  });
  if (c.tiktok)    redes.push({ label: 'TikTok',    icon: 'TT', url: ensureUrl(c.tiktok,    'https://tiktok.com/@')   });
  if (redes.length) {
    redesEl.innerHTML = redes.map(r =>
      `<a href="${escapeAttr(r.url)}" target="_blank" rel="noopener" class="red-pill" aria-label="${r.label}">
         <span class="red-ico">${r.icon}</span><span>${r.label}</span>
       </a>`).join('');
    redesEl.style.display = '';
  } else {
    redesEl.innerHTML = '';
    redesEl.style.display = 'none';
  }

  // Mapa
  const mapEl = document.getElementById('ct-map');
  const mapCard = document.getElementById('ct-map-card');
  if (mapaQ) {
    mapEl.src = `https://www.google.com/maps?q=${encodeURIComponent(mapaQ)}&output=embed`;
    mapCard.style.display = '';
  } else {
    mapEl.src = 'about:blank';
    mapCard.style.display = 'none';
  }
}

function showRow(id, visible) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = visible ? '' : 'none';
}
function onlyDigits(s) { return String(s || '').replace(/\D+/g, ''); }
function ensureUrl(s, base) {
  s = String(s || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return base + s.replace(/^@/, '');
}
function escapeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }

// Devuelve algo como: "Lun a Vie · 9:00 a 20:00 — Sáb · 10:00 a 18:00 — Dom: cerrado"
function horarioCompactoHtml(horarios) {
  // Agrupamos días consecutivos con el mismo horario / cerrado.
  const groups = [];
  let curr = null;
  WEEK_KEYS.forEach(k => {
    const d = horarios[k] || { abierto: false };
    const sig = d.abierto ? `${d.apertura}-${d.cierre}` : 'CERRADO';
    if (curr && curr.sig === sig) {
      curr.end = k;
    } else {
      curr = { sig, start: k, end: k };
      groups.push(curr);
    }
  });

  return groups.map(g => {
    const lbl = g.start === g.end
      ? WEEK_LABELS[g.start].slice(0,3)
      : `${WEEK_LABELS[g.start].slice(0,3)} a ${WEEK_LABELS[g.end].slice(0,3)}`;
    if (g.sig === 'CERRADO') return `<span class="ho-grp ho-closed">${lbl}: cerrado</span>`;
    const [ap, ci] = g.sig.split('-');
    return `<span class="ho-grp">${lbl} · ${ap} a ${ci}</span>`;
  }).join('<br/>');
}

// ---------- OK Modal ----------
function setupOkModal() {
  const overlay = document.getElementById('ok-modal');
  const close = document.getElementById('ok-close');
  close.addEventListener('click', closeOkModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeOkModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('show')) closeOkModal();
  });
}
function openOkModal() {
  const overlay = document.getElementById('ok-modal');
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => overlay.classList.add('show'));
}
function closeOkModal() {
  const overlay = document.getElementById('ok-modal');
  overlay.classList.remove('show');
  setTimeout(() => overlay.classList.add('hidden'), 250);
}
