// =============================================================
// uniq+ · App pública (catálogo + flujo de reserva)
// =============================================================

const state = {
  servicios: [],
  selServicio: null,
  selFecha: null,
  selHora: null,
  turnosDelDia: []   // turnos ya reservados para selServicio + selFecha
};

// ---------- Bootstrap ----------
(async function bootstrap() {
  try {
    state.servicios = await API.listarServicios();
    renderServiciosLanding();
    renderServiciosBooking();
    setupForm();
    setupOkModal();
  } catch (err) {
    console.error('Error inicial:', err);
    document.getElementById('services-grid').innerHTML =
      `<div class="loading-card">⚠️ No se pudieron cargar los servicios. Recargá la página.</div>`;
    toast(err.message, 'err');
  }
})();

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
      // Pre-selecciona el servicio en el flujo de reserva
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

  // Setup del input de fecha
  const fechaInput = document.getElementById('bk-fecha');
  fechaInput.min = todayIso();
  // 90 días en el futuro
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

  // Si ya había una fecha elegida, recargo los slots con el nuevo servicio
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

  // Generamos slots cada `duracion_min` desde apertura hasta cierre.
  // Como el horario lo controla settings (default 09-20), lo dejamos hardcoded
  // del lado del cliente con ese default. La RPC valida server-side igual.
  const apertura = '09:00';
  const cierre   = '20:00';
  const duracion = s.duracion_min;
  const cap = s.capacidad;

  const slots = [];
  let cur = apertura;
  while (true) {
    const fin = addMinutesToHm(cur, duracion);
    if (fin > cierre) break;
    slots.push(cur);
    cur = fin;
  }

  if (slots.length === 0) {
    slotsRoot.innerHTML = `<div class="hint">No hay slots disponibles para este servicio.</div>`;
    return;
  }

  // Por cada slot, contamos cuántos turnos del servicio elegido se solapan.
  // Como nuestros slots son discretos y todos del mismo tamaño, basta con
  // matchear hora_inicio contra el slot.
  const today = todayIso();
  const now = nowHm();

  slotsRoot.innerHTML = slots.map(hi => {
    const hf = addMinutesToHm(hi, duracion);
    const reserved = state.turnosDelDia.filter(t => {
      // Solapamiento: t.hora_inicio < hf  &&  t.hora_fin > hi
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
      // Scroll suave al form
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
      // Mostrar modal de OK
      const okText = document.getElementById('ok-text');
      okText.innerHTML = `
        Te esperamos para tu turno de <b>${escapeHtml(state.selServicio.nombre)}</b><br/>
        el <b>${fmtFecha(turno.fecha)}</b> a las <b>${fmtHora(turno.hora_inicio)} hs</b>.<br/><br/>
        Si necesitás cancelar o reprogramar, llamanos al teléfono del salón.
      `;
      openOkModal();
      // Reset suave
      document.getElementById('bk-form').reset();
      state.selHora = null;
      // Recargar disponibilidad
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
      submit.textContent = '✨ Confirmar mi turno';
    }
  });
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
