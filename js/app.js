import { store, uuid } from './db.js';
import { syncStatus, initSync, getConfig, connectWithConfig, disconnectSync, pushProject, pushEntry, pushDeleteProject, pushDeleteEntry } from './sync.js';

const PROJECT_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#4b5563', '#ca8a04', '#059669',
];

const state = {
  projects: [],
  projectsById: new Map(), // kept in sync with `projects` on every reload(), for O(1) lookups
  entries: [],
  running: null, // entry object with end === null
  pendingProjectId: null, // project chosen but not yet started (client-side only, never persisted)
  view: 'timer',
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
    btn.style.background = p.color;
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
  chartStart.setDate(chartStart.getDate() - 6);
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
        <div class="entry-color" style="background:${p ? p.color : '#999'}"></div>
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

  if (projectIdsInWeek.size === 0) {
    card.classList.add('hidden');
    chartEl.innerHTML = '';
    legendEl.innerHTML = '';
    return;
  }
  card.classList.remove('hidden');

  const projectsInWeek = [...projectIdsInWeek]
    .map((id) => projectById(id))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  const dayTotals = perDay.map((map) => [...map.values()].reduce((a, b) => a + b, 0));
  const maxTotal = Math.max(1, ...dayTotals);

  const width = 700;
  const height = 220;
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
      bars += `<rect x="${colX.toFixed(1)}" y="${segY.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(segHeight, 0).toFixed(1)}" fill="${p.color}" rx="2"></rect>`;
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

  chartEl.innerHTML = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${baseline}${bars}</svg>`;

  legendEl.innerHTML = projectsInWeek.map((p) => `
    <div class="chart-legend-item">
      <span class="chart-legend-dot" style="background:${p.color}"></span>
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
      <div class="entry-color" style="background:${p.color}"></div>
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
    statusEl.textContent = `Connected as ${status.email || 'your account'}. Data syncs across devices.`;
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
      <label>Firebase config (JSON)</label>
      <textarea id="sf-config" rows="6" placeholder='{"apiKey": "...", "authDomain": "...", "projectId": "..."}'>${existing ? escapeHtml(JSON.stringify(existing, null, 2)) : ''}</textarea>
    </div>
    <p class="hint-text" id="sf-error"></p>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="sf-cancel">Cancel</button>
      <button class="btn" id="sf-connect">Connect</button>
    </div>
  `);
  el('#sf-cancel').addEventListener('click', closeModal);
  el('#sf-connect').addEventListener('click', async () => {
    const raw = el('#sf-config').value.trim();
    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      el('#sf-error').textContent = 'That is not valid JSON.';
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

function openProjectModal(project) {
  const isEdit = !!project;
  const p = project || { id: null, name: '', color: PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length], archived: false };
  openModal(`
    <h2>${isEdit ? 'Edit project' : 'New project'}</h2>
    <div class="field">
      <label>Name</label>
      <input type="text" id="pf-name" value="${escapeHtml(p.name)}" placeholder="e.g. Client Website" />
    </div>
    <div class="field">
      <label>Color</label>
      <div class="color-swatches" id="pf-colors">
        ${PROJECT_COLORS.map((c) => `<div class="color-swatch${c === p.color ? ' selected' : ''}" style="background:${c}" data-color="${c}"></div>`).join('')}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="pf-cancel">Cancel</button>
      ${isEdit ? '<button class="btn btn-danger" id="pf-archive">' + (p.archived ? 'Unarchive' : 'Archive') + '</button>' : ''}
      <button class="btn" id="pf-save">Save</button>
    </div>
  `);

  let selectedColor = p.color;
  modalEl.querySelectorAll('.color-swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      selectedColor = sw.dataset.color;
      modalEl.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
      sw.classList.add('selected');
    });
  });

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
      color: selectedColor,
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

el('#sync-setup-btn').addEventListener('click', openSyncModal);
el('#sync-signout-btn').addEventListener('click', async () => {
  await disconnectSync();
  renderSyncStatus();
});

// ---------- init ----------

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  await initSync(store, async () => { await reload(); });
  await reload();
  ensureTicking();
}

init();
