// =============================================================
// uniq+ · Cliente Supabase + API + helpers
// =============================================================

const cfg = window.UNIQMAS_CONFIG || {};
const SUPA_OK =
  cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_URL.includes('YOUR-PROJECT') &&
  !cfg.SUPABASE_ANON_KEY.includes('YOUR-ANON');

let sb = null;
if (SUPA_OK && window.supabase) {
  sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
}

// ===== API pública (sin login) =====
const API = {
  async listarServicios() {
    const { data, error } = await sb
      .from('turnero_servicios')
      .select('*')
      .eq('activo', true)
      .order('orden');
    if (error) throw new Error(error.message);
    return data || [];
  },

  async turnosDelDia(fecha, servicioId) {
    const { data, error } = await sb.rpc('obtener_turnos_dia', {
      p_fecha: fecha,
      p_servicio_id: servicioId || null
    });
    if (error) throw new Error(error.message);
    return data || [];
  },

  async reservar(payload) {
    const { data, error } = await sb.rpc('reservar_turno', {
      p_servicio_id:    payload.servicio_id,
      p_cliente_nombre: payload.cliente_nombre,
      p_cliente_tel:    payload.cliente_tel || null,
      p_cliente_email:  payload.cliente_email || null,
      p_fecha:          payload.fecha,
      p_hora_inicio:    payload.hora_inicio,
      p_notas:          payload.notas || null
    });
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data[0] : data;
  },

  // ===== Admin =====
  async adminPing(secret) {
    const { error } = await sb.rpc('admin_turnero_ping', { p_secret: secret });
    if (error) throw new Error(error.message);
  },
  async adminListarTurnos(secret, fecha) {
    const { data, error } = await sb.rpc('admin_listar_turnos', {
      p_secret: secret, p_fecha: fecha
    });
    if (error) throw new Error(error.message);
    return data || [];
  },
  async adminCancelarTurno(secret, id, motivo) {
    const { error } = await sb.rpc('admin_cancelar_turno', {
      p_secret: secret, p_id: id, p_motivo: motivo || null
    });
    if (error) throw new Error(error.message);
  },
  async adminActualizarTurno(secret, id, fields) {
    const { data, error } = await sb.rpc('admin_actualizar_turno', {
      p_secret:          secret,
      p_id:              id,
      p_cliente_nombre:  fields.cliente_nombre,
      p_cliente_tel:     fields.cliente_tel || null,
      p_cliente_email:   fields.cliente_email || null,
      p_fecha:           fields.fecha,
      p_hora_inicio:     fields.hora_inicio,
      p_notas:           fields.notas || null
    });
    if (error) throw new Error(error.message);
    return data;
  },
  async adminListarServicios(secret) {
    // Reutilizamos el SELECT directo (las policies permiten leer activos);
    // para incluir inactivos también, hacemos SELECT sin filtro.
    const { data, error } = await sb
      .from('turnero_servicios')
      .select('*')
      .order('orden');
    if (error) throw new Error(error.message);
    return data || [];
  },
  async adminActualizarServicio(secret, id, fields) {
    const { data, error } = await sb.rpc('admin_actualizar_servicio', {
      p_secret:       secret,
      p_id:           id,
      p_nombre:       fields.nombre,
      p_emoji:        fields.emoji,
      p_descripcion:  fields.descripcion || null,
      p_duracion_min: fields.duracion_min,
      p_capacidad:    fields.capacidad,
      p_precio_min:   fields.precio_min ?? null,
      p_precio_max:   fields.precio_max ?? null,
      p_activo:       fields.activo
    });
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data[0] : data;
  },
  async adminGetSettings(secret) {
    const { data, error } = await sb.rpc('admin_get_settings', { p_secret: secret });
    if (error) throw new Error(error.message);
    const map = {};
    (data || []).forEach(r => { map[r.key] = r.value; });
    return map;
  },
  async adminSetSetting(secret, key, value) {
    const { error } = await sb.rpc('admin_set_setting', {
      p_secret: secret, p_key: key, p_value: value
    });
    if (error) throw new Error(error.message);
  }
};

// ===== Helpers =====
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function pad(n) { return String(n).padStart(2, '0'); }

function fmtFecha(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('es-AR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}
function fmtHora(t) {
  if (!t) return '';
  return t.slice(0, 5);
}
function fmtMoney(n) {
  if (n == null) return '';
  return '$' + Number(n).toLocaleString('es-AR');
}
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function nowHm() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function addMinutesToHm(hm, minutes) {
  const [h, m] = hm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const nh = Math.floor(total / 60) % 24;
  const nm = total % 60;
  return `${pad(nh)}:${pad(nm)}`;
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
  toast._t = setTimeout(() => t.classList.remove('show'), 3000);
}
