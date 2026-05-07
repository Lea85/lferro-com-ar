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
function todayStart() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}
// Día anterior al día actual (hoy NO está past hasta que termine)
function isDayPast(d) {
  return d.getTime() < todayStart().getTime();
}
// Fin de la franja del slot (slot 0 = 00-02:59:59 → end = 03:00:00)
function slotEnd(dateKeyStr, slotId) {
  const d = parseKey(dateKeyStr);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), (slotId + 1) * 3, 0, 0, 0);
}
function isSlotExpired(dateKeyStr, slotId) {
  return Date.now() >= slotEnd(dateKeyStr, slotId).getTime();
}
function isBetExpired(b) {
  return isSlotExpired(b.dateKey, b.slotId);
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
  // La pastilla de estado fue removida del header; mantenemos la funcion como
  // no-op defensiva para no romper llamadas existentes (y por si la
  // re-introducimos en el futuro).
  const pill = document.getElementById('status-pill');
  if (!pill) return;
  pill.classList.remove('ok', 'err');
  if (kind) pill.classList.add(kind);
  const txt = document.getElementById('status-text');
  if (txt) txt.textContent = text;
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
    const past = inRange && isDayPast(d);
    const taken = state.bets.filter(b => b.dateKey === k).length;
    const full = taken >= SLOTS.length;
    const partial = taken > 0 && !full;
    const empty = inRange && taken === 0;

    const e = document.createElement('div');
    e.className = 'cal-day';
    if (!inRange) e.classList.add('disabled');
    else if (past) e.classList.add('past');
    else if (full) e.classList.add('full');
    else if (partial) e.classList.add('partial');
    else if (empty) e.classList.add('empty');
    if (state.selectedDate === k) e.classList.add('selected');

    e.innerHTML = `<div>${day}</div>` +
      (inRange ? `<div class="pill">${taken}/${SLOTS.length}</div>` : '') +
      (past ? `<span class="past-x" aria-hidden="true">✕</span>` : '');

    if (inRange && !past) {
      e.addEventListener('click', () => {
        state.selectedDate = k;
        render();
      });
    } else if (past) {
      e.title = 'Esta fecha ya pasó';
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
    const expired = isSlotExpired(state.selectedDate, s.id);

    const el = document.createElement('div');
    el.className = 'slot'
      + (taken ? ' taken' : '')
      + (isMine ? ' mine' : '')
      + (expired ? ' expired' : '');

    let whoText;
    if (taken) {
      whoText = isMine ? '✅ Tu apuesta' : '🔒 Apostado por ' + escapeHtml(taken.name);
    } else if (expired) {
      whoText = '⛔ Franja horaria vencida';
    } else {
      whoText = 'Disponible';
    }

    el.innerHTML = `
      <div>
        <div class="time">${s.label}</div>
        <div class="who">${whoText}</div>
      </div>
      <div>${
        expired && !taken ? '<span class="expired-mark" aria-hidden="true">✕</span>'
        : taken ? ''
        : '<span style="color: var(--primary); font-weight:700;">Apostar →</span>'
      }</div>
    `;
    if (!taken && !expired) {
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
    const expired = isBetExpired(b);
    const item = document.createElement('div');
    item.className = 'bet' + (expired ? ' expired' : '');

    // Acciones a la derecha:
    //  - si la apuesta esta vencida: cruz roja siempre (mas el delete propio si es tuya).
    //  - si no: solo el boton delete (cuando es tuya).
    let rightHtml = '';
    if (expired) {
      rightHtml += `<span class="expired-mark" title="Esta franja horaria ya pasó" aria-label="Apuesta vencida">✕</span>`;
    }
    if (mine && !expired) {
      rightHtml += `<button class="delete" title="Eliminar apuesta" data-id="${b.id}">✕</button>`;
    }

    item.innerHTML = `
      <div class="left">
        <div class="avatar" style="background: ${avatarColor(b.name)};">${initials(b.name)}</div>
        <div class="info">
          <div class="name">${escapeHtml(b.name)} ${mine ? '<span style="color:var(--ok); font-size:11px;">· vos</span>' : ''}</div>
          <div class="when">${formatLong(d)} · ${slot.label}</div>
        </div>
      </div>
      <div class="bet-actions">${rightHtml}</div>
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

// ===== Modal "Hacele un regalo a Francisco" =====
(function setupGiftModal() {
  const btn = document.getElementById('gift-btn');
  const overlay = document.getElementById('gift-modal');
  const close = document.getElementById('gift-close');
  if (!btn || !overlay) return;

  function openModal() {
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => overlay.classList.add('show'));
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    overlay.classList.remove('show');
    setTimeout(() => {
      overlay.classList.add('hidden');
      document.body.style.overflow = '';
    }, 250);
  }

  btn.addEventListener('click', openModal);
  close.addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('show')) closeModal();
  });

  // Copy-to-clipboard de los datos
  overlay.querySelectorAll('.gift-copy').forEach(b => {
    b.addEventListener('click', async () => {
      const text = b.dataset.copy || '';
      try {
        await navigator.clipboard.writeText(text);
        const original = b.textContent;
        b.textContent = '✓';
        b.classList.add('copied');
        showToast(`Copiado: ${text}`, 'ok');
        setTimeout(() => { b.textContent = original; b.classList.remove('copied'); }, 1500);
      } catch {
        showToast('No se pudo copiar al portapapeles', 'err');
      }
    });
  });

  // Smart open: si es Android/iOS intentamos abrir la app de Mercado Pago
  // instalada; si no esta, caemos a la web.
  const mpBtn = document.getElementById('gift-mp-btn');
  const mpText = document.getElementById('gift-mp-text');
  const mpHint = document.getElementById('gift-mp-hint');
  if (mpBtn) {
    const ua = navigator.userAgent || '';
    const isAndroid = /Android/i.test(ua);
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    const webUrl = 'https://www.mercadopago.com.ar/';

    if (isAndroid || isIOS) {
      mpText.textContent = 'Abrir app de Mercado Pago';
      mpHint.style.display = 'block';
      mpHint.textContent = 'Si no la tenés instalada, te abrimos la web automáticamente.';
    }

    mpBtn.addEventListener('click', e => {
      if (!isAndroid && !isIOS) return; // desktop: deja el href default
      e.preventDefault();

      // Detector universal: si el browser pierde foco asumimos que la app abrio
      let appOpened = false;
      const onHide = () => { appOpened = true; };
      document.addEventListener('visibilitychange', onHide, { once: true });
      window.addEventListener('pagehide', onHide, { once: true });
      window.addEventListener('blur', onHide, { once: true });

      const t0 = Date.now();

      if (isAndroid) {
        // Intent URI con CUSTOM scheme (mercadopago://), no https.
        // La app de MP registra el scheme 'mercadopago' para deep links;
        // 'https' requiere App Links verificados que no aplican a la home.
        // browser_fallback_url va a la web si la app no esta instalada.
        const intentUrl =
          'intent://open#Intent;scheme=mercadopago;' +
          'package=com.mercadopago.wallet;' +
          'S.browser_fallback_url=' + encodeURIComponent(webUrl) + ';end';
        window.location.href = intentUrl;
      } else {
        // iOS: scheme custom directo
        window.location.href = 'mercadopago://';
      }

      // Fallback de seguridad: si despues de 1.6s seguimos visibles
      // (no se abrio la app y tampoco navegamos al fallback del intent),
      // forzamos la web en una pestana nueva.
      setTimeout(() => {
        document.removeEventListener('visibilitychange', onHide);
        window.removeEventListener('pagehide', onHide);
        window.removeEventListener('blur', onHide);
        const stillHere = !appOpened && document.visibilityState === 'visible';
        const elapsed = Date.now() - t0;
        if (stillHere && elapsed < 3000) {
          window.open(webUrl, '_blank', 'noopener');
        }
      }, 1600);
    });
  }
})();

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

  // Re-render cada minuto: para que las franjas que vencen mientras la pagina
  // esta abierta se marquen como expiradas sin necesidad de recargar.
  setInterval(render, 60_000);
})();
