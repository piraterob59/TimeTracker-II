import { store, uuid } from './db.js';
import { syncStatus, initSync, getConfig, parseConfigText, connectWithConfig, disconnectSync, pushProject, pushEntry, pushDeleteProject, pushDeleteEntry } from './sync.js';

const PROJECT_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#4b5563', '#ca8a04', '#059669',
];

const isHexColor = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c);

// A project's color has two parts: `color` is the left half of its dot (meant
// to be shared by every project on the same topic) and the optional `color2`
// is the right half (specific to the project). Dots are a hard 50/50 split;
// with no color2 it is just the plain solid color, exactly as before. Values
// are checked as hex because they end up inside style attributes.
function projectSwatchCss(p) {
  const left = p && isHexColor(p.color) ? p.color : '#999';
  return p && isHexColor(p.color2) ? `linear-gradient(90deg, ${left} 50%, ${p.color2} 50%)` : left;
}

const state = {
  projects: [],
  projectsById: new Map(), // kept in sync with `projects` on every reload(), for O(1) lookups
  entries: [],
  running: null, // entry object with end === null
  pendingProjectId: null, // project chosen but not yet started (client-side only, never persisted)
  view: 'timer',
  chartOffsetWeeks: 0, // 0 = the 7 days ending today; 1 = the 7 days before that, etc.
};

const el = (sel) => document.querySelector(sel);
const modalBackdrop = el('#modal-backdrop');
const modalEl = el('#modal');

function pad(n) { return String(n).padStart(2, '0'); }

function hmParts(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}

function fmtHMS(totalSeconds) {
  const { h, m, s } = hmParts(totalSeconds);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function fmtHM(totalSeconds) {
  const { h, m } = hmParts(totalSeconds);
  return `${h}h ${m}m`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtDateKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateHeading(dateKey) {
  const today = fmtDateKey(new Date().toISOString());
  const d = new Date(dateKey + 'T00:00:00');
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateKey === today) return 'Today';
  if (dateKey === fmtDateKey(yesterday.toISOString())) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function entryDuration(entry) {
  const start = new Date(entry.start).getTime();
  const pauseMs = entry.pauseMs || 0;
  if (entry.end) {
    return (new Date(entry.end).getTime() - start - pauseMs) / 1000;
  }
  if (entry.paused && entry.pausedAt) {
    return (new Date(entry.pausedAt).getTime() - start - pauseMs) / 1000;
  }
  return (Date.now() - start - pauseMs) / 1000;
}

function projectById(id) {
  return state.projectsById.get(id);
}

function weekStart(date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d;
}

// ---------- data loading ----------

async function reload() {
  state.projects = await store.getAllProjects();
  state.projectsById = new Map(state.projects.map((p) => [p.id, p]));
  state.entries = await store.getAllEntries();
  state.running = state.entries.find((e) => e.end === null) || null;
  renderAll();
  syncAppBadge();
}

// Badges the Home Screen icon (iOS 16.4+, also Chrome/Edge on desktop and
// Android) while a timer is running, so it's visible without opening the
// app. Client-side only — the OS keeps showing the badge after the app is
// backgrounded, no push/server needed. Feature-detected since older
// browsers don't support the Badging API at all.
function syncAppBadge() {
  if (!('setAppBadge' in navigator)) return;
  if (state.running) {
    navigator.setAppBadge().catch(() => {});
  } else {
    navigator.clearAppBadge().catch(() => {});
  }
}

// ---------- rendering ----------

function renderAll() {
  renderTimer();
  renderHistory();
  renderProjects();
  renderSyncStatus();
}

function renderTimer() {
  const runningCard = el('#running-card');
  const idleHint = el('#idle-hint');
  const grid = el('#project-grid');
  const startBtn = el('#start-btn');
  const pauseBtn = el('#pause-btn');
  const secondaryActions = el('#running-actions-secondary');

  if (state.running) {
    runningCard.classList.remove('hidden');
    idleHint.classList.add('hidden');
    const p = projectById(state.running.projectId);
    const nameEl = el('#running-project-name');
    nameEl.textContent = p ? p.name : 'Unknown project';
    nameEl.style.color = p ? p.color : 'var(--text-dim)';
    runningNoteEl.value = state.running.note || '';
    autoResizeNote(runningNoteEl);
    el('#running-time').textContent = fmtHMS(entryDuration(state.running));
    el('#running-badge').classList.toggle('hidden', !state.running.paused);
    pauseBtn.textContent = state.running.paused ? 'Resume' : 'Pause';
    startBtn.classList.add('hidden');
    pauseBtn.disabled = false;
    secondaryActions.classList.remove('hidden');
  } else if (state.pendingProjectId) {
    runningCard.classList.remove('hidden');
    idleHint.classList.add('hidden');
    const p = projectById(state.pendingProjectId);
    const nameEl = el('#running-project-name');
    nameEl.textContent = p ? p.name : 'Unknown project';
    nameEl.style.color = p ? p.color : 'var(--text-dim)';
    runningNoteEl.value = '';
    autoResizeNote(runningNoteEl);
    el('#running-time').textContent = '00:00:00';
    el('#running-badge').classList.add('hidden');
    startBtn.classList.remove('hidden');
    pauseBtn.disabled = true;
    secondaryActions.classList.add('hidden');
  } else {
    runningCard.classList.add('hidden');
    idleHint.classList.remove('hidden');
  }

  const active = state.projects.filter((p) => !p.archived);
  grid.innerHTML = '';
  if (active.length === 0) {
    grid.innerHTML = '<p class="hint-text">No projects yet. Add one in the Projects tab.</p>';
  }
  const selectionLocked = !!(state.running || state.pendingProjectId);
  for (const p of active) {
    const btn = document.createElement('button');
    btn.className = 'project-tile';
    btn.style.background = projectSwatchCss(p);
    btn.textContent = p.name;
    btn.disabled = selectionLocked;
    if (btn.disabled) btn.style.opacity = '0.5';
    btn.addEventListener('click', () => selectProject(p.id));
    grid.appendChild(btn);
  }
}

let openSwipeRow = null;
const SWIPE_OPEN_X = -88;
const SWIPE_THRESHOLD = -40;

function closeSwipe(wrapEl) {
  const row = wrapEl.querySelector('.entry-row');
  if (row) row.style.transform = '';
  wrapEl.classList.remove('swipe-open');
}

document.addEventListener('pointerdown', (e) => {
  if (openSwipeRow && !openSwipeRow.contains(e.target)) {
    closeSwipe(openSwipeRow);
    openSwipeRow = null;
  }
});

function attachSwipeToDelete(wrap, row, entry) {
  const deleteBtn = wrap.querySelector('.entry-delete-action');
  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let dragging = false;
  let moved = false;
  let axis = null;

  function setTransform(x) {
    currentX = x;
    row.style.transform = `translateX(${x}px)`;
  }

  function resetSwipe() {
    setTransform(0);
    wrap.classList.remove('swipe-open');
    if (openSwipeRow === wrap) openSwipeRow = null;
  }

  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (openSwipeRow && openSwipeRow !== wrap) {
      closeSwipe(openSwipeRow);
      openSwipeRow = null;
    }
    startX = e.clientX;
    startY = e.clientY;
    dragging = true;
    moved = false;
    axis = null;
    row.classList.add('swiping');
    row.setPointerCapture(e.pointerId);
  });

  row.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (axis === null) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (axis !== 'x') return;
    moved = true;
    const base = wrap.classList.contains('swipe-open') ? SWIPE_OPEN_X : 0;
    const x = Math.min(0, Math.max(SWIPE_OPEN_X * 1.15, base + dx));
    setTransform(x);
  });

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    row.classList.remove('swiping');
    if (axis === 'x') {
      if (currentX <= SWIPE_THRESHOLD) {
        setTransform(SWIPE_OPEN_X);
        wrap.classList.add('swipe-open');
        openSwipeRow = wrap;
      } else {
        resetSwipe();
      }
    }
  }

  row.addEventListener('pointerup', endDrag);
  row.addEventListener('pointercancel', endDrag);

  row.addEventListener('click', () => {
    if (moved) {
      moved = false;
      return;
    }
    if (wrap.classList.contains('swipe-open')) {
      resetSwipe();
      return;
    }
    openEntryModal(entry);
  });

  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await openConfirm('Delete this entry?');
    if (!ok) {
      resetSwipe();
      return;
    }
    if (openSwipeRow === wrap) openSwipeRow = null;
    await removeEntry(entry.id);
    await reload();
  });
}

let tickHandle = null;
function ensureTicking() {
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    if (state.running && !document.hidden) {
      el('#running-time').textContent = fmtHMS(entryDuration(state.running));
    }
  }, 1000);
}

function renderHistory() {
  const completed = state.entries.filter((e) => e.end !== null);
  const now = new Date();
  const todayKey = fmtDateKey(now.toISOString());
  const ws = weekStart(now).getTime();

  let todaySec = 0;
  let weekSec = 0;
  for (const e of completed) {
    const dur = entryDuration(e);
    if (fmtDateKey(e.start) === todayKey) todaySec += dur;
    if (new Date(e.start).getTime() >= ws) weekSec += dur;
  }
  el('#total-today').textContent = fmtHM(todaySec);
  el('#total-week').textContent = fmtHM(weekSec);

  const chartStart = new Date(now);
  chartStart.setHours(0, 0, 0, 0);
  chartStart.setDate(chartStart.getDate() - 6 - state.chartOffsetWeeks * 7);
  renderWeekChart(completed, chartStart.getTime());

  const groups = new Map();
  for (const e of completed) {
    const key = fmtDateKey(e.start);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => (a < b ? 1 : -1));

  const listEl = el('#history-list');
  listEl.innerHTML = '';
  if (sortedKeys.length === 0) {
    listEl.innerHTML = '<p class="hint-text">No entries yet.</p>';
    return;
  }
  for (const key of sortedKeys) {
    const group = groups.get(key).sort((a, b) => (a.start < b.start ? 1 : -1));
    const groupEl = document.createElement('div');
    groupEl.className = 'history-group';
    const heading = document.createElement('div');
    heading.className = 'history-date';
    heading.textContent = fmtDateHeading(key);
    groupEl.appendChild(heading);
    for (const entry of group) {
      const p = projectById(entry.projectId);
      const wrap = document.createElement('div');
      wrap.className = 'entry-swipe';
      wrap.innerHTML = `<button type="button" class="entry-delete-action">Delete</button>`;
      const row = document.createElement('div');
      row.className = 'entry-row';
      row.innerHTML = `
        <div class="entry-color" style="background:${projectSwatchCss(p)}"></div>
        <div class="entry-main">
          <div class="entry-project">${escapeHtml(p ? p.name : 'Unknown')}</div>
          <div class="entry-meta">${fmtTime(entry.start)} – ${fmtTime(entry.end)}${entry.note ? ' · ' + escapeHtml(entry.note) : ''}</div>
        </div>
        <div class="entry-duration">${fmtHM(entryDuration(entry))}</div>
      `;
      wrap.appendChild(row);
      attachSwipeToDelete(wrap, row, entry);
      groupEl.appendChild(wrap);
    }
    listEl.appendChild(groupEl);
  }
}

function renderWeekChart(completed, chartStart) {
  const wsDate = new Date(chartStart);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(wsDate);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  const dayKeys = days.map((d) => fmtDateKey(d.toISOString()));
  const dayLabels = days.map((d) => d.toLocaleDateString([], { weekday: 'short' }));
  const todayKey = fmtDateKey(new Date().toISOString());

  const perDay = dayKeys.map(() => new Map());
  const projectIdsInWeek = new Set();
  for (const e of completed) {
    const idx = dayKeys.indexOf(fmtDateKey(e.start));
    if (idx === -1) continue;
    const minutes = entryDuration(e) / 60;
    const map = perDay[idx];
    map.set(e.projectId, (map.get(e.projectId) || 0) + minutes);
    projectIdsInWeek.add(e.projectId);
  }

  const card = el('#week-chart-card');
  const chartEl = el('#week-chart');
  const legendEl = el('#week-chart-legend');
  const rangeLabel = el('#week-range-label');
  const nextBtn = el('#week-next-btn');

  // Hide the whole card (nav included) only when there's no history to page
  // through at all — otherwise keep navigation available even for a range
  // with no entries, so paging further back still works.
  if (completed.length === 0) {
    card.classList.add('hidden');
    chartEl.innerHTML = '';
    legendEl.innerHTML = '';
    return;
  }
  card.classList.remove('hidden');

  const fmtRangeDate = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  rangeLabel.textContent = state.chartOffsetWeeks === 0
    ? `Last 7 days`
    : `${fmtRangeDate(days[0])} – ${fmtRangeDate(days[6])}`;
  nextBtn.disabled = state.chartOffsetWeeks === 0;

  if (projectIdsInWeek.size === 0) {
    chartEl.innerHTML = '<p class="hint-text" style="margin:4px 2px 8px">No entries in this range.</p>';
    legendEl.innerHTML = '';
    return;
  }

  // Alphabetical, then projects sharing a left color (the same topic) pulled
  // together, groups ordered by their first member -- so a topic's projects
  // sit next to each other in every bar and in the legend, and their shared
  // left half reads as one continuous stripe.
  const byName = [...projectIdsInWeek]
    .map((id) => projectById(id))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  const topicOrder = [];
  for (const p of byName) if (!topicOrder.includes(p.color)) topicOrder.push(p.color);
  const projectsInWeek = byName.sort((a, b) =>
    topicOrder.indexOf(a.color) - topicOrder.indexOf(b.color) || a.name.localeCompare(b.name));

  // A project with a right color gets a hard-stop gradient fill (left half /
  // right half of each bar segment, split at the segment's own middle).
  let defs = '';
  const fillFor = new Map();
  projectsInWeek.forEach((p, i) => {
    const left = isHexColor(p.color) ? p.color : '#999';
    if (isHexColor(p.color2)) {
      const gid = `tt-split-${i}`;
      defs += `<linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0"><stop offset="0.5" stop-color="${left}"></stop><stop offset="0.5" stop-color="${p.color2}"></stop></linearGradient>`;
      fillFor.set(p.id, `url(#${gid})`);
    } else {
      fillFor.set(p.id, left);
    }
  });

  const dayTotals = perDay.map((map) => [...map.values()].reduce((a, b) => a + b, 0));
  const maxTotal = Math.max(1, ...dayTotals);

  const width = 700;
  const height = 260;
  const padTop = 16;
  const padBottom = 28;
  const padSide = 12;
  const plotHeight = height - padTop - padBottom;
  const colWidth = (width - padSide * 2) / 7;
  const barWidth = colWidth * 0.56;

  let bars = '';
  for (let i = 0; i < 7; i++) {
    const colX = padSide + i * colWidth + (colWidth - barWidth) / 2;
    let y = height - padBottom;
    const map = perDay[i];
    for (const p of projectsInWeek) {
      const minutes = map.get(p.id) || 0;
      if (minutes <= 0) continue;
      const segHeight = (minutes / maxTotal) * plotHeight;
      const segY = y - segHeight;
      bars += `<rect x="${colX.toFixed(1)}" y="${segY.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(segHeight, 0).toFixed(1)}" fill="${fillFor.get(p.id)}" rx="2"></rect>`;
      y = segY;
    }
    const labelX = colX + barWidth / 2;
    const isToday = dayKeys[i] === todayKey;
    bars += `<text x="${labelX.toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="13" font-weight="${isToday ? '700' : '400'}" style="fill:var(--text-dim)">${dayLabels[i]}</text>`;
    if (dayTotals[i] > 0) {
      const totalLabelY = Math.max(height - padBottom - (dayTotals[i] / maxTotal) * plotHeight - 6, padTop + 10);
      bars += `<text x="${labelX.toFixed(1)}" y="${totalLabelY.toFixed(1)}" text-anchor="middle" font-size="11" style="fill:var(--text-dim)">${Math.round(dayTotals[i])}m</text>`;
    }
  }

  const baseline = `<line x1="${padSide}" y1="${height - padBottom}" x2="${width - padSide}" y2="${height - padBottom}" style="stroke:var(--border)" stroke-width="1"></line>`;

  chartEl.innerHTML = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs>${baseline}${bars}</svg>`;

  legendEl.innerHTML = projectsInWeek.map((p) => `
    <div class="chart-legend-item">
      <span class="chart-legend-dot" style="background:${projectSwatchCss(p)}"></span>
      <span>${escapeHtml(p.name)}</span>
    </div>
  `).join('');
}

function renderProjects() {
  const listEl = el('#projects-list');
  listEl.innerHTML = '';
  if (state.projects.length === 0) {
    listEl.innerHTML = '<p class="hint-text">No projects yet.</p>';
    return;
  }
  for (const p of state.projects) {
    const row = document.createElement('div');
    row.className = 'project-row';
    row.innerHTML = `
      <div class="entry-color" style="background:${projectSwatchCss(p)}"></div>
      <div class="project-row-name">${escapeHtml(p.name)}${p.archived ? ' (archived)' : ''}</div>
      <button class="icon-btn" data-action="edit">✏️</button>
      <button class="icon-btn" data-action="delete">🗑</button>
    `;
    row.querySelector('[data-action="edit"]').addEventListener('click', () => openProjectModal(p));
    row.querySelector('[data-action="delete"]').addEventListener('click', () => confirmDeleteProject(p));
    listEl.appendChild(row);
  }
}

function renderSyncStatus() {
  const status = syncStatus();
  const statusEl = el('#sync-status');
  const signedOut = el('#sync-signed-out');
  const signedIn = el('#sync-signed-in');
  if (status.connected) {
    const who = status.email || 'your account';
    statusEl.textContent = status.error
      ? `Signed in as ${who}, but syncing is failing: ${status.error}`
      : `Connected as ${who}. Data syncs across devices.`;
    signedOut.classList.add('hidden');
    signedIn.classList.remove('hidden');
  } else {
    statusEl.textContent = 'Not connected. Your data stays only on this device.';
    signedOut.classList.remove('hidden');
    signedIn.classList.add('hidden');
  }
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---------- actions ----------

// Persist + sync an entry/project — the shared tail of every mutation below.
// Callers still `await reload()` themselves afterward (some also need to
// closeModal() first), so that step isn't folded in here.
async function saveEntry(entry) {
  await store.putEntry(entry);
  pushEntry(entry);
}

async function removeEntry(id) {
  await store.deleteEntry(id);
  pushDeleteEntry(id);
}

async function saveProject(project) {
  await store.putProject(project);
  pushProject(project);
}

// Closes out an in-progress pause as of `atMs`, folding the paused duration
// into pauseMs — shared by togglePause (resuming) and stopTimer (stopping
// while paused) so the two can't drift out of sync with each other.
function closePause(entry, atMs) {
  if (entry.paused && entry.pausedAt) {
    const pausedAtMs = new Date(entry.pausedAt).getTime();
    entry.pauseMs = (entry.pauseMs || 0) + Math.max(0, atMs - pausedAtMs);
  }
  entry.paused = false;
  entry.pausedAt = null;
}

// Stages a project for tracking without starting the clock. Purely
// client-side (never persisted) so an abandoned selection leaves no trace.
function selectProject(projectId) {
  if (state.running || state.pendingProjectId) return;
  state.pendingProjectId = projectId;
  renderTimer();
}

async function beginRunning() {
  if (!state.pendingProjectId || state.running) return;
  const entry = {
    id: uuid(),
    projectId: state.pendingProjectId,
    start: new Date().toISOString(),
    end: null,
    note: '',
    paused: false,
    pausedAt: null,
    pauseMs: 0,
    updatedAt: Date.now(),
  };
  state.pendingProjectId = null;
  await saveEntry(entry);
  ensureTicking();
  await reload();
}

async function togglePause() {
  if (!state.running) return;
  const entry = { ...state.running };
  const now = Date.now();
  if (entry.paused) {
    closePause(entry, now);
  } else {
    entry.paused = true;
    entry.pausedAt = new Date(now).toISOString();
  }
  entry.note = runningNoteEl.value.trim();
  entry.updatedAt = now;
  await saveEntry(entry);
  await reload();
}

async function stopTimer(endDate) {
  if (!state.running) return;
  const entry = { ...state.running };
  const end = endDate instanceof Date ? endDate : new Date();
  closePause(entry, end.getTime());
  entry.note = runningNoteEl.value.trim();
  entry.end = end.toISOString();
  entry.updatedAt = Date.now();
  await saveEntry(entry);
  await reload();
}

async function setRunningStart(newStart) {
  if (!state.running) return;
  const entry = { ...state.running, start: newStart.toISOString(), updatedAt: Date.now() };
  await saveEntry(entry);
  await reload();
}

async function confirmDeleteProject(project) {
  const has = state.entries.some((e) => e.projectId === project.id);
  const msg = has
    ? `Delete "${project.name}" and all its time entries? This can't be undone.`
    : `Delete "${project.name}"?`;
  const ok = await openConfirm(msg);
  if (ok) {
    await store.deleteProject(project.id);
    pushDeleteProject(project.id);
    await reload();
  }
}

// ---------- modals ----------

function openModal(html) {
  modalEl.innerHTML = html;
  modalBackdrop.classList.remove('hidden');
}

function closeModal() {
  modalBackdrop.classList.add('hidden');
  modalEl.innerHTML = '';
}

modalBackdrop.addEventListener('click', (e) => {
  if (e.target === modalBackdrop) closeModal();
});

function openConfirm(message, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    openModal(`
      <h2>Are you sure?</h2>
      <p class="hint-text">${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="cf-cancel">Cancel</button>
        <button class="btn btn-danger" id="cf-ok">${escapeHtml(confirmLabel)}</button>
      </div>
    `);
    el('#cf-cancel').addEventListener('click', () => { closeModal(); resolve(false); });
    el('#cf-ok').addEventListener('click', () => { closeModal(); resolve(true); });
  });
}

function openSyncModal() {
  const existing = getConfig();
  openModal(`
    <h2>Cloud sync setup</h2>
    <p class="hint-text">Create a free project at console.firebase.google.com, enable <strong>Firestore</strong> and <strong>Google</strong> sign-in under Authentication, then paste your web app config below (Project settings → Your apps → SDK setup and configuration).</p>
    <div class="field">
      <label>Firebase config (paste it exactly as the console shows it)</label>
      <textarea id="sf-config" rows="6" placeholder='const firebaseConfig = { apiKey: "...", authDomain: "...", projectId: "...", ... };'>${existing ? escapeHtml(JSON.stringify(existing, null, 2)) : ''}</textarea>
    </div>
    <p class="hint-text" id="sf-error"></p>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="sf-cancel">Cancel</button>
      <button class="btn" id="sf-connect">Connect</button>
    </div>
  `);
  el('#sf-cancel').addEventListener('click', closeModal);
  el('#sf-connect').addEventListener('click', async () => {
    let config;
    try {
      config = parseConfigText(el('#sf-config').value);
    } catch (err) {
      el('#sf-error').textContent = err.message;
      return;
    }
    const btn = el('#sf-connect');
    btn.textContent = 'Connecting…';
    btn.disabled = true;
    try {
      await connectWithConfig(config, async () => { await reload(); });
      closeModal();
      await reload();
    } catch (err) {
      el('#sf-error').textContent = 'Connection failed: ' + (err && err.message ? err.message : err);
      btn.textContent = 'Connect';
      btn.disabled = false;
    }
  });
}

// Read-only view of the Firebase config this device is syncing with, so it
// can be checked or copied to set up sync on another device.
function openSyncSettingsModal() {
  const config = getConfig();
  const status = syncStatus();
  const json = config ? JSON.stringify(config, null, 2) : '';
  openModal(`
    <h2>Sync settings</h2>
    <p class="hint-text">Signed in as <strong>${escapeHtml(status.email || 'unknown account')}</strong>${config && config.projectId ? ` · Firebase project <strong>${escapeHtml(config.projectId)}</strong>` : ''}.</p>
    <div class="field">
      <label>Firebase config in use on this device</label>
      <textarea id="ss-config" rows="9" readonly>${escapeHtml(json || 'No saved config found.')}</textarea>
    </div>
    <p class="hint-text">To sync another device, paste this into Settings → Set up cloud sync there, then sign in with the same Google account.</p>
    <p class="hint-text" id="ss-status"></p>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="ss-close">Close</button>
      <button class="btn" id="ss-copy" ${json ? '' : 'disabled'}>Copy</button>
    </div>
  `);
  const textarea = el('#ss-config');
  el('#ss-close').addEventListener('click', closeModal);
  el('#ss-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(json);
      el('#ss-status').textContent = 'Copied to clipboard.';
    } catch {
      textarea.focus();
      textarea.select();
      el('#ss-status').textContent = 'Could not access the clipboard — text is selected, copy it manually.';
    }
  });
}

function openStartAtModal() {
  if (!state.running) return;
  const startDate = new Date(state.running.start);
  openModal(`
    <h2>Start at</h2>
    <div class="field">
      <label>Time</label>
      <input type="time" id="sa-time" value="${toTimeInputValue(state.running.start)}" />
    </div>
    <p class="hint-text" id="sa-error"></p>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="sa-cancel">Cancel</button>
      <button class="btn" id="sa-save">Save</button>
    </div>
  `);
  el('#sa-cancel').addEventListener('click', closeModal);
  el('#sa-save').addEventListener('click', async () => {
    const timeVal = el('#sa-time').value;
    if (!timeVal) {
      el('#sa-error').textContent = 'Please choose a time.';
      return;
    }
    const [h, m] = timeVal.split(':').map(Number);
    const newStart = new Date(startDate);
    newStart.setHours(h, m, 0, 0);
    if (newStart.getTime() > Date.now()) {
      el('#sa-error').textContent = 'Start time cannot be in the future.';
      return;
    }
    closeModal();
    await setRunningStart(newStart);
  });
}

function openEndAtModal() {
  if (!state.running) return;
  const startDate = new Date(state.running.start);
  openModal(`
    <h2>End at</h2>
    <div class="field">
      <label>Time</label>
      <input type="time" id="ea-time" value="${toTimeInputValue(new Date().toISOString())}" />
    </div>
    <p class="hint-text" id="ea-error"></p>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="ea-cancel">Cancel</button>
      <button class="btn" id="ea-save">Stop</button>
    </div>
  `);
  el('#ea-cancel').addEventListener('click', closeModal);
  el('#ea-save').addEventListener('click', async () => {
    const timeVal = el('#ea-time').value;
    if (!timeVal) {
      el('#ea-error').textContent = 'Please choose a time.';
      return;
    }
    const [h, m] = timeVal.split(':').map(Number);
    const newEnd = new Date(startDate);
    newEnd.setHours(h, m, 0, 0);
    if (newEnd.getTime() < startDate.getTime()) {
      newEnd.setDate(newEnd.getDate() + 1);
    }
    if (newEnd.getTime() < startDate.getTime()) {
      el('#ea-error').textContent = 'End time must be after the start time.';
      return;
    }
    if (newEnd.getTime() > Date.now()) {
      el('#ea-error').textContent = 'End time cannot be in the future.';
      return;
    }
    closeModal();
    await stopTimer(newEnd);
  });
}

function openExportModal() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    projects: state.projects,
    entries: state.entries,
  };
  const json = JSON.stringify(payload, null, 2);
  openModal(`
    <h2>Export data</h2>
    <p class="hint-text">Copy this text, then paste it into Import data on the other install.</p>
    <div class="field">
      <textarea id="ex-json" rows="10" readonly>${escapeHtml(json)}</textarea>
    </div>
    <p class="hint-text" id="ex-status"></p>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="ex-close">Close</button>
      <button class="btn" id="ex-copy">Copy</button>
    </div>
  `);
  const textarea = el('#ex-json');
  el('#ex-close').addEventListener('click', closeModal);
  el('#ex-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(json);
      el('#ex-status').textContent = 'Copied to clipboard.';
    } catch {
      textarea.focus();
      textarea.select();
      el('#ex-status').textContent = 'Could not access the clipboard — text is selected, copy it manually.';
    }
  });
}

function openImportModal() {
  openModal(`
    <h2>Import data</h2>
    <p class="hint-text">Paste the text from Export data on the other install. Imported projects and entries are added alongside what's already here.</p>
    <div class="field">
      <textarea id="im-json" rows="10" placeholder="Paste exported JSON here"></textarea>
    </div>
    <p class="hint-text" id="im-error"></p>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="im-cancel">Cancel</button>
      <button class="btn" id="im-import">Import</button>
    </div>
  `);
  el('#im-cancel').addEventListener('click', closeModal);
  el('#im-import').addEventListener('click', async () => {
    let payload;
    try {
      payload = JSON.parse(el('#im-json').value);
    } catch {
      el('#im-error').textContent = 'That is not valid JSON.';
      return;
    }
    if (!Array.isArray(payload.projects) || !Array.isArray(payload.entries)) {
      el('#im-error').textContent = 'This does not look like exported TimeTracker data.';
      return;
    }
    for (const p of payload.projects) await saveProject(p);
    for (const e of payload.entries) await saveEntry(e);
    closeModal();
    await reload();
  });
}

function openProjectModal(project) {
  const isEdit = !!project;
  const p = project || { id: null, name: '', color: PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length], color2: null, archived: false };
  let leftColor = isHexColor(p.color) ? p.color.toLowerCase() : PROJECT_COLORS[0];
  let rightColor = isHexColor(p.color2) ? p.color2.toLowerCase() : null;
  // The presets plus every color any project already uses, so a custom color
  // picked once (say a topic's shared left color) shows up as a swatch for
  // the others too and can be reused exactly rather than eyeballed.
  const palette = [...new Set([
    ...PROJECT_COLORS,
    ...state.projects.flatMap((q) => [q.color, q.color2]).filter(isHexColor).map((c) => c.toLowerCase()),
    leftColor,
    ...(rightColor ? [rightColor] : []),
  ])];

  openModal(`
    <h2>${isEdit ? 'Edit project' : 'New project'}</h2>
    <div class="field">
      <label>Name</label>
      <input type="text" id="pf-name" value="${escapeHtml(p.name)}" placeholder="e.g. Client Website" />
    </div>
    <div class="field">
      <label>Color <span class="color-preview" id="pf-preview"></span></label>
      <div class="color-field-label">Left half &mdash; topic color (share it across related projects)</div>
      <div class="color-swatches" id="pf-colors-left"></div>
      <div class="color-field-label">Right half &mdash; this project</div>
      <div class="color-swatches" id="pf-colors-right"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="pf-cancel">Cancel</button>
      ${isEdit ? '<button class="btn btn-danger" id="pf-archive">' + (p.archived ? 'Unarchive' : 'Archive') + '</button>' : ''}
      <button class="btn" id="pf-save">Save</button>
    </div>
  `);

  const swatchHtml = (c, selected) => `<div class="color-swatch${selected ? ' selected' : ''}" style="background:${c}" data-color="${c}"></div>`;
  const customHtml = (id, value) => `<label class="color-swatch color-custom" title="Custom color">+<input type="color" id="${id}" value="${value}"></label>`;
  const updatePreview = () => {
    el('#pf-preview').style.background = projectSwatchCss({ color: leftColor, color2: rightColor });
  };
  function renderSwatches() {
    el('#pf-colors-left').innerHTML =
      palette.map((c) => swatchHtml(c, c === leftColor)).join('') + customHtml('pf-custom-left', leftColor);
    el('#pf-colors-right').innerHTML =
      `<div class="color-swatch color-none${rightColor === null ? ' selected' : ''}" data-color="" title="Solid color (no right half)">&#10005;</div>` +
      palette.map((c) => swatchHtml(c, c === rightColor)).join('') + customHtml('pf-custom-right', rightColor || leftColor);
    updatePreview();
  }
  renderSwatches();

  // Delegated, since renderSwatches() replaces the swatch elements.
  el('#pf-colors-left').addEventListener('click', (e) => {
    const sw = e.target.closest('.color-swatch[data-color]');
    if (!sw) return;
    leftColor = sw.dataset.color;
    renderSwatches();
  });
  el('#pf-colors-right').addEventListener('click', (e) => {
    const sw = e.target.closest('.color-swatch[data-color]');
    if (!sw) return;
    rightColor = sw.dataset.color || null;
    renderSwatches();
  });
  // The picker fires `input` continuously while dragging; re-rendering then
  // would replace the <input> mid-interaction and close the picker, so only
  // the preview updates live and the swatch rows are rebuilt once it commits.
  for (const [side, setColor] of [['left', (c) => { leftColor = c; }], ['right', (c) => { rightColor = c; }]]) {
    const container = el(`#pf-colors-${side}`);
    container.addEventListener('input', (e) => {
      if (!e.target.matches('input[type="color"]')) return;
      setColor(e.target.value.toLowerCase());
      updatePreview();
    });
    container.addEventListener('change', (e) => {
      if (!e.target.matches('input[type="color"]')) return;
      const c = e.target.value.toLowerCase();
      setColor(c);
      if (!palette.includes(c)) palette.push(c);
      renderSwatches();
    });
  }

  el('#pf-cancel').addEventListener('click', closeModal);
  if (isEdit) {
    el('#pf-archive').addEventListener('click', async () => {
      const updated = { ...p, archived: !p.archived, updatedAt: Date.now() };
      await saveProject(updated);
      closeModal();
      await reload();
    });
  }
  el('#pf-save').addEventListener('click', async () => {
    const name = el('#pf-name').value.trim();
    if (!name) { el('#pf-name').focus(); return; }
    const updated = {
      id: p.id || uuid(),
      name,
      color: leftColor,
      color2: rightColor || null,
      archived: p.archived || false,
      createdAt: p.id ? p.createdAt : Date.now(),
      updatedAt: Date.now(),
    };
    await saveProject(updated);
    closeModal();
    await reload();
  });
}

function toDateInputValue(iso) {
  return fmtDateKey(iso);
}
function toTimeInputValue(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openEntryModal(entry) {
  const isEdit = !!entry;
  const e = entry || {
    id: null,
    projectId: state.projects.find((p) => !p.archived)?.id || '',
    start: new Date().toISOString(),
    end: new Date().toISOString(),
    note: '',
  };
  const projectOptions = state.projects
    .map((p) => `<option value="${p.id}" ${p.id === e.projectId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`)
    .join('');

  openModal(`
    <h2>${isEdit ? 'Edit entry' : 'Add manual entry'}</h2>
    <div class="field">
      <label>Project</label>
      <select id="ef-project">${projectOptions}</select>
    </div>
    <div class="field">
      <label>Date</label>
      <input type="date" id="ef-date" value="${toDateInputValue(e.start)}" />
    </div>
    <div class="field">
      <label>Start time</label>
      <input type="time" id="ef-start" value="${toTimeInputValue(e.start)}" />
    </div>
    <div class="field">
      <label>End time</label>
      <input type="time" id="ef-end" value="${toTimeInputValue(e.end)}" />
    </div>
    <div class="field">
      <label>Note</label>
      <textarea id="ef-note">${escapeHtml(e.note || '')}</textarea>
    </div>
    <p class="hint-text" id="ef-error"></p>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="ef-cancel">Cancel</button>
      ${isEdit ? '<button class="btn btn-danger" id="ef-delete">Delete</button>' : ''}
      <button class="btn" id="ef-save">Save</button>
    </div>
  `);

  el('#ef-cancel').addEventListener('click', closeModal);
  if (isEdit) {
    el('#ef-delete').addEventListener('click', async () => {
      const ok = await openConfirm('Delete this entry?');
      if (!ok) return;
      await removeEntry(e.id);
      closeModal();
      await reload();
    });
  }
  el('#ef-save').addEventListener('click', async () => {
    const projectId = el('#ef-project').value;
    const date = el('#ef-date').value;
    const startTime = el('#ef-start').value;
    const endTime = el('#ef-end').value;
    if (!projectId || !date || !startTime || !endTime) {
      el('#ef-error').textContent = 'Please fill in all fields.';
      return;
    }
    const start = new Date(`${date}T${startTime}:00`);
    const end = new Date(`${date}T${endTime}:00`);
    if (end <= start) {
      el('#ef-error').textContent = 'End time must be after start time.';
      return;
    }
    const updated = {
      id: e.id || uuid(),
      projectId,
      start: start.toISOString(),
      end: end.toISOString(),
      note: el('#ef-note').value.trim(),
      paused: false,
      pausedAt: null,
      pauseMs: e.pauseMs || 0,
      updatedAt: Date.now(),
    };
    await saveEntry(updated);
    closeModal();
    await reload();
  });
}

// ---------- note textarea ----------

function autoResizeNote(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

// Pure decision logic for what Enter should do to a numbered-list textarea:
// continue the current number, end the list on an empty item, auto-start a
// list from a plain line, or (returning null) let a normal newline happen.
// Kept free of DOM reads/writes so it can be reasoned about/tested on its
// own, separately from the event-handling and textarea mutation below.
function computeListContinuation(value, cursor) {
  const lineStart = value.lastIndexOf('\n', cursor - 1) + 1;
  const currentLine = value.slice(lineStart, cursor);
  const match = currentLine.match(/^(\d+)\.\s(.*)$/);

  if (match) {
    const num = parseInt(match[1], 10);
    const restOfLine = match[2];
    if (restOfLine.trim() === '') {
      // Empty list item: remove its "N. " prefix and end the list.
      return { value: value.slice(0, lineStart) + value.slice(cursor), cursor: lineStart };
    }
    const insertion = `\n${num + 1}. `;
    return {
      value: value.slice(0, cursor) + insertion + value.slice(cursor),
      cursor: cursor + insertion.length,
    };
  }

  // Not on a numbered line yet: pressing Enter after typing something starts
  // the list automatically — the line just typed becomes "1. ", and the new
  // line becomes "2. ", so you don't have to type "1. " yourself first.
  // Enter on a blank line just inserts a normal newline (no numbering).
  if (currentLine.trim() === '') return null;
  const insertion = `1. ${currentLine}\n2. `;
  return {
    value: value.slice(0, lineStart) + insertion + value.slice(cursor),
    cursor: lineStart + insertion.length,
  };
}

function handleNoteKeydown(e) {
  if (e.key !== 'Enter' || e.shiftKey) return;
  const ta = e.target;
  const result = computeListContinuation(ta.value, ta.selectionStart);
  if (!result) return;
  e.preventDefault();
  ta.value = result.value;
  ta.selectionStart = ta.selectionEnd = result.cursor;
  autoResizeNote(ta);
}

const runningNoteEl = el('#running-note');
runningNoteEl.addEventListener('keydown', handleNoteKeydown);
runningNoteEl.addEventListener('input', () => autoResizeNote(runningNoteEl));

// ---------- navigation ----------

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  el(`#view-${view}`).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const titles = { timer: 'Timer', history: 'History', projects: 'Projects', settings: 'Settings' };
  el('#page-title').textContent = titles[view];
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

el('#start-btn').addEventListener('click', beginRunning);
el('#stop-btn').addEventListener('click', async () => {
  if (state.pendingProjectId) {
    state.pendingProjectId = null;
    renderTimer();
    return;
  }
  if (!state.running) return;
  const ok = await openConfirm('End this session and save your time?', 'End session');
  if (!ok) return;
  await stopTimer();
});
el('#pause-btn').addEventListener('click', togglePause);
el('#start-at-btn').addEventListener('click', openStartAtModal);
el('#end-at-btn').addEventListener('click', openEndAtModal);
el('#add-project-btn').addEventListener('click', () => openProjectModal(null));
el('#add-entry-btn').addEventListener('click', () => openEntryModal(null));

el('#week-prev-btn').addEventListener('click', () => {
  state.chartOffsetWeeks += 1;
  renderHistory();
});
el('#week-next-btn').addEventListener('click', () => {
  if (state.chartOffsetWeeks === 0) return;
  state.chartOffsetWeeks -= 1;
  renderHistory();
});

el('#export-data-btn').addEventListener('click', openExportModal);
el('#import-data-btn').addEventListener('click', openImportModal);

el('#sync-setup-btn').addEventListener('click', openSyncModal);
el('#sync-view-btn').addEventListener('click', openSyncSettingsModal);
el('#sync-signout-btn').addEventListener('click', async () => {
  await disconnectSync();
  renderSyncStatus();
});

// ---------- build info ----------

// version.json is written by the GitHub Actions deploy workflow (see
// .github/workflows/deploy-pages.yml) and doesn't exist for a local
// `python -m http.server` copy — the 404 there is expected, not an error,
// so #build-info just keeps its "local copy" default in that case.
async function loadBuildInfo() {
  try {
    const res = await fetch('./version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const info = await res.json();
    if (!info.sha) return;
    document.title = `TimeTracker · ${info.sha}`;
    const deployed = info.deployedAt
      ? new Date(info.deployedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
      : 'unknown time';
    el('#build-info').textContent = `Build: ${info.sha} · deployed ${deployed}`;
  } catch {
    // offline or not deployed — leave the default message
  }
}

// ---------- init ----------

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  loadBuildInfo();
  await initSync(store, async () => { await reload(); });
  await reload();
  ensureTicking();
}

init();
