// =============================================================
// Ranking + métricas avanzadas
// =============================================================

let leaderboardCache = [];
let allPredsCache = [];
let matchesCache = [];
let expandedPlayer = null;

renderHeader('ranking');

requireAuth(async () => {
  renderHeader('ranking');
  await loadAndRender();

  if (sb) {
    sb.channel('fifa-ranking')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, loadAndRender)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'predictions' }, loadAndRender)
      .subscribe();
  }
});

async function loadAndRender() {
  try {
    const [lb, preds, matches] = await Promise.all([
      API.leaderboard(),
      API.listAllPredictions(),
      API.listMatches()
    ]);
    leaderboardCache = lb;
    allPredsCache = preds;
    matchesCache = matches;
    renderPodium();
    renderTable();
    renderShareBar();
  } catch (err) {
    document.getElementById('ranking-root').innerHTML =
      `<div class="empty-state"><div class="e-emoji">⚠️</div>${escapeHtml(err.message)}</div>`;
  }
}

function renderPodium() {
  const root = document.getElementById('podium-root');
  if (leaderboardCache.length === 0) {
    root.innerHTML = '';
    return;
  }
  const top3 = leaderboardCache.slice(0, 3);
  // Reordenar visualmente: 2°, 1°, 3° (1° centro arriba)
  const order = top3.length === 3 ? [top3[1], top3[0], top3[2]]
              : top3.length === 2 ? [top3[1], top3[0]]
              : [top3[0]];
  const medals = top3.length === 3 ? ['🥈','🥇','🥉']
              : top3.length === 2 ? ['🥈','🥇']
              : ['🥇'];
  const isFirst = (idx) => (top3.length >= 2 ? idx === 1 : idx === 0);

  root.innerHTML = `
    <div class="podium">
      ${order.map((p, i) => `
        <div class="podium-item ${isFirst(i) ? 'first' : ''}">
          <div class="medal">${medals[i]}</div>
          <div class="pname">${escapeHtml(p.name)}</div>
          <div class="ppts">${p.total_points}<small>puntos</small></div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderTable() {
  const root = document.getElementById('ranking-root');
  if (leaderboardCache.length === 0) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="e-emoji">🏆</div>
        <div>Todavía no hay jugadores. Invitá a tus amigos a registrarse.</div>
      </div>`;
    return;
  }

  const head = `
    <div class="lb-row head">
      <div class="pos">#</div>
      <div class="pname">Jugador</div>
      <div class="ppts">PTS</div>
      <div class="pstat">Exactos</div>
      <div class="pstat winners">Aciertos</div>
    </div>
  `;

  const rows = leaderboardCache.map((p, i) => {
    const isExpanded = expandedPlayer === p.id;
    const stats = computePlayerStats(p.id);
    return `
      <div class="lb-row ${isExpanded ? 'expanded' : ''}" data-pid="${p.id}">
        <div class="pos">${i + 1}</div>
        <div class="pname">${escapeHtml(p.name)}</div>
        <div class="ppts">${p.total_points}</div>
        <div class="pstat">${p.exact_count}</div>
        <div class="pstat winners">${p.winner_count}</div>
        ${isExpanded ? `
          <div class="lb-detail">
            <div class="lb-stat">
              <div class="num">${p.predictions_count}</div>
              <div class="lbl">Predicciones</div>
            </div>
            <div class="lb-stat">
              <div class="num">${stats.accuracy}%</div>
              <div class="lbl">% Exactos</div>
            </div>
            <div class="lb-stat">
              <div class="num">${stats.streak}</div>
              <div class="lbl">Racha actual</div>
            </div>
            <div class="lb-stat">
              <div class="num">${stats.bestTeam || '—'}</div>
              <div class="lbl">Top equipo</div>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  root.innerHTML = `<div class="lb-table">${head}${rows}</div>`;

  root.querySelectorAll('.lb-row[data-pid]').forEach(r => {
    r.addEventListener('click', () => {
      const pid = r.dataset.pid;
      expandedPlayer = (expandedPlayer === pid) ? null : pid;
      renderTable();
    });
  });
}

// === Métricas por jugador ===
function computePlayerStats(playerId) {
  const matchById = new Map(matchesCache.map(m => [m.id, m]));
  const finishedPreds = allPredsCache
    .filter(p => p.player_id === playerId)
    .map(p => ({ ...p, match: matchById.get(p.match_id) }))
    .filter(p => p.match && p.match.finished)
    .sort((a, b) => new Date(b.match.start_time) - new Date(a.match.start_time));

  const total = finishedPreds.length;
  const exact = finishedPreds.filter(p => p.points === 5).length;
  const accuracy = total > 0 ? Math.round((exact / total) * 100) : 0;

  // Racha actual: cuántos partidos consecutivos (más recientes hacia atrás) sumó >0 puntos
  let streak = 0;
  for (const p of finishedPreds) {
    if (p.points > 0) streak++;
    else break;
  }

  // Equipo con el que más puntos hizo
  const ptsByTeam = new Map();
  for (const p of finishedPreds) {
    [p.match.home_team_id, p.match.away_team_id].forEach(teamId => {
      ptsByTeam.set(teamId, (ptsByTeam.get(teamId) || 0) + p.points);
    });
  }
  let bestTeam = null;
  let bestPts = -1;
  for (const [teamId, pts] of ptsByTeam) {
    if (pts > bestPts) {
      bestPts = pts;
      const m = matchesCache.find(mm => mm.home_team_id === teamId || mm.away_team_id === teamId);
      if (m) bestTeam = m.home_team_id === teamId ? m.home_name : m.away_name;
    }
  }

  return { accuracy, streak, bestTeam };
}

// === Compartir en WhatsApp ===
function renderShareBar() {
  const bar = document.getElementById('share-bar');
  if (leaderboardCache.length === 0) { bar.innerHTML = ''; return; }
  bar.innerHTML = `
    <button class="btn-gold" id="share-wsp">📲 Compartir en WhatsApp</button>
    <button class="btn-ghost" id="copy-clip">📋 Copiar al portapapeles</button>
  `;
  document.getElementById('share-wsp').addEventListener('click', () => {
    const text = buildShareText();
    const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  });
  document.getElementById('copy-clip').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(buildShareText());
      toast('Copiado al portapapeles ✅', 'ok');
    } catch {
      toast('No se pudo copiar', 'err');
    }
  });
}

function buildShareText() {
  const top = leaderboardCache.slice(0, 10);
  const lines = [
    '🏆 *Prode Fifa 2026* — Ranking',
    '─────────────────',
    ...top.map((p, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : ` ${i + 1}.`;
      return `${medal} *${p.name}* — ${p.total_points} pts (${p.exact_count} exactos)`;
    }),
    '─────────────────',
    'Sumate en https://lferro.com.ar/prodeFifa/'
  ];
  return lines.join('\n');
}
