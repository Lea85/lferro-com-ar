// ===== Configuración del prode =====
const START_DATE = new Date(2026, 4, 6);   // 06/05/2026
const END_DATE   = new Date(2026, 5, 30);  // 30/06/2026
const MAX_BETS_PER_PERSON = 3;
const NAME_KEY = 'prode-francisco-name';
const LOCAL_BETS_KEY = 'prode-francisco-bets-offline';

const SLOTS = Array.from({ length: 8 }, (_, i) => {
  const start = i * 3;
  const end = start + 2;
  return { id: i, label: `${pad(start)}:00 – ${pad(end)}:59` };
});

function pad(n) { return String(n).padStart(2, '0'); }

// ===== Cliente Supabase (con fallback offline) =====
const cfg = window.PRODE_CONFIG || {};
const SUPABASE_OK =
  cfg.SUPABASE_URL &&
  cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_URL.includes('YOUR-PROJECT-REF') &&
  !cfg.SUPABASE_ANON_KEY.includes('YOUR-ANON');

let supabaseClient = null;
if (SUPABASE_OK && window.supabase) {
  supabaseClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
}

// ===== Estado =====
let state = {
  bets: [],
  currentMonth: new Date(2026, 4, 1),
  selectedDate: null,
  filter: 'all'
};

// ===== Utils de fecha =====
function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function isInRange(d) {
  const t = d.getTime();
  return t >= START_DATE.getTime() && t <= END_DATE.getTime();
}
function formatLong(d) {
  return d.toLocaleDateString('es-AR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}
function monthName(d) {
  return d.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
}
function normalizeName(s) { return (s || '').trim().toLowerCase(); }

// ===== Capa de datos =====
const dataLayer = {
  async loadBets() {
    if (supabaseClient) {
      const { data, error } = await supabaseClient
        .from('bets')
        .select('id, name, date_key, slot_id, created_at')
        .order('date_key', { ascending: true })
        .order('slot_id', { ascending: true });
      if (error) throw error;
      return data.map(r => ({
        id: r.id,
        name: r.name,
        dateKey: r.date_key,
        slotId: r.slot_id,
        ts: new Date(r.created_at).getTime()
      }));
    }
    try {
      return JSON.parse(localStorage.getItem(LOCAL_BETS_KEY) || '[]');
    } catch { return []; }
  },

  async placeBet(name, dateKeyStr, slotId) {
    if (supabaseClient) {
      const { data, error } = await supabaseClient.rpc('place_bet', {
        p_name: name,
        p_date_key: dateKeyStr,
        p_slot_id: slotId
      });
      if (error) throw new Error(error.message);
      // place_bet devuelve la fila insertada
      const row = Array.isArray(data) ? data[0] : data;
      return {
        id: row.id,
        name: row.name,
        dateKey: row.date_key,
        slotId: row.slot_id,
        ts: new Date(row.created_at).getTime()
      };
    }
    const bets = await this.loadBets();
    const norm = normalizeName(name);
    if (bets.filter(b => normalizeName(b.name) === norm).length >= MAX_BETS_PER_PERSON) {
      throw new Error(`Ya usaste tus ${MAX_BETS_PER_PERSON} apuestas.`);
    }
    if (bets.some(b => b.dateKey === dateKeyStr && b.slotId === slotId)) {
      throw new Error('Ese slot ya fue tomado.');
    }
    const bet = {
      id: 'b-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      name, dateKey: dateKeyStr, slotId, ts: Date.now()
    };
    bets.push(bet);
    localStorage.setItem(LOCAL_BETS_KEY, JSON.stringify(bets));
    return bet;
  },

  async deleteBet(id, name) {
    if (supabaseClient) {
      const { error } = await supabaseClient.rpc('delete_bet', {
        p_id: id,
        p_name: name
      });
      if (error) throw new Error(error.message);
      return;
    }
    const bets = await this.loadBets();
    const filtered = bets.filter(b => b.id !== id);
    localStorage.setItem(LOCAL_BETS_KEY, JSON.stringify(filtered));
  }
};

// ===== Render =====
function render() {
  renderHeader();
  renderName();
  renderCalendar();
  renderSlots();
  renderBets();
  renderStats();
}

function renderHeader() {
  const n = state.bets.length;
  document.getElementById('badge-text').textContent =
    `${n} ${n === 1 ? 'apuesta' : 'apuestas'}`;
}

function setStatus(kind, text) {
  const pill = document.getElementById('status-pill');
  pill.classList.remove('ok', 'err');
  if (kind) pill.classList.add(kind);
  document.getElementById('status-text').textContent = text;
}

function renderName() {
  const name = document.getElementById('name-input').value;
  const norm = normalizeName(name);
  const used = norm ? state.bets.filter(b => normalizeName(b.name) === norm).length : 0;
  document.getElementById('used-count').textContent = used;
  const left = MAX_BETS_PER_PERSON - used;
  const txt = !norm
    ? 'Escribí tu nombre para empezar'
    : left <= 0
      ? 'Ya usaste tus 3 apuestas 🙌'
      : `Te quedan ${left} disponible${left === 1 ? '' : 's'}`;
  document.getElementById('remaining-text').textContent = txt;
}

function clampMonth(d) {
  const min = new Date(START_DATE.getFullYear(), START_DATE.getMonth(), 1);
  const max = new Date(END_DATE.getFullYear(), END_DATE.getMonth(), 1);
  if (d < min) return new Date(min);
  if (d > max) return new Date(max);
  return d;
}

function renderCalendar() {
  const cur = state.currentMonth;
  document.getElementById('cal-title').textContent = monthName(cur);

  const min = new Date(START_DATE.getFullYear(), START_DATE.getMonth(), 1);
  const max = new Date(END_DATE.getFullYear(), END_DATE.getMonth(), 1);
  document.getElementById('cal-prev').disabled = cur.getTime() <= min.getTime();
  document.getElementById('cal-next').disabled = cur.getTime() >= max.getTime();

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].forEach(d => {
    const el = document.createElement('div');
    el.className = 'cal-dow';
    el.textContent = d;
    grid.appendChild(el);
  });

  const firstDow = (new Date(cur.getFullYear(), cur.getMonth(), 1).getDay() + 6) % 7;
  const daysInMonth = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();

  for (let i = 0; i < firstDow; i++) {
    const e = document.createElement('div');
    e.className = 'cal-day outside';
    grid.appendChild(e);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(cur.getFullYear(), cur.getMonth(), day);
    const k = dateKey(d);
    const inRange = isInRange(d);
    const taken = state.bets.filter(b => b.dateKey === k).length;
    const full = taken >= SLOTS.length;
    const partial = taken > 0 && !full;
    const empty = inRange && taken === 0;

    const e = document.createElement('div');
    e.className = 'cal-day';
    if (!inRange) e.classList.add('disabled');
    else if (full) e.classList.add('full');
    else if (partial) e.classList.add('partial');
    else if (empty) e.classList.add('empty');
    if (state.selectedDate === k) e.classList.add('selected');

    e.innerHTML = `<div>${day}</div>` +
      (inRange ? `<div class="pill">${taken}/${SLOTS.length}</div>` : '');

    if (inRange) {
      e.addEventListener('click', () => {
        state.selectedDate = k;
        render();
      });
    }
    grid.appendChild(e);
  }
}

function renderSlots() {
  const pill = document.getElementById('selected-date-pill');
  const cont = document.getElementById('slots');
  cont.innerHTML = '';

  if (!state.selectedDate) {
    pill.textContent = 'Seleccioná un día';
    cont.innerHTML = `<div class="slot-empty">📅 Elegí una fecha del calendario para ver los horarios disponibles.</div>`;
    return;
  }

  const d = parseKey(state.selectedDate);
  pill.textContent = formatLong(d);

  const dayBets = state.bets.filter(b => b.dateKey === state.selectedDate);
  const myName = normalizeName(document.getElementById('name-input').value);

  SLOTS.forEach(s => {
    const taken = dayBets.find(b => b.slotId === s.id);
    const isMine = taken && normalizeName(taken.name) === myName && myName;

    const el = document.createElement('div');
    el.className = 'slot' + (taken ? ' taken' : '') + (isMine ? ' mine' : '');
    el.innerHTML = `
      <div>
        <div class="time">${s.label}</div>
        <div class="who">${taken ? (isMine ? '✅ Tu apuesta' : '🔒 Apostado por ' + escapeHtml(taken.name)) : 'Disponible'}</div>
      </div>
      <div>${taken ? '' : '<span style="color: var(--primary); font-weight:700;">Apostar →</span>'}</div>
    `;
    if (!taken) {
      el.addEventListener('click', () => placeBet(state.selectedDate, s.id));
    }
    cont.appendChild(el);
  });
}

function renderBets() {
  const list = document.getElementById('bets-list');
  list.innerHTML = '';

  const myName = normalizeName(document.getElementById('name-input').value);
  let bets = [...state.bets].sort((a, b) => {
    if (a.dateKey !== b.dateKey) return a.dateKey.localeCompare(b.dateKey);
    return a.slotId - b.slotId;
  });
  if (state.filter === 'mine') {
    bets = bets.filter(b => normalizeName(b.name) === myName && myName);
  }

  if (bets.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="e-emoji">🎲</div>
        <div>${state.filter === 'mine' ? 'Todavía no hiciste ninguna apuesta.' : 'Todavía no hay apuestas.'}<br/>${state.filter === 'mine' ? 'Elegí un día y un horario para empezar.' : '¡Sé el primero!'}</div>
      </div>`;
    return;
  }

  bets.forEach(b => {
    const d = parseKey(b.dateKey);
    const slot = SLOTS[b.slotId];
    const mine = normalizeName(b.name) === myName && myName;
    const item = document.createElement('div');
    item.className = 'bet';
    item.innerHTML = `
      <div class="left">
        <div class="avatar" style="background: ${avatarColor(b.name)};">${initials(b.name)}</div>
        <div class="info">
          <div class="name">${escapeHtml(b.name)} ${mine ? '<span style="color:var(--ok); font-size:11px;">· vos</span>' : ''}</div>
          <div class="when">${formatLong(d)} · ${slot.label}</div>
        </div>
      </div>
      ${mine ? `<button class="delete" title="Eliminar apuesta" data-id="${b.id}">✕</button>` : ''}
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('.delete').forEach(btn => {
    btn.addEventListener('click', e => deleteBet(e.currentTarget.dataset.id));
  });
}

function renderStats() {
  document.getElementById('stat-total').textContent = state.bets.length;
  const ppl = new Set(state.bets.map(b => normalizeName(b.name)));
  document.getElementById('stat-people').textContent = ppl.size;
  const days = new Set(state.bets.map(b => b.dateKey));
  document.getElementById('stat-days').textContent = days.size;
}

// ===== Acciones =====
async function placeBet(dateKeyStr, slotId) {
  const rawName = document.getElementById('name-input').value;
  const name = rawName.trim();
  if (!name) {
    showToast('Primero escribí tu nombre 👆', 'err');
    document.getElementById('name-input').focus();
    return;
  }
  try {
    const bet = await dataLayer.placeBet(name, dateKeyStr, slotId);
    state.bets.push(bet);
    localStorage.setItem(NAME_KEY, name);
    const slot = SLOTS[slotId];
    showToast(`¡Apuesta registrada! ${formatLong(parseKey(dateKeyStr))} · ${slot.label}`, 'ok');
    render();
  } catch (err) {
    showToast(err.message || 'Error al guardar la apuesta', 'err');
    await refreshBets();
  }
}

async function deleteBet(id) {
  const bet = state.bets.find(b => b.id === id);
  if (!bet) return;
  const name = document.getElementById('name-input').value.trim();
  if (!confirm(`¿Eliminar tu apuesta del ${formatLong(parseKey(bet.dateKey))} en la franja ${SLOTS[bet.slotId].label}?`)) return;
  try {
    await dataLayer.deleteBet(id, name);
    state.bets = state.bets.filter(b => b.id !== id);
    showToast('Apuesta eliminada', 'ok');
    render();
  } catch (err) {
    showToast(err.message || 'Error al eliminar', 'err');
    await refreshBets();
  }
}

async function refreshBets() {
  try {
    // Timeout para no quedar colgados si la red bloquea Supabase
    const loadPromise = dataLayer.loadBets();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout: el servidor no responde (¿red bloqueada?)')), 8000)
    );
    state.bets = await Promise.race([loadPromise, timeoutPromise]);
    setStatus('ok', supabaseClient ? 'Conectado a Supabase' : 'Modo offline');
  } catch (err) {
    setStatus('err', 'Error de conexión');
    showToast(err.message || 'No se pudieron cargar las apuestas', 'err');
  }
  render();
}

// ===== Helpers UI =====
function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (type || '');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), 2800);
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}
function avatarColor(name) {
  const palette = [
    'linear-gradient(135deg,#ff7eb9,#ff65a3)',
    'linear-gradient(135deg,#7afcff,#5ac8fa)',
    'linear-gradient(135deg,#6c5ce7,#a29bfe)',
    'linear-gradient(135deg,#ffd166,#ffb347)',
    'linear-gradient(135deg,#06d6a0,#0fb88c)',
    'linear-gradient(135deg,#ef476f,#d63d61)',
    'linear-gradient(135deg,#118ab2,#3aa9c9)'
  ];
  let h = 0;
  for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ===== Eventos =====
document.getElementById('cal-prev').addEventListener('click', () => {
  const d = new Date(state.currentMonth);
  d.setMonth(d.getMonth() - 1);
  state.currentMonth = clampMonth(d);
  render();
});
document.getElementById('cal-next').addEventListener('click', () => {
  const d = new Date(state.currentMonth);
  d.setMonth(d.getMonth() + 1);
  state.currentMonth = clampMonth(d);
  render();
});
document.getElementById('name-input').addEventListener('input', () => {
  localStorage.setItem(NAME_KEY, document.getElementById('name-input').value);
  render();
});
document.querySelectorAll('#filter button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#filter button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.filter = b.dataset.filter;
    renderBets();
  });
});

// ===== Init =====
(async function init() {
  if (!SUPABASE_OK) {
    document.getElementById('config-banner').classList.remove('hidden');
    setStatus('err', 'Modo offline');
  } else {
    setStatus(null, 'Conectando…');
  }
  const savedName = localStorage.getItem(NAME_KEY);
  if (savedName) document.getElementById('name-input').value = savedName;

  // Render inicial INMEDIATO con estado vacío para que la UI aparezca
  // sin esperar a que responda el backend (clave si la red lo bloquea).
  render();

  // Después intentamos cargar los datos reales (con timeout)
  await refreshBets();

  // Realtime: si Supabase está activo, escuchamos cambios y refrescamos
  if (supabaseClient) {
    try {
      supabaseClient
        .channel('bets-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'bets' }, async () => {
          await refreshBets();
        })
        .subscribe();
    } catch (err) {
      console.warn('Realtime no disponible:', err);
    }
  }
})();
