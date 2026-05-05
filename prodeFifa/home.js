// =============================================================
// Home: lista de partidos + carga de predicciones
// =============================================================

let matchesCache = [];
let myPredsCache = new Map(); // matchId -> prediction
let currentFilter = 'all';
let countdownTimer = null;

renderHeader('home');

requireAuth(async (session) => {
  renderHeader('home');
  await loadAndRender();

  // Filtros
  document.querySelectorAll('#match-filter button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#match-filter button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      currentFilter = b.dataset.filter;
      renderMatches();
    });
  });

  // Realtime
  if (sb) {
    sb.channel('fifa-matches')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, loadAndRender)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'predictions' }, loadAndRender)
      .subscribe();
  }

  // Refrescar contadores cada segundo
  countdownTimer = setInterval(updateCountdowns, 1000);
});

async function loadAndRender() {
  const session = Session.get();
  if (!session) return;
  try {
    const [matches, myPreds] = await Promise.all([
      API.listMatches(),
      API.listMyPredictions(session.id)
    ]);
    matchesCache = matches;
    myPredsCache = new Map(myPreds.map(p => [p.match_id, p]));
    renderMatches();
  } catch (err) {
    console.error(err);
    document.getElementById('matches-root').innerHTML =
      `<div class="empty-state"><div class="e-emoji">⚠️</div>${escapeHtml(err.message)}</div>`;
  }
}

function filterMatches() {
  if (currentFilter === 'open') return matchesCache.filter(m => !isLocked(m.start_time) && !m.finished);
  if (currentFilter === 'locked') return matchesCache.filter(m => isLocked(m.start_time) || m.finished);
  return matchesCache;
}

function renderMatches() {
  const root = document.getElementById('matches-root');
  const list = filterMatches();
  if (list.length === 0) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="e-emoji">⚽</div>
        <div>No hay partidos para mostrar.</div>
      </div>`;
    return;
  }

  // Agrupar por fase
  const byPhase = list.reduce((acc, m) => {
    (acc[m.phase] = acc[m.phase] || []).push(m);
    return acc;
  }, {});

  const phaseOrder = ['group','r32','r16','qf','sf','tp','final'];
  let html = '';
  for (const phase of phaseOrder) {
    if (!byPhase[phase]) continue;
    html += `
      <div class="phase-group">
        <h3 class="phase-title">${PHASE_LABELS[phase] || phase}</h3>
        <div class="matches-grid">
          ${byPhase[phase].map(matchCard).join('')}
        </div>
      </div>
    `;
  }
  root.innerHTML = html;
  attachMatchHandlers();
}

function matchCard(m) {
  const pred = myPredsCache.get(m.id);
  const locked = isLocked(m.start_time);
  const finished = m.finished;
  const lockUntil = timeUntilLock(m.start_time);

  let lockHtml = '';
  if (finished) {
    lockHtml = `<span class="lock-info locked">🏁 Partido jugado</span>`;
  } else if (locked) {
    lockHtml = `<span class="lock-info locked">🔒 Cerrado</span>`;
  } else {
    const cls = lockUntil < 60 * 60 * 1000 ? 'warn' : '';
    lockHtml = `<span class="lock-info ${cls}" data-countdown="${m.start_time}">⏳ Cierra en <b>${fmtCountdown(lockUntil)}</b></span>`;
  }

  let pointsBadge = '';
  if (finished && pred) {
    pointsBadge = `<span class="points-badge p${pred.points}">${pred.points} pts</span>`;
  }

  let realResult = '';
  if (finished) {
    realResult = `
      <div class="real-result">
        <span class="lbl">Resultado real</span>
        ${m.home_goals} - ${m.away_goals}
      </div>`;
  }

  let mood = '';
  if (m.mood === 'fire') mood = `<span class="mood fire">🔥 Batacazo</span>`;
  else if (m.mood === 'ice') mood = `<span class="mood ice">🧊 Predecible</span>`;

  const homeFlag = m.home_cc
    ? `<span class="flag" style="background-image:url('${flagUrl(m.home_cc)}')"></span>`
    : `<span style="font-size:24px">${flagEmoji(m.home_cc)}</span>`;
  const awayFlag = m.away_cc
    ? `<span class="flag" style="background-image:url('${flagUrl(m.away_cc)}')"></span>`
    : `<span style="font-size:24px">${flagEmoji(m.away_cc)}</span>`;

  return `
    <div class="match-card" data-match-id="${m.id}">
      <div class="match-meta">
        <span class="date">📅 ${fmtDateTime(m.start_time)}</span>
        ${mood || ''}
      </div>

      <div class="teams">
        <div class="team home">
          ${homeFlag}
          <span class="name">${escapeHtml(m.home_name)}</span>
        </div>
        <span class="vs">vs</span>
        <div class="team away">
          ${awayFlag}
          <span class="name">${escapeHtml(m.away_name)}</span>
        </div>
      </div>

      ${realResult}

      <div class="prediction-box">
        <div class="prediction-row">
          <input type="number" min="0" max="30" inputmode="numeric"
                 class="score-input pred-home"
                 value="${pred ? pred.home_goals : ''}"
                 placeholder="–"
                 ${(locked || finished) ? 'disabled' : ''}/>
          <span class="dash">–</span>
          <input type="number" min="0" max="30" inputmode="numeric"
                 class="score-input pred-away"
                 value="${pred ? pred.away_goals : ''}"
                 placeholder="–"
                 ${(locked || finished) ? 'disabled' : ''}/>
        </div>
        <div class="prediction-actions">
          ${lockHtml}
          ${(locked || finished)
            ? pointsBadge
            : `<button class="btn-primary btn-sm save-pred" data-match-id="${m.id}">${pred ? 'Actualizar' : 'Predecir'}</button>`}
        </div>
      </div>
    </div>
  `;
}

function attachMatchHandlers() {
  document.querySelectorAll('.save-pred').forEach(btn => {
    btn.addEventListener('click', async () => {
      const matchId = btn.dataset.matchId;
      const card = btn.closest('.match-card');
      const home = parseInt(card.querySelector('.pred-home').value, 10);
      const away = parseInt(card.querySelector('.pred-away').value, 10);
      if (Number.isNaN(home) || Number.isNaN(away)) {
        toast('Cargá ambos goles', 'err');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Guardando…';
      try {
        const session = Session.get();
        const result = await API.placePrediction(session.id, session.auth_token, matchId, home, away);
        myPredsCache.set(matchId, result);
        toast('Predicción guardada ✅', 'ok');
        renderMatches();
      } catch (err) {
        toast(err.message || 'Error al guardar', 'err');
        btn.disabled = false;
        btn.textContent = 'Predecir';
      }
    });
  });
}

function updateCountdowns() {
  document.querySelectorAll('[data-countdown]').forEach(el => {
    const startISO = el.dataset.countdown;
    const ms = timeUntilLock(startISO);
    if (ms <= 0) {
      // Re-renderizar para que pase a estado "cerrado"
      renderMatches();
    } else {
      el.querySelector('b').textContent = fmtCountdown(ms);
      if (ms < 60 * 60 * 1000) el.classList.add('warn');
    }
  });
}
