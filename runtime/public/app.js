const S = {
  tab: 'home',
  meta: null,
  dashboard: null,
  timeline: null,
  calendar: null,
  calYear: null,
  calMonth: null,
  calDay: null,
  calZoom: 'hour',
  calDrag: null,
  calNowTimer: null,
  calQuickAdd: null,
  importMode: 'campaign',
  importDayFrom: 1,
  importDayTo: 30,
  activeWorkspaceId: null,
  composerDays: null,
  composerExpanded: {},
  agents: null,
  newCampaign: null,
  wizard: { step: 0, templateId: null, inputs: {}, runMode: 'supervised', schedule: { type: 'manual' }, instructions: {} },
  selectedTask: null,
  instrTab: null,
  poll: null,
};

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace(`/login.html?next=${next}`);
    throw new Error('unauthorized');
  }
  if (!r.ok) {
    const err = new Error(j.error || j.hint || r.statusText);
    if (Array.isArray(j.errors)) err.errors = j.errors;
    throw err;
  }
  return j;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  const root = document.getElementById('toast-root');
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

const STATUS_LABELS = {
  running: 'Running',
  scheduled: 'Scheduled',
  completed: 'Done',
  failed: 'Failed',
  draft: 'Draft',
  paused: 'Paused',
};

function statusBadge(st) {
  return `<span class="badge ${st}">${STATUS_LABELS[st] || st}</span>`;
}

function runModeLabel(id) {
  return S.meta?.runModes?.find(m => m.id === id)?.label || id;
}

function renderAgentSelect(fieldKey, current) {
  const agents = S.agents || [];
  const options = [`<option value="auto" ${!current || current === 'auto' ? 'selected' : ''}>Auto (first available)</option>`]
    .concat(agents.map(a => {
      const disabled = !a.available || a.inCooldown;
      const tag = !a.available ? ' (not installed)' : a.inCooldown ? ` (limit reached, retrying after ${new Date(a.cooldownUntil).toLocaleTimeString()})` : '';
      return `<option value="${a.id}" ${current === a.id ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${esc(a.label)}${tag}</option>`;
    }));
  return `<select id="${fieldKey}" data-field="${fieldKey}">${options.join('')}</select>`;
}

function agentDefaults(agentId) {
  const agents = S.agents || [];
  if (!agentId || agentId === 'auto') return agents.find(a => a.available) || agents[0] || {};
  return agents.find(a => a.id === agentId) || {};
}

// --- Codebase/folder path fields: browse + copy, so a path never has to be typed from memory ---

function pathFieldHTML({ id, dataField, value, placeholder, help, browse = true, copy = true, readonly = false } = {}) {
  const attrs = id ? `id="${id}"` : `data-field="${esc(dataField)}"`;
  return `<div class="path-field">
    <input type="text" ${attrs} value="${esc(value || '')}" placeholder="${esc(placeholder || '')}" autocomplete="off" ${readonly ? 'readonly' : ''}/>
    ${browse ? `<button type="button" class="icon-btn path-field__btn" data-path-browse title="Browse for folder…" aria-label="Browse for folder">📁</button>` : ''}
    ${copy ? `<button type="button" class="icon-btn path-field__btn" data-path-copy title="Copy path" aria-label="Copy path">⧉</button>` : ''}
  </div>${help ? `<div class="hint">${esc(help)}</div>` : ''}`;
}

function wirePathPickers(root) {
  (root || document).querySelectorAll('[data-path-browse]').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      const input = btn.closest('.path-field')?.querySelector('input');
      if (!input) return;
      openPathPicker(input.value.trim(), (picked) => {
        input.value = picked;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
  });
  (root || document).querySelectorAll('[data-path-copy]').forEach(btn => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const input = btn.closest('.path-field')?.querySelector('input');
      const val = input?.value?.trim();
      if (!val) { toast('Nothing to copy yet'); return; }
      try {
        await navigator.clipboard.writeText(val);
        toast('Path copied');
      } catch {
        toast('Could not copy — select and copy it manually');
      }
    });
  });
}

async function pathPickerLoad(target) {
  const list = document.getElementById('path-picker-list');
  const crumbs = document.getElementById('path-picker-crumbs');
  const input = document.getElementById('path-picker-input');
  list.innerHTML = '<p class="empty">Loading…</p>';
  let data;
  try {
    data = await api(`/api/fs/browse?path=${encodeURIComponent(target || '')}`);
  } catch (e) {
    list.innerHTML = `<p class="empty">${esc(e.message || 'Could not read that folder')}</p>`;
    return;
  }
  S.pathPickerCurrent = data.path;
  input.value = data.path;

  const parts = data.path.split('/').filter(Boolean);
  let acc = '';
  const crumbHtml = [`<button type="button" class="path-crumb" data-crumb="/">/</button>`];
  parts.forEach(part => {
    acc += '/' + part;
    crumbHtml.push(`<button type="button" class="path-crumb" data-crumb="${esc(acc)}">${esc(part)}</button>`);
  });
  crumbs.innerHTML = crumbHtml.join('');
  crumbs.querySelectorAll('[data-crumb]').forEach(b => { b.onclick = () => pathPickerLoad(b.dataset.crumb); });

  const rows = [];
  if (data.parent) rows.push(`<button type="button" class="path-row path-row--up" data-nav="${esc(data.parent)}"><span>↑</span> Up a level</button>`);
  data.entries.forEach(e => rows.push(`<button type="button" class="path-row" data-nav="${esc(e.path)}"><span>📁</span> ${esc(e.name)}</button>`));
  list.innerHTML = rows.join('') || '<p class="empty">No subfolders here</p>';
  list.querySelectorAll('[data-nav]').forEach(b => { b.onclick = () => pathPickerLoad(b.dataset.nav); });
}

function openPathPicker(initialPath, onSelect) {
  S.pathPicker = { onSelect };
  document.getElementById('path-picker-modal').classList.remove('hidden');
  pathPickerLoad(initialPath || '');
}

function normalizeScheduleType(type) {
  return type === 'datetime' ? 'once' : type;
}

function isRecurringScheduleType(type) {
  return ['interval', 'hourly', 'daily', 'weekly', 'monthly'].includes(normalizeScheduleType(type));
}

function toLocalDatetime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function timeValue(hour = 9, minute = 0) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(hour)}:${pad(minute)}`;
}

function formatScheduleLabel(schedule) {
  if (!schedule) return 'Scheduled';
  const type = normalizeScheduleType(schedule.type);
  if (type === 'manual') return 'Start manually';
  if (type === 'now') return 'Queued now';
  if (type === 'once') {
    if (!schedule.runAt) return 'Once';
    return `Once · ${new Date(schedule.runAt).toLocaleString()}`;
  }
  if (type === 'campaign_day') return `Day ${schedule.campaignDay || '?'}`;
  if (type === 'interval') return `Every ${schedule.intervalMinutes || 30} min`;
  if (type === 'hourly') return `Hourly at :${String(schedule.minute || 0).padStart(2, '0')}`;
  if (type === 'daily') {
    const h = schedule.hour ?? 9;
    const m = schedule.minute || 0;
    return `Daily at ${timeValue(h, m)}`;
  }
  if (type === 'weekly') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `Every ${days[schedule.dayOfWeek ?? 1]} at ${timeValue(schedule.hour ?? 9, schedule.minute)}`;
  }
  if (type === 'monthly') {
    return `Monthly day ${schedule.dayOfMonth || 1} at ${timeValue(schedule.hour ?? 9, schedule.minute)}`;
  }
  if (schedule.runAt) return `Next · ${new Date(schedule.runAt).toLocaleString()}`;
  return type;
}

function scheduleLabelForTask(t) {
  return t.scheduleLabel || formatScheduleLabel(t.schedule);
}

function taskCard(t, extraClass = '') {
  const when = t.status === 'draft' ? 'Not scheduled yet' : scheduleLabelForTask(t);
  const thumb = t.thumbUrl
    ? `<img class="task-card__thumb" src="${t.thumbUrl}" alt=""/>`
    : '';
  const showWs = t.workspaceName && (S.dashboard?.campaigns?.length || 0) > 1;
  // Macro Detector suggestion: this job type has, at least 3× across at least 2 different
  // days, been followed by another specific job type in this workspace. Clicking it only
  // prefills the wizard (openWizard, wired in bindMain) — it never creates or queues anything
  // on its own.
  const macroRow = (extraClass === 'done' && t.suggestedMacro)
    ? `<div class="macro-suggest">
        <span>Usually followed by <strong>${esc(t.suggestedMacro.label)}</strong></span>
        <button type="button" class="btn btn-tonal sm" data-macro-run="${t.id}">${t.suggestedMacro.icon} Set it up</button>
      </div>`
    : '';
  return `<div class="task-card ${extraClass}" data-task="${t.id}">
    <div class="task-card__body">
      ${thumb}
      <div style="min-width:0">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-sub">${showWs ? esc(t.workspaceName) + ' · ' : ''}${esc(when)} · ${esc(runModeLabel(t.runMode))}${t.summary ? ' · ' + esc(t.summary) : ''}</div>
      </div>
    </div>
    ${statusBadge(t.status)}
    ${macroRow}
  </div>`;
}

function renderCampaignBanner(camp) {
  const pct = Math.round((camp.completed / camp.totalDays) * 100);
  const today = camp.todayTask;
  const todayStatus = today?.status || 'scheduled';
  return `
    <div class="campaign-banner">
      <div class="campaign-banner-head">
        <div>
          <h2>${esc(camp.name)}</h2>
          <p class="sub">Day ${camp.todayDay} of ${camp.totalDays} · Started ${esc(camp.startDate)} · Runs ${esc(camp.dailyRun)} ${esc(camp.timezone)}</p>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="pill ${todayStatus === 'completed' ? 'ok' : todayStatus === 'running' ? 'live' : ''}">${pct}% done</div>
          ${camp.campaignPaused
            ? `<button class="btn btn-filled sm" data-resume-workspace="${camp.id}">Resume campaign</button>`
            : `<button class="btn btn-text sm" data-pause-workspace="${camp.id}">Pause campaign</button>`}
        </div>
      </div>
      <div class="progress-bar"><span style="width:${pct}%"></span></div>
      ${today ? `
        <div class="campaign-today">
          <div class="campaign-today__label">Today's job</div>
          <p>${esc(today.title)} ${statusBadge(todayStatus)}</p>
          <div class="campaign-today__actions">
            <button class="btn btn-outlined sm" data-open-task="${today.id}">Open job</button>
            ${todayStatus !== 'completed' && todayStatus !== 'running' ? `<button class="btn btn-tonal sm" data-start-task="${today.id}">Run day ${camp.todayDay} now</button>` : ''}
            <button class="btn btn-text sm" data-tab-jump="timeline">See timeline</button>
          </div>
        </div>` : ''}
    </div>`;
}

function renderCampaignBanners() {
  return (S.dashboard?.campaigns || []).map(renderCampaignBanner).join('');
}

function renderHome() {
  const d = S.dashboard;
  if (!d) return '<p class="empty">Loading…</p>';
  const running = d.running[0] || (d.liveRuns?.[0] ? { id: d.liveRuns[0].taskId, title: d.liveRuns[0].title, runMode: 'auto', execution: { attempts: 1 }, _live: true } : null);
  return `
    ${renderCampaignBanners()}
    <div class="stats">
      <div class="stat"><strong>${d.stats.completed}</strong><span>Finished</span></div>
      <div class="stat"><strong>${d.stats.scheduled}</strong><span>Scheduled</span></div>
      <div class="stat"><strong>${d.stats.drafts || 0}</strong><span>Drafts</span></div>
      <div class="stat"><strong>${d.stats.running || d.liveRuns?.length || 0}</strong><span>Running</span></div>
      <div class="stat"><strong>${d.stats.paused || 0}</strong><span>Paused</span></div>
    </div>
    ${running ? `
      <div class="hero-card running">
        <h3>Running: ${esc(running.title)}</h3>
        <p class="hero-meta">${running._live ? 'Started by autopilot' : 'In progress'} · ${esc(runModeLabel(running.runMode))} · Attempt ${running.execution?.attempts || 1}</p>
        <div class="status-actions">
          ${running.id ? `<button class="btn btn-outlined" data-open-task="${running.id}">View progress</button>` : ''}
        </div>
      </div>` : `
      <div class="hero-card">
        <h3>No jobs running</h3>
        <p class="hero-meta">Create a job or start one from the queue. Omnish notifies you when a job starts and when it finishes.</p>
        <div class="status-actions">
          <button class="btn btn-filled" id="btn-add-inline">Create job</button>
        </div>
      </div>`}
    ${(d.drafts || []).length ? `<section class="section"><h2>Drafts</h2><div class="task-grid">${d.drafts.map(t => taskCard(t, 'future')).join('')}</div></section>` : ''}
    <section class="section">
      <h2>Up next</h2>
      <div class="task-grid">
        ${d.upcoming.length ? d.upcoming.slice(0, 8).map(t => taskCard(t, 'future')).join('') : '<p class="empty">Nothing scheduled yet. Sync a workspace or create a job.</p>'}
      </div>
    </section>
    <section class="section">
      <h2>Recently finished</h2>
      <div class="task-grid">
        ${d.completed.length ? d.completed.map(t => taskCard(t, 'done')).join('') : '<p class="empty">Finished jobs show up here with outputs, posts, and reports.</p>'}
      </div>
    </section>
    ${d.failed.length ? `<section class="section"><h2>Needs attention</h2><div class="task-grid">${d.failed.map(t => taskCard(t, 'fail')).join('')}</div></section>` : ''}
    ${(d.paused || []).length ? `<section class="section"><h2>Paused</h2><div class="task-grid">${d.paused.map(t => taskCard(t, 'paused')).join('')}</div></section>` : ''}`;
}

function renderTimeline() {
  const tl = S.timeline;
  if (!tl) return '<p class="empty">Loading timeline…</p>';

  let cells = '';
  for (const entry of tl.days) {
    const t = entry.task;
    const planned = entry.planned;
    let cls = '';
    if (t?.status === 'completed') cls = 'done';
    else if (t?.status === 'running') cls = 'running';
    else if (!t && planned) cls = 'planned';
    else if (!t) cls = 'missing';

    const lbl = t
      ? t.title.replace(/^Day \d+ — /, '')
      : (planned?.title || 'No plan');

    cells += `<div class="day-tile ${cls}" data-day-task="${t?.id || ''}" data-day="${entry.day}" data-has-plan="${planned ? '1' : '0'}">
      <div class="day-num">${entry.day}</div>
      <div class="day-lbl">${esc(lbl.slice(0, 40))}</div>
    </div>`;
  }

  const missing = tl.stats?.missingJobs || 0;
  return `
    <div style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:8px">
      ${renderWorkspaceSwitcher()}
      <button class="btn btn-outlined" id="btn-new-campaign" style="margin-bottom:16px">New campaign</button>
    </div>
    <section class="section">
      <h2>${esc(tl.workspaceName || 'Campaign timeline')}</h2>
      <p class="section-lead">${tl.stats?.withJobs || 0} of ${tl.totalDays} days have jobs. Tap a day to open it. Teal days are finished.</p>
      ${missing ? `<p class="section-lead" style="color:var(--md-sys-color-primary)">${missing} planned day(s) are not imported yet. Use Import jobs to add them.</p>` : ''}
      <div class="timeline-grid">${cells}</div>
      <div class="status-actions" style="margin-top:16px">
        <button class="btn btn-filled" id="btn-import-jobs">Import jobs</button>
        <button class="btn btn-outlined" id="btn-sync">Sync all campaign days</button>
        <button class="btn btn-text" id="btn-add-inline2">Create single job</button>
      </div>
    </section>`;
}

async function loadComposer() {
  if (!S.activeWorkspaceId) {
    S.composerDays = [];
    render();
    return;
  }
  const r = await api(`/api/workspaces/${S.activeWorkspaceId}/campaign-plan`);
  S.composerDays = (r.days || []).slice().sort((a, b) => a.day - b.day);
  S.composerExpanded = {};
  render();
}

function beatsToText(beats) {
  return (beats || []).map(b => `${b.caption || ''} | ${b.icon || ''} | ${b.animation || ''}`).join('\n');
}

function textToBeats(text) {
  return (text || '').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const [caption = '', icon = '', animation = ''] = line.split('|').map(s => s.trim());
    return { caption, icon, animation };
  });
}

function composeCard(d) {
  const expanded = !!S.composerExpanded[d.day];
  return `<div class="compose-card" data-day-card="${d.day}">
    <div class="compose-card__row">
      <input type="number" class="compose-field compose-field--day" data-field="day" value="${d.day}" min="1" title="Day number"/>
      <input type="text" class="compose-field compose-field--title" data-field="title" value="${esc(d.title || '')}" placeholder="Title"/>
      <input type="text" class="compose-field" data-field="pillar" value="${esc(d.pillar || '')}" placeholder="Pillar"/>
      <input type="text" class="compose-field" data-field="cta" value="${esc(d.cta || '')}" placeholder="CTA"/>
      <button type="button" class="btn btn-text sm" data-toggle-more="${d.day}">${expanded ? 'Less ▴' : 'More ▾'}</button>
      <button type="button" class="btn btn-text sm" data-delete-day="${d.day}">Delete</button>
    </div>
    ${expanded ? `<div class="compose-card__more">
      <div class="field"><label>Duration target</label><input type="text" data-field="duration_target" value="${esc(d.duration_target || '')}" placeholder="44s · 4 beats"/></div>
      <div class="field"><label>VO script</label><textarea class="instr-editor" data-field="vo_script">${esc(d.vo_script || '')}</textarea></div>
      <div class="field"><label>Social post</label><textarea class="instr-editor" data-field="social_post">${esc(d.social_post || '')}</textarea></div>
      <div class="field"><label>Image prompt</label><textarea class="instr-editor" data-field="image_prompt">${esc(d.image_prompt || '')}</textarea></div>
      <div class="field"><label>Beats — one per line: caption | icon | animation</label><textarea class="instr-editor" data-field="beats">${esc(beatsToText(d.beats))}</textarea></div>
      <div class="field"><label>Creative (optional JSON)</label><textarea class="instr-editor" data-field="creative">${esc(d.creative ? JSON.stringify(d.creative, null, 2) : '')}</textarea></div>
    </div>` : ''}
  </div>`;
}

function renderCompose() {
  if (!S.activeWorkspaceId) return `${renderWorkspaceSwitcher()}<p class="empty">No workspace configured.</p>`;
  if (!S.composerDays) return `${renderWorkspaceSwitcher()}<p class="empty">Loading campaign plan…</p>`;
  const ws = activeWorkspace();
  const cardsHtml = S.composerDays.map(composeCard).join('')
    || '<p class="empty">No days yet. Add one below, or import a plan from Timeline → Import jobs.</p>';
  return `
    ${renderWorkspaceSwitcher()}
    <section class="section">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h2>Compose — ${esc(ws?.name || 'Campaign')}</h2>
        <div class="status-actions">
          <button class="btn btn-text" id="compose-add-day">Add day</button>
          <button class="btn btn-outlined" id="compose-save">Save all</button>
          <button class="btn btn-filled" id="compose-save-sync">Save &amp; sync to board</button>
        </div>
      </div>
      <p class="section-lead">Editing ${S.composerDays.length} day(s). Saving writes the campaign plan directly — nothing runs until you sync or the next scheduled run.
        <button class="btn btn-text sm" id="compose-install-cron" style="margin-left:8px">Enable daily automation</button>
      </p>
      <div class="compose-list">${cardsHtml}</div>
    </section>`;
}

// Merge current DOM edits back into S.composerDays without hard-failing on bad JSON —
// used before actions (add/delete/toggle) that re-render and would otherwise drop unsaved edits.
function syncComposerStateFromDom() {
  if (!S.composerDays) return;
  document.querySelectorAll('[data-day-card]').forEach(card => {
    const origDay = Number(card.dataset.dayCard);
    const idx = S.composerDays.findIndex(d => d.day === origDay);
    if (idx < 0) return;
    const field = (name) => card.querySelector(`[data-field="${name}"]`);
    const updated = { ...S.composerDays[idx] };
    if (field('day')) updated.day = Number(field('day').value) || updated.day;
    if (field('title')) updated.title = field('title').value;
    if (field('pillar')) updated.pillar = field('pillar').value;
    if (field('cta')) updated.cta = field('cta').value;
    if (field('duration_target')) updated.duration_target = field('duration_target').value;
    if (field('vo_script')) updated.vo_script = field('vo_script').value;
    if (field('social_post')) updated.social_post = field('social_post').value;
    if (field('image_prompt')) updated.image_prompt = field('image_prompt').value;
    if (field('beats')) updated.beats = textToBeats(field('beats').value);
    if (field('creative')) {
      const raw = field('creative').value.trim();
      if (raw) {
        try { updated.creative = JSON.parse(raw); } catch { /* leave previous value until Save validates */ }
      } else {
        delete updated.creative;
      }
    }
    S.composerDays[idx] = updated;
  });
}

// Strict read for Save — throws a day-specific error on invalid JSON instead of silently ignoring it.
function collectComposerDays() {
  const days = [];
  document.querySelectorAll('[data-day-card]').forEach(card => {
    const origDay = Number(card.dataset.dayCard);
    const original = (S.composerDays || []).find(d => d.day === origDay) || {};
    const expanded = !!S.composerExpanded[origDay];
    const field = (name) => card.querySelector(`[data-field="${name}"]`);
    const val = (name) => field(name)?.value ?? '';
    const entry = {
      day: Number(val('day')) || original.day,
      title: val('title').trim(),
      pillar: val('pillar').trim(),
      cta: val('cta').trim(),
    };
    if (expanded) {
      entry.duration_target = val('duration_target').trim();
      entry.vo_script = val('vo_script');
      entry.social_post = val('social_post');
      entry.image_prompt = val('image_prompt');
      entry.beats = textToBeats(val('beats'));
      const creativeRaw = val('creative').trim();
      if (creativeRaw) {
        try {
          entry.creative = JSON.parse(creativeRaw);
        } catch {
          throw new Error(`Day ${entry.day}: creative field is not valid JSON`);
        }
      }
    } else {
      if (original.duration_target != null) entry.duration_target = original.duration_target;
      if (original.vo_script != null) entry.vo_script = original.vo_script;
      if (original.social_post != null) entry.social_post = original.social_post;
      if (original.image_prompt != null) entry.image_prompt = original.image_prompt;
      if (original.beats != null) entry.beats = original.beats;
      if (original.creative != null) entry.creative = original.creative;
    }
    days.push(entry);
  });
  return days;
}

async function saveComposer(sync) {
  let days;
  try {
    days = collectComposerDays();
  } catch (e) {
    toast(e.message);
    return;
  }
  try {
    const r = await api(`/api/workspaces/${S.activeWorkspaceId}/campaign-plan`, { method: 'PUT', body: { days } });
    toast(`Saved ${r.count} day(s)`);
    if (sync) {
      const total = S.timeline?.totalDays || activeWorkspace()?.meta?.totalDays || 30;
      const sr = await api('/api/tasks/bulk', {
        method: 'POST',
        body: { mode: 'campaign', workspaceId: S.activeWorkspaceId, fromDay: 1, toDay: total },
      });
      toast(`Synced ${sr.synced || 0} job(s) to the board`);
    }
    await refresh();
  } catch (e) {
    if (e.errors?.length) toast(`${e.message}: ${e.errors.join('; ')}`);
    else toast(e.message);
  }
}

function openNewCampaignModal() {
  S.newCampaign = {
    name: '',
    targetPath: '',
    totalDays: 30,
    startDate: new Date().toISOString().slice(0, 10),
    timezone: S.meta?.scheduler?.defaultTimezone || 'America/Denver',
    dailyRunHour: 7,
    dailyRunMinute: 0,
    brandName: '',
    brandDomain: '',
  };
  document.getElementById('new-campaign-modal').classList.remove('hidden');
  renderNewCampaignModal();
}

function renderNewCampaignModal() {
  const c = S.newCampaign;
  const body = document.getElementById('new-campaign-body');
  body.innerHTML = `
    <p class="section-lead">Scaffolds a new autopilot pipeline (scripts, prompts, Remotion template) at the project path you give, ready to build day-by-day in Compose. Cron is <strong>not</strong> installed automatically — that's a separate step once you're happy with the plan.</p>
    <div class="field"><label>Campaign name</label><input id="nc-name" type="text" value="${esc(c.name)}" placeholder="My Product 30-Day Social"/></div>
    <div class="field"><label>Target project path</label>${pathFieldHTML({ id: 'nc-path', value: c.targetPath, placeholder: '/path/to/your/project', help: 'Creates <path>/marketing/autopilot/ — the path must already exist.' })}</div>
    <div class="import-range">
      <div class="field"><label>Brand name</label><input id="nc-brand-name" type="text" value="${esc(c.brandName)}" placeholder="Defaults to campaign name"/></div>
      <div class="field"><label>Brand domain</label><input id="nc-brand-domain" type="text" value="${esc(c.brandDomain)}" placeholder="yourbrand.com"/></div>
    </div>
    <p class="hint" style="margin-top:-8px;margin-bottom:16px">Fills in the cloned scripts/docs/prompts wherever they mention a brand name or domain — the deeper creative direction (positioning, VO copy, Remotion visuals) is still yours to write.</p>
    <div class="field"><label>Duration</label>
      <div class="mode-chips">
        <button type="button" class="mode-chip ${c.totalDays === 7 ? 'selected' : ''}" data-nc-duration="7">1 week</button>
        <button type="button" class="mode-chip ${c.totalDays === 30 ? 'selected' : ''}" data-nc-duration="30">1 month</button>
        <button type="button" class="mode-chip ${c.totalDays === 365 ? 'selected' : ''}" data-nc-duration="365">1 year</button>
      </div>
      <input id="nc-days" type="number" min="1" value="${c.totalDays}" style="margin-top:8px;max-width:120px"/>
    </div>
    <div class="import-range">
      <div class="field"><label>Start date</label><input id="nc-start" type="date" value="${c.startDate}"/></div>
      <div class="field"><label>Timezone</label><input id="nc-tz" type="text" value="${esc(c.timezone)}"/></div>
    </div>
    <div class="import-range">
      <div class="field"><label>Daily run hour</label><input id="nc-hour" type="number" min="0" max="23" value="${c.dailyRunHour}"/></div>
      <div class="field"><label>Minute</label><input id="nc-minute" type="number" min="0" max="59" value="${c.dailyRunMinute}"/></div>
    </div>`;

  body.querySelectorAll('[data-nc-duration]').forEach(btn => {
    btn.onclick = () => {
      document.getElementById('nc-days').value = btn.dataset.ncDuration;
      body.querySelectorAll('[data-nc-duration]').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    };
  });
  wirePathPickers(body);
}

async function submitNewCampaign() {
  const body = {
    name: document.getElementById('nc-name')?.value?.trim(),
    targetPath: document.getElementById('nc-path')?.value?.trim(),
    totalDays: Number(document.getElementById('nc-days')?.value) || 30,
    startDate: document.getElementById('nc-start')?.value,
    timezone: document.getElementById('nc-tz')?.value?.trim(),
    dailyRunHour: Number(document.getElementById('nc-hour')?.value) || 0,
    dailyRunMinute: Number(document.getElementById('nc-minute')?.value) || 0,
    brandName: document.getElementById('nc-brand-name')?.value?.trim(),
    brandDomain: document.getElementById('nc-brand-domain')?.value?.trim(),
  };
  if (!body.name || !body.targetPath || !body.startDate) {
    toast('Name, target path, and start date are required');
    return;
  }
  try {
    const r = await api('/api/campaigns', { method: 'POST', body });
    toast(`Created "${r.workspace.name}"`);
    closeModals();
    S.activeWorkspaceId = r.workspace.id;
    await refresh();
    setActiveTab('compose');
  } catch (e) {
    toast(e.message);
  }
}

function openImportModal(prefill = {}) {
  S.importMode = prefill.mode || 'campaign';
  S.importDayFrom = prefill.fromDay || 1;
  S.importDayTo = prefill.toDay || S.timeline?.totalDays || activeWorkspace()?.meta?.totalDays || 30;
  document.getElementById('import-modal').classList.remove('hidden');
  renderImportModal();
}

function activeWorkspace() {
  return S.meta?.workspaces?.find(w => w.id === S.activeWorkspaceId) || null;
}

function renderImportModal() {
  const ws = activeWorkspace();
  const total = S.timeline?.totalDays || ws?.meta?.totalDays || 30;
  const body = document.getElementById('import-modal-body');
  body.innerHTML = `
    <div class="instr-tabs">
      <button type="button" class="instr-tab ${S.importMode === 'campaign' ? 'active' : ''}" data-import-mode="campaign">Campaign days</button>
      <button type="button" class="instr-tab ${S.importMode === 'plan' ? 'active' : ''}" data-import-mode="plan">Full campaign plan</button>
      <button type="button" class="instr-tab ${S.importMode === 'json' ? 'active' : ''}" data-import-mode="json">JSON bulk</button>
    </div>
    ${S.importMode === 'campaign' ? `
      <p class="section-lead">Import jobs from your workspace campaign file. Each day becomes a scheduled job with scripts and copy pre-filled.</p>
      <div class="field"><label>Workspace</label><div class="preview-box">${esc(ws?.name || 'No workspace configured')}</div></div>
      <div class="import-range">
        <div class="field"><label>From day</label><input type="number" id="import-from" min="1" max="${total}" value="${S.importDayFrom}"/></div>
        <div class="field"><label>To day</label><input type="number" id="import-to" min="1" max="${total}" value="${S.importDayTo}"/></div>
      </div>
      <p class="hint">Existing jobs in this range are updated. New days are created. Nothing is duplicated.</p>
    ` : S.importMode === 'plan' ? `
      <p class="section-lead">Upload or paste a whole campaign plan (day, title, VO script, social post, image prompt, CTA, beats). This replaces <code>days.json</code> for <strong>${esc(ws?.name || 'this workspace')}</strong> — the previous file is backed up automatically.</p>
      <div class="settings-actions" style="margin-top:0;margin-bottom:12px">
        <button type="button" class="btn btn-outlined" id="btn-download-plan-template">Download template</button>
        <button type="button" class="btn btn-outlined" id="btn-upload-plan">Upload JSON file</button>
        <input type="file" id="import-plan-file" accept=".json,application/json" hidden/>
      </div>
      <textarea class="instr-editor" id="import-plan-json" placeholder="Paste a { days: [...] } campaign plan here, or upload a file you edited from the template."></textarea>
      <label class="field" style="flex-direction:row;align-items:center;gap:8px;margin-top:8px">
        <input type="checkbox" id="import-plan-sync" checked/> Sync to board after saving
      </label>
      <p class="hint">Each day needs a unique "day" number and a "title". Everything else is optional — leave blank for the agent to draft.</p>
    ` : `
      <p class="section-lead">Download the template for field reference, upload your edited file, or paste JSON below.</p>
      <div class="settings-actions" style="margin-top:0;margin-bottom:12px">
        <button type="button" class="btn btn-outlined" id="btn-download-template">Download template</button>
        <button type="button" class="btn btn-outlined" id="btn-upload-json">Upload JSON file</button>
        <input type="file" id="import-json-file" accept=".json,application/json" hidden/>
      </div>
      <textarea class="instr-editor" id="import-json" placeholder="Paste jobs JSON here, or upload a file you edited from the template."></textarea>
      <p class="hint">Each job needs templateId and title. Prefer short inputs + skills — agents scan the workspace and draft scripts. The _guide block is ignored on import.</p>
    `}`;

  body.querySelectorAll('[data-import-mode]').forEach(btn => {
    btn.onclick = () => {
      S.importMode = btn.dataset.importMode;
      renderImportModal();
    };
  });
  document.getElementById('btn-download-template')?.addEventListener('click', downloadImportTemplate);
  document.getElementById('btn-upload-json')?.addEventListener('click', () => {
    document.getElementById('import-json-file')?.click();
  });
  document.getElementById('import-json-file')?.addEventListener('change', handleImportFileUpload);
  document.getElementById('btn-download-plan-template')?.addEventListener('click', downloadCampaignPlanTemplate);
  document.getElementById('btn-upload-plan')?.addEventListener('click', () => {
    document.getElementById('import-plan-file')?.click();
  });
  document.getElementById('import-plan-file')?.addEventListener('change', handlePlanFileUpload);
}

function importTemplateUrl() {
  return S.meta?.importTemplateUrl || '/omnishpilot-import-template.json';
}

function downloadImportTemplate() {
  const url = importTemplateUrl();
  const a = document.createElement('a');
  a.href = url;
  a.download = 'omnishpilot-import-template.json';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Downloading template…');
}

async function handleImportFileUpload(ev) {
  const file = ev.target?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    JSON.parse(text);
    const el = document.getElementById('import-json');
    if (el) el.value = text;
    toast(`Loaded ${file.name} — review, then Import`);
  } catch {
    toast('That file is not valid JSON');
  } finally {
    ev.target.value = '';
  }
}

function campaignPlanTemplateUrl() {
  return S.meta?.campaignPlanTemplateUrl || '/omnishpilot-campaign-plan-template.json';
}

function downloadCampaignPlanTemplate() {
  const url = campaignPlanTemplateUrl();
  const a = document.createElement('a');
  a.href = url;
  a.download = 'omnishpilot-campaign-plan-template.json';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Downloading template…');
}

async function handlePlanFileUpload(ev) {
  const file = ev.target?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    JSON.parse(text);
    const el = document.getElementById('import-plan-json');
    if (el) el.value = text;
    toast(`Loaded ${file.name} — review, then Import`);
  } catch {
    toast('That file is not valid JSON');
  } finally {
    ev.target.value = '';
  }
}

async function submitImport() {
  try {
    if (S.importMode === 'campaign') {
      const fromDay = Number(document.getElementById('import-from')?.value || 1);
      const toDay = Number(document.getElementById('import-to')?.value || 30);
      if (fromDay > toDay) { toast('From day must be before to day'); return; }
      const r = await api('/api/tasks/bulk', {
        method: 'POST',
        body: {
          mode: 'campaign',
          workspaceId: S.activeWorkspaceId,
          fromDay,
          toDay,
        },
      });
      toast(`Imported ${r.synced || 0} campaign job(s)`);
    } else if (S.importMode === 'plan') {
      const raw = document.getElementById('import-plan-json')?.value?.trim();
      if (!raw) { toast('Upload a JSON file or paste a plan first'); return; }
      let parsed;
      try { parsed = JSON.parse(raw); } catch { toast('Invalid JSON'); return; }
      const days = Array.isArray(parsed) ? parsed : parsed.days;
      if (!Array.isArray(days) || !days.length) { toast('Need a days array or { "days": [...] }'); return; }
      const r = await api(`/api/workspaces/${S.activeWorkspaceId}/campaign-plan`, { method: 'PUT', body: { days } });
      toast(`Saved ${r.count} day(s) to the campaign plan`);
      if (document.getElementById('import-plan-sync')?.checked) {
        const total = S.timeline?.totalDays || activeWorkspace()?.meta?.totalDays || 30;
        const sr = await api('/api/tasks/bulk', {
          method: 'POST',
          body: { mode: 'campaign', workspaceId: S.activeWorkspaceId, fromDay: 1, toDay: total },
        });
        toast(`Synced ${sr.synced || 0} job(s) to the board`);
      }
    } else {
      const raw = document.getElementById('import-json')?.value?.trim();
      if (!raw) { toast('Upload a JSON file or paste jobs first'); return; }
      let parsed;
      try { parsed = JSON.parse(raw); } catch { toast('Invalid JSON'); return; }
      const list = Array.isArray(parsed)
        ? parsed
        : (parsed.jobs && Array.isArray(parsed.jobs) ? parsed.jobs : null);
      if (!list?.length) { toast('Need a jobs array or { "jobs": [...] }'); return; }
      const r = await api('/api/tasks/bulk', { method: 'POST', body: { jobs: list } });
      if (r.errors?.length) toast(`Created ${r.created}, ${r.errors.length} failed`);
      else toast(`Created ${r.created} job(s)`);
    }
    closeModals();
    await refresh();
  } catch (e) {
    if (e.errors?.length) toast(`${e.message}: ${e.errors.join('; ')}`);
    else toast(e.message);
  }
}

function calNowSecondsInTz(tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date())) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const h = Number(parts.hour === '24' ? 0 : parts.hour);
  const m = Number(parts.minute);
  const s = Number(parts.second || 0);
  return h * 3600 + m * 60 + s;
}

function calZonedRunAtIso(dateStr, secondsOfDay, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const hour = Math.floor(secondsOfDay / 3600);
  const minute = Math.floor((secondsOfDay % 3600) / 60);
  const second = secondsOfDay % 60;
  let t = Date.UTC(y, m - 1, d, hour, minute, second);
  for (let i = 0; i < 4; i++) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = {};
    for (const p of fmt.formatToParts(new Date(t))) {
      if (p.type !== 'literal') parts[p.type] = p.value;
    }
    const ph = Number(parts.hour === '24' ? 0 : parts.hour);
    const pm = Number(parts.minute);
    const ps = Number(parts.second || 0);
    const pd = Number(parts.day);
    const diffSec = (d - pd) * 86400 + (hour - ph) * 3600 + (minute - pm) * 60 + (second - ps);
    if (diffSec === 0) break;
    t += diffSec * 1000;
  }
  return new Date(t).toISOString();
}

function calStopNowTimer() {
  if (S.calNowTimer) {
    clearInterval(S.calNowTimer);
    S.calNowTimer = null;
  }
}

function calHideContextMenu() {
  document.getElementById('cal-context-menu')?.classList.add('hidden');
}

function calPositionNowLine(line, trackHeight, tz, isToday) {
  if (!line) return;
  if (!isToday) {
    line.classList.add('hidden');
    return;
  }
  const sec = calNowSecondsInTz(tz);
  const top = (sec / 86400) * trackHeight;
  line.style.top = `${top}px`;
  line.classList.remove('hidden');
  const label = line.querySelector('.cal-now-line__label');
  if (label) label.textContent = `Now · ${calFormatSecondsOfDay(sec)}`;
}

function calScrollToNow(scroller, trackHeight, tz) {
  const sec = calNowSecondsInTz(tz);
  const top = (sec / 86400) * trackHeight;
  scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 3);
}

function openCalendarQuickAdd(dateStr, seconds) {
  const tz = S.calendar?.timezone || S.meta?.scheduler?.defaultTimezone || 'America/Denver';
  const snapped = calSnapSeconds(seconds);
  const tpl = S.meta?.templates?.find(t => t.id === 'agent-task') || S.meta?.templates?.[0];
  S.calQuickAdd = {
    date: dateStr,
    seconds: snapped,
    timezone: tz,
    templateId: tpl?.id || null,
    runMode: tpl?.defaultRunMode || 'supervised',
    title: '',
  };
  calHideContextMenu();
  document.getElementById('cal-quick-add-modal')?.classList.remove('hidden');
  renderCalendarQuickAdd();
}

function renderCalendarQuickAdd() {
  const q = S.calQuickAdd;
  if (!q) return;
  const when = calFormatSecondsOfDay(q.seconds);
  const dateLabel = new Date(`${q.date}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
  document.getElementById('cal-quick-add-when').textContent =
    `${dateLabel} at ${when} (${q.timezone})`;
  document.getElementById('cal-quick-add-title-input').value = q.title;
  const sel = document.getElementById('cal-quick-add-template');
  if (sel) {
    sel.innerHTML = (S.meta?.templates || []).map(t =>
      `<option value="${t.id}" ${q.templateId === t.id ? 'selected' : ''}>${esc(t.name)}</option>`
    ).join('');
    sel.onchange = () => {
      const tpl = S.meta?.templates?.find(t => t.id === sel.value);
      if (tpl) {
        q.templateId = tpl.id;
        q.runMode = tpl.defaultRunMode || q.runMode;
        renderCalendarQuickAdd();
      }
    };
  }
  const modes = document.getElementById('cal-quick-add-modes');
  if (modes) {
    modes.innerHTML = (S.meta?.runModes || []).map(m => `
      <button type="button" class="mode-chip ${q.runMode === m.id ? 'selected' : ''}" data-cal-quick-mode="${m.id}">
        <strong>${esc(m.label)}</strong><span>${esc(m.description)}</span>
      </button>`).join('');
    modes.querySelectorAll('[data-cal-quick-mode]').forEach(btn => {
      btn.onclick = () => {
        q.runMode = btn.dataset.calQuickMode;
        modes.querySelectorAll('[data-cal-quick-mode]').forEach(b =>
          b.classList.toggle('selected', b.dataset.calQuickMode === q.runMode));
      };
    });
  }
}

async function submitCalendarQuickAdd() {
  const q = S.calQuickAdd;
  if (!q) return;
  const title = document.getElementById('cal-quick-add-title-input')?.value?.trim();
  if (!title) {
    toast('Enter a job title');
    return;
  }
  const templateId = document.getElementById('cal-quick-add-template')?.value || q.templateId;
  const tpl = S.meta?.templates?.find(t => t.id === templateId);
  if (!tpl) {
    toast('Pick a job type');
    return;
  }
  const runAt = calZonedRunAtIso(q.date, q.seconds, q.timezone);
  const inputs = { title };
  if (tpl.fields?.some(f => f.key === 'goal')) {
    inputs.goal = `Scheduled from calendar for ${calFormatSecondsOfDay(q.seconds)} on ${q.date}.`;
  }
  const instructions = buildInstructionsFromInputs(tpl, inputs);
  try {
    await api('/api/tasks', {
      method: 'POST',
      body: {
        templateId,
        title,
        inputs,
        instructions,
        runMode: q.runMode,
        schedule: { type: 'once', runAt, timezone: q.timezone },
        status: 'scheduled',
      },
    });
    toast(`Job scheduled for ${calFormatSecondsOfDay(q.seconds)}`);
    closeModals();
    S.calQuickAdd = null;
    await loadCalendar();
  } catch (e) {
    toast(e.message);
  }
}

function showCalendarContextMenu(clientX, clientY, dateStr, seconds, isToday) {
  const menu = document.getElementById('cal-context-menu');
  if (!menu) return;
  const snapped = calSnapSeconds(seconds);
  const timeLabel = calFormatSecondsOfDay(snapped);
  menu.innerHTML = `
    <button type="button" class="cal-context-menu__item" data-cal-action="add">
      <span class="cal-context-menu__icon" aria-hidden="true">+</span>
      Add job at ${esc(timeLabel)}
    </button>
    ${isToday ? `<button type="button" class="cal-context-menu__item" data-cal-action="now">
      <span class="cal-context-menu__icon" aria-hidden="true">◎</span>
      Jump to now
    </button>` : ''}`;
  menu.dataset.date = dateStr;
  menu.dataset.seconds = String(snapped);
  menu.classList.remove('hidden');
  requestAnimationFrame(() => {
    const pad = 8;
    const rect = menu.getBoundingClientRect();
    let left = clientX;
    let top = clientY;
    if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
    if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad;
    menu.style.left = `${Math.max(pad, left)}px`;
    menu.style.top = `${Math.max(pad, top)}px`;
  });
  menu.querySelector('[data-cal-action="add"]')?.addEventListener('click', () => {
    openCalendarQuickAdd(dateStr, snapped);
  });
  menu.querySelector('[data-cal-action="now"]')?.addEventListener('click', () => {
    calHideContextMenu();
    const scroller = document.getElementById('cal-day-scroller');
    const track = document.getElementById('cal-day-track');
    if (scroller && track) {
      calScrollToNow(scroller, Number(track.dataset.trackHeight) || track.offsetHeight,
        S.calendar?.timezone || 'America/Denver');
    }
  });
}

function showJobContextMenu(clientX, clientY, taskId, muted) {
  const menu = document.getElementById('cal-context-menu');
  if (!menu || !taskId) return;
  menu.innerHTML = `
    <button type="button" class="cal-context-menu__item" data-job-action="open">
      <span class="cal-context-menu__icon" aria-hidden="true">⤢</span>
      Open job
    </button>
    <button type="button" class="cal-context-menu__item" data-job-action="copy">
      <span class="cal-context-menu__icon" aria-hidden="true">⧉</span>
      Copy job
    </button>
    <button type="button" class="cal-context-menu__item" data-job-action="duplicate">
      <span class="cal-context-menu__icon" aria-hidden="true">⎘</span>
      Duplicate
    </button>
    <button type="button" class="cal-context-menu__item" data-job-action="mute">
      <span class="cal-context-menu__icon" aria-hidden="true">${muted ? '🔊' : '🔇'}</span>
      ${muted ? 'Unmute' : 'Mute'}
    </button>`;
  delete menu.dataset.date;
  delete menu.dataset.seconds;
  menu.classList.remove('hidden');
  requestAnimationFrame(() => {
    const pad = 8;
    const rect = menu.getBoundingClientRect();
    let left = clientX;
    let top = clientY;
    if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
    if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad;
    menu.style.left = `${Math.max(pad, left)}px`;
    menu.style.top = `${Math.max(pad, top)}px`;
  });
  menu.querySelector('[data-job-action="open"]')?.addEventListener('click', () => {
    calHideContextMenu();
    openTask(taskId);
  });
  menu.querySelector('[data-job-action="copy"]')?.addEventListener('click', () => copyJobToClipboard(taskId));
  menu.querySelector('[data-job-action="duplicate"]')?.addEventListener('click', () => duplicateJobFromMenu(taskId));
  menu.querySelector('[data-job-action="mute"]')?.addEventListener('click', () => toggleJobMute(taskId, muted));
}

async function copyJobToClipboard(taskId) {
  calHideContextMenu();
  try {
    const data = await api(`/api/tasks/${taskId}`);
    const t = data.task;
    S.jobClipboard = {
      templateId: t.templateId,
      title: t.title,
      summary: t.summary,
      runMode: t.runMode,
      inputs: { ...t.inputs },
      instructions: { ...t.instructions },
    };
    toast(`Copied "${t.title}" — paste it from New job`);
  } catch (e) {
    toast(e.message);
  }
}

async function duplicateJobFromMenu(taskId) {
  calHideContextMenu();
  try {
    await api(`/api/tasks/${taskId}/duplicate`, { method: 'POST' });
    toast('Duplicated. Edit it in Up next.');
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

async function toggleJobMute(taskId, muted) {
  calHideContextMenu();
  try {
    await api(`/api/tasks/${taskId}/${muted ? 'unmute' : 'mute'}`, { method: 'POST' });
    toast(muted ? 'Unmuted — back on schedule' : "Muted — it'll stay scheduled but won't run until unmuted");
    await refresh();
  } catch (e) {
    toast(e.message);
  }
}

function calEventClass(ev) {
  if (ev.kind === 'running' || ev.live) return 'running';
  if (ev.kind === 'scheduled') return ev.projected ? 'scheduled' : 'scheduled-once';
  if (ev.status === 'completed') return 'completed';
  if (ev.status === 'failed') return 'failed';
  return 'other';
}

function calHourLabel(hour) {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

const CAL_ZOOM = {
  hour: { id: 'hour', label: 'Hours', pxPerMinute: 1.6, snapSec: 300 },
  minute: { id: 'minute', label: 'Minutes', pxPerMinute: 10, snapSec: 60 },
  second: { id: 'second', label: 'Seconds', pxPerSecond: 3, snapSec: 15 },
};

function calTrackHeight(zoomId = S.calZoom) {
  const z = CAL_ZOOM[zoomId] || CAL_ZOOM.hour;
  if (z.pxPerSecond) return Math.round(86400 * z.pxPerSecond);
  return Math.round(1440 * z.pxPerMinute);
}

function calSnapSeconds(seconds, zoomId = S.calZoom) {
  const snap = CAL_ZOOM[zoomId]?.snapSec || 60;
  return Math.round(seconds / snap) * snap;
}

function calFormatSecondsOfDay(sec) {
  const clamped = Math.max(0, Math.min(86399, Math.round(sec)));
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const pad = n => String(n).padStart(2, '0');
  if (S.calZoom === 'second' || s > 0) return `${h12}:${pad(m)}:${pad(s)} ${ampm}`;
  return `${h12}:${pad(m)} ${ampm}`;
}

function calBuildGridLines(height, zoomId) {
  const z = CAL_ZOOM[zoomId] || CAL_ZOOM.hour;
  let lines = '';
  if (zoomId === 'second') {
    for (let sec = 0; sec < 86400; sec += 15) {
      const top = (sec / 86400) * height;
      const major = sec % 60 === 0;
      const hourMajor = sec % 3600 === 0;
      let lbl = '';
      if (hourMajor) lbl = calHourLabel(Math.floor(sec / 3600));
      else if (major) lbl = `:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
      lines += `<div class="cal-grid-line ${hourMajor ? 'major hour' : major ? 'major' : 'minor'}" style="top:${top}px"><span>${lbl}</span></div>`;
    }
  } else if (zoomId === 'minute') {
    for (let min = 0; min < 1440; min += 5) {
      const top = (min / 1440) * height;
      const major = min % 60 === 0;
      lines += `<div class="cal-grid-line ${major ? 'major hour' : 'minor'}" style="top:${top}px"><span>${major ? calHourLabel(Math.floor(min / 60)) : ''}</span></div>`;
    }
  } else {
    for (let h = 0; h < 24; h++) {
      const top = (h / 24) * height;
      lines += `<div class="cal-grid-line major hour" style="top:${top}px"><span>${calHourLabel(h)}</span></div>`;
      for (let q = 1; q < 4; q++) {
        const qTop = ((h * 60 + q * 15) / 1440) * height;
        lines += `<div class="cal-grid-line minor" style="top:${qTop}px"></div>`;
      }
    }
  }
  return lines;
}

function calEventTopPx(ev, height) {
  const sec = ev.secondsOfDay ?? ((ev.hour || 0) * 3600 + (ev.minute || 0) * 60);
  return (sec / 86400) * height;
}

function renderCalendarDayDetail(day) {
  if (!day) {
    return `<p class="section-lead cal-day-hint">Select a day to see every scheduled run by hour and minute.</p>`;
  }

  const zoomId = S.calZoom || 'hour';
  const height = calTrackHeight(zoomId);
  const grid = calBuildGridLines(height, zoomId);

  const bySlot = {};
  for (const ev of day.events) {
    const key = ev.secondsOfDay ?? ev.minutesOfDay ?? 0;
    if (!bySlot[key]) bySlot[key] = [];
    bySlot[key].push(ev);
  }

  const eventsHtml = day.events.map(ev => {
    const col = (bySlot[ev.secondsOfDay ?? ev.minutesOfDay ?? 0] || []).indexOf(ev);
    const cols = (bySlot[ev.secondsOfDay ?? ev.minutesOfDay ?? 0] || []).length;
    const top = calEventTopPx(ev, height);
    const widthPct = cols > 1 ? (100 / cols) - 1 : 100;
    const leftPct = cols > 1 ? col * (100 / cols) : 0;
    const drag = ev.draggable ? '1' : '0';
    return `<div class="cal-event ${calEventClass(ev)} ${ev.draggable ? 'is-draggable' : ''} ${ev.unqueued ? 'unqueued' : ''} ${ev.muted ? 'is-muted' : ''}" role="button" tabindex="0"
      style="top:${top}px;left:calc(${leftPct}% + 4px);width:calc(${widthPct}% - 8px)"
      data-cal-event="1"
      data-cal-draggable="${drag}"
      data-task="${ev.taskId}"
      data-at="${esc(ev.at)}"
      data-seconds="${ev.secondsOfDay ?? 0}"
      data-muted="${ev.muted ? '1' : '0'}"
      title="${esc(ev.title)} — ${esc(ev.label)}${ev.draggable ? ' · drag to reschedule' : ''}${ev.muted ? ' · muted' : ''}">
      <span class="cal-event__time">${esc(ev.label)}</span>
      <span class="cal-event__title">${esc(ev.title)}</span>
      <span class="cal-event__meta">${esc(ev.scheduleLabel || ev.kind)}${ev.unqueued ? ' · not queued' : ''}${ev.live ? ' · live' : ''}${ev.draggable ? ' · drag' : ''}${ev.muted ? ' · muted' : ''}</span>
    </div>`;
  }).join('');

  const list = day.events.map(ev => `
    <div class="cal-list-item ${calEventClass(ev)} ${ev.muted ? 'is-muted' : ''}" data-task="${ev.taskId}" data-muted="${ev.muted ? '1' : '0'}">
      <button type="button" class="cal-list-item__main" data-task="${ev.taskId}">
        <span class="cal-list-item__time">${esc(ev.label)}</span>
        <span class="cal-list-item__body">
          <strong>${esc(ev.title)}</strong>
          <span>${esc(ev.scheduleLabel || ev.kind)} · ${esc(STATUS_LABELS[ev.status] || ev.status)}${ev.muted ? ' · Muted' : ''}</span>
        </span>
      </button>
      <button type="button" class="cal-list-item__menu" data-job-menu="${ev.taskId}" data-muted="${ev.muted ? '1' : '0'}" aria-label="Job actions" title="Job actions">⋮</button>
    </div>`).join('');

  const zoomBtns = Object.values(CAL_ZOOM).map(z => `
    <button type="button" class="cal-zoom-btn ${zoomId === z.id ? 'active' : ''}" data-cal-zoom="${z.id}">${z.label}</button>
  `).join('');

  const tz = S.calendar?.timezone || S.meta?.scheduler?.defaultTimezone || 'America/Denver';
  const nowSec = day.isToday ? calNowSecondsInTz(tz) : null;
  const nowTop = nowSec != null ? (nowSec / 86400) * height : 0;

  const countLabel = day.total
    ? `${day.total} event${day.total === 1 ? '' : 's'}`
    : 'No events yet';
  const pillLabel = day.isToday ? `Today · ${countLabel}` : countLabel;

  return `
    <section class="cal-day-panel" id="cal-day-root" data-date="${day.date}" data-is-today="${day.isToday ? '1' : '0'}">
      <div class="cal-day-head">
        <h3>${new Date(day.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</h3>
        <span class="pill ${day.isToday ? 'live' : ''}">${pillLabel}</span>
      </div>
      <div class="cal-day-controls">
        <div class="cal-zoom-group" role="group" aria-label="Timeline zoom">${zoomBtns}</div>
        ${day.isToday ? '<button type="button" class="btn btn-tonal sm" id="cal-jump-now">Now</button>' : ''}
        <p class="cal-zoom-hint">Right-click or double-click the timeline to add a job · Drag jobs to reschedule · Right-click a job or its ⋮ menu to copy, duplicate, or mute · Ctrl+scroll to zoom</p>
      </div>
      <div class="cal-day-scroller" id="cal-day-scroller">
        <div class="cal-day-track" id="cal-day-track" style="height:${height}px" data-track-height="${height}" data-tz="${esc(tz)}">
          <div class="cal-grid-lines" aria-hidden="true">${grid}</div>
          <div class="cal-track-hit" id="cal-track-hit" aria-label="Day timeline — right-click to add a job"></div>
          <div class="cal-now-line ${day.isToday ? '' : 'hidden'}" id="cal-now-line" style="top:${nowTop}px" aria-hidden="true">
            <span class="cal-now-line__dot" aria-hidden="true"></span>
            <span class="cal-now-line__label">${day.isToday ? `Now · ${calFormatSecondsOfDay(nowSec)}` : 'Now'}</span>
          </div>
          <div class="cal-events-layer" id="cal-events-layer">${eventsHtml}</div>
        </div>
      </div>
      <div class="cal-drag-tooltip hidden" id="cal-drag-tooltip" aria-live="polite"></div>
      ${day.total ? `
        <details class="cal-list-fold">
          <summary>All events (${day.total})</summary>
          <div class="cal-list">${list}</div>
        </details>` : `<p class="empty cal-empty-hint">No jobs on this day yet — right-click the timeline above to schedule one.</p>`}
    </section>`;
}

function refreshCalendarDayPanel() {
  const root = document.getElementById('cal-day-root');
  if (!root || !S.calendar?.selectedDay) return;
  const scrollTop = document.getElementById('cal-day-scroller')?.scrollTop || 0;
  const wrapper = root.parentElement;
  const html = renderCalendarDayDetail(S.calendar.selectedDay);
  if (wrapper) {
    const temp = document.createElement('div');
    temp.innerHTML = html;
    root.replaceWith(temp.firstElementChild);
  }
  initCalendarDayTimeline(scrollTop);
}

function initCalendarDayTimeline(restoreScroll = null) {
  calStopNowTimer();
  const scroller = document.getElementById('cal-day-scroller');
  const track = document.getElementById('cal-day-track');
  const tooltip = document.getElementById('cal-drag-tooltip');
  const hitLayer = document.getElementById('cal-track-hit');
  const nowLine = document.getElementById('cal-now-line');
  if (!scroller || !track) return;

  const trackHeight = Number(track.dataset.trackHeight) || track.offsetHeight;
  const date = document.getElementById('cal-day-root')?.dataset.date;
  const isToday = document.getElementById('cal-day-root')?.dataset.isToday === '1';
  const tz = track.dataset.tz || S.calendar?.timezone || S.meta?.scheduler?.defaultTimezone || 'America/Denver';

  if (restoreScroll != null) scroller.scrollTop = restoreScroll;
  else if (S.calScrollTop != null) scroller.scrollTop = S.calScrollTop;
  else if (isToday) calScrollToNow(scroller, trackHeight, tz);

  calPositionNowLine(nowLine, trackHeight, tz, isToday);
  if (isToday) {
    const tickMs = S.calZoom === 'second' ? 1000 : S.calZoom === 'minute' ? 10000 : 60000;
    S.calNowTimer = setInterval(() => {
      const h = Number(document.getElementById('cal-day-track')?.dataset.trackHeight)
        || document.getElementById('cal-day-track')?.offsetHeight || trackHeight;
      calPositionNowLine(document.getElementById('cal-now-line'), h, tz, true);
    }, tickMs);
  }

  document.getElementById('cal-jump-now')?.addEventListener('click', () => {
    calScrollToNow(scroller, trackHeight, tz);
  });

  document.querySelectorAll('[data-cal-zoom]').forEach(btn => {
    btn.onclick = () => {
      S.calZoom = btn.dataset.calZoom;
      refreshCalendarDayPanel();
    };
  });

  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const levels = ['hour', 'minute', 'second'];
    const i = levels.indexOf(S.calZoom);
    if (e.deltaY < 0 && i < levels.length - 1) S.calZoom = levels[i + 1];
    else if (e.deltaY > 0 && i > 0) S.calZoom = levels[i - 1];
    S.calScrollTop = scroller.scrollTop;
    refreshCalendarDayPanel();
  }, { passive: false });

  scroller.addEventListener('scroll', () => {
    if (!S.calDrag) S.calScrollTop = scroller.scrollTop;
  });

  function showTooltip(text, clientX, clientY) {
    if (!tooltip) return;
    tooltip.textContent = text;
    tooltip.classList.remove('hidden');
    tooltip.style.position = 'fixed';
    tooltip.style.left = `${clientX}px`;
    tooltip.style.top = `${clientY - 32}px`;
    tooltip.style.transform = 'translateX(-50%)';
  }

  function hideTooltip() {
    tooltip?.classList.add('hidden');
  }

  function secondsFromClientY(clientY) {
    const trackRect = track.getBoundingClientRect();
    const y = clientY - trackRect.top;
    const ratio = Math.max(0, Math.min(1, y / trackHeight));
    return ratio * 86400;
  }

  function positionEvent(el, seconds) {
    const snapped = calSnapSeconds(seconds);
    const top = (snapped / 86400) * trackHeight;
    el.style.top = `${top}px`;
    return snapped;
  }

  const openAddAt = (clientX, clientY) => {
    if (!date) return;
    openCalendarQuickAdd(date, secondsFromClientY(clientY));
  };

  hitLayer?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!date) return;
    showCalendarContextMenu(e.clientX, e.clientY, date, secondsFromClientY(e.clientY), isToday);
  });

  hitLayer?.addEventListener('dblclick', (e) => {
    e.preventDefault();
    openAddAt(e.clientX, e.clientY);
  });

  let drag = null;

  track.querySelectorAll('[data-cal-draggable="1"]').forEach(el => {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      drag = {
        el,
        taskId: el.dataset.task,
        at: el.dataset.at,
        pointerId: e.pointerId,
        startY: e.clientY,
        startTop: parseFloat(el.style.top) || 0,
        moved: false,
      };
      el.setPointerCapture(e.pointerId);
      el.classList.add('is-dragging');
      track.classList.add('is-dragging');
    });
  });

  track.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dy) > 3) drag.moved = true;
    let top = drag.startTop + dy;
    top = Math.max(0, Math.min(trackHeight - 4, top));
    drag.el.style.top = `${top}px`;
    const sec = (top / trackHeight) * 86400;
    showTooltip(calFormatSecondsOfDay(sec), e.clientX, e.clientY);
  });

  track.addEventListener('pointerup', async (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { el, taskId, moved } = drag;
    el.releasePointerCapture(e.pointerId);
    el.classList.remove('is-dragging');
    track.classList.remove('is-dragging');
    hideTooltip();

    if (!moved) {
      drag = null;
      openTask(taskId);
      return;
    }

    const top = parseFloat(el.style.top) || 0;
    const rawSec = (top / trackHeight) * 86400;
    const snapped = calSnapSeconds(rawSec);
    positionEvent(el, snapped);

    const h = Math.floor(snapped / 3600);
    const m = Math.floor((snapped % 3600) / 60);
    const s = snapped % 60;

    drag = null;
    el.classList.add('is-saving');
    try {
      await api('/api/calendar/reschedule', {
        method: 'PATCH',
        body: { taskId, date, hour: h, minute: m, second: s },
      });
      toast(`Rescheduled to ${calFormatSecondsOfDay(snapped)}`);
      S.calScrollTop = scroller.scrollTop;
      await loadCalendar();
    } catch (err) {
      toast(err.message);
      await loadCalendar();
    } finally {
      el.classList.remove('is-saving');
    }
  });

  track.addEventListener('pointercancel', () => {
    if (!drag) return;
    drag.el.classList.remove('is-dragging');
    track.classList.remove('is-dragging');
    hideTooltip();
    drag = null;
    refreshCalendarDayPanel();
  });

  track.querySelectorAll('[data-cal-event][data-cal-draggable="0"]').forEach(el => {
    el.addEventListener('click', () => openTask(el.dataset.task));
  });

  track.querySelectorAll('[data-cal-event]').forEach(el => {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showJobContextMenu(e.clientX, e.clientY, el.dataset.task, el.dataset.muted === '1');
    });
  });

  document.querySelectorAll('.cal-list-item').forEach(el => {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showJobContextMenu(e.clientX, e.clientY, el.dataset.task, el.dataset.muted === '1');
    });
  });

  document.querySelectorAll('[data-job-menu]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = btn.getBoundingClientRect();
      showJobContextMenu(rect.left, rect.bottom + 4, btn.dataset.jobMenu, btn.dataset.muted === '1');
    });
  });
}

function renderCalendar() {
  const cal = S.calendar;
  if (!cal) return '<p class="empty">Loading calendar…</p>';

  const cells = cal.grid.map(cell => {
    const counts = cell.counts || {};
    const dots = [];
    if (counts.scheduled) dots.push(`<span class="cal-dot scheduled" title="${counts.scheduled} scheduled"></span>`);
    if (counts.running) dots.push(`<span class="cal-dot running" title="${counts.running} running"></span>`);
    if (counts.completed) dots.push(`<span class="cal-dot completed" title="${counts.completed} done"></span>`);
    if (counts.failed) dots.push(`<span class="cal-dot failed" title="${counts.failed} failed"></span>`);
    const selected = S.calDay === cell.day && cell.inMonth;
    return `<button type="button" class="cal-cell ${cell.inMonth ? '' : 'other-month'} ${cell.isToday ? 'today' : ''} ${selected ? 'selected' : ''} ${cell.hasEvents ? 'has-events' : ''}"
      data-cal-day="${cell.inMonth ? cell.day : ''}" data-cal-date="${cell.date}" ${cell.inMonth ? '' : 'disabled'}>
      <span class="cal-cell__num">${cell.day}</span>
      <span class="cal-cell__dots">${dots.join('')}</span>
      ${cell.total ? `<span class="cal-cell__count">${cell.total}</span>` : ''}
    </button>`;
  }).join('');

  return `
    <section class="section cal-shell">
      <div class="cal-toolbar">
        <button type="button" class="btn btn-outlined sm" id="cal-prev" aria-label="Previous month">‹</button>
        <div class="cal-toolbar__title">
          <h2>${esc(cal.monthName)} ${cal.year}</h2>
          <p class="section-lead">${esc(cal.timezone)} · ${cal.stats.monthEvents} events this month</p>
        </div>
        <button type="button" class="btn btn-outlined sm" id="cal-next" aria-label="Next month">›</button>
        <button type="button" class="btn btn-tonal sm" id="cal-today">Today</button>
      </div>
      <div class="cal-weekdays">${cal.weekdayLabels.map(d => `<span>${d}</span>`).join('')}</div>
      <div class="cal-grid" role="grid" aria-label="Month calendar">${cells}</div>
      <div class="cal-legend">
        <span><i class="cal-dot scheduled"></i> Scheduled</span>
        <span><i class="cal-dot running"></i> Running</span>
        <span><i class="cal-dot completed"></i> Done</span>
        <span><i class="cal-dot failed"></i> Failed</span>
      </div>
      ${renderCalendarDayDetail(cal.selectedDay)}
    </section>`;
}

async function loadCalendar(opts = {}) {
  const now = new Date();
  if (opts.year != null) S.calYear = opts.year;
  if (opts.month != null) S.calMonth = opts.month;
  if (opts.day !== undefined) S.calDay = opts.day;
  if (S.calYear == null) S.calYear = now.getFullYear();
  if (S.calMonth == null) S.calMonth = now.getMonth() + 1;
  if (S.calDay == null && opts.day === undefined
    && S.calYear === now.getFullYear() && S.calMonth === now.getMonth() + 1) {
    S.calDay = now.getDate();
  }
  const q = new URLSearchParams({ year: S.calYear, month: S.calMonth });
  if (S.calDay != null) q.set('day', S.calDay);
  S.calendar = await api(`/api/calendar?${q}`);
  render();
}

function renderSettings() {
  const s = S.meta?.settings || {};
  const modes = S.meta?.deliveryModes || [];
  const deliveryMode = s.deliveryMode || 'summary';
  return `
    <section class="section">
      <h2>Notifications</h2>
      <p class="section-lead">Omnish sends these to your phone when jobs change state.</p>
      <div class="settings-card"><label><input type="checkbox" id="set-start" ${s.notifyOnStart ? 'checked' : ''}/> Job started</label></div>
      <div class="settings-card"><label><input type="checkbox" id="set-done" ${s.notifyOnComplete ? 'checked' : ''}/> Job finished</label></div>
      <div class="settings-card"><label><input type="checkbox" id="set-fail" ${s.notifyOnFail ? 'checked' : ''}/> Job failed</label></div>
      <div class="settings-card"><label><input type="checkbox" id="set-sup" ${s.supervisorEnabled ? 'checked' : ''}/> Supervisor watches running jobs</label></div>
      <div class="settings-actions">
        <button class="btn btn-outlined" id="btn-test-notify">Test notification</button>
      </div>
    </section>
    <section class="section">
      <h2>Delivery</h2>
      <p class="section-lead">When enabled, Omnish sends the finished work using the method below instead of a generic finish notice.</p>
      <div class="settings-card"><label><input type="checkbox" id="set-delivery" ${s.deliveryOnComplete ? 'checked' : ''}/> Deliver results when a job finishes</label></div>
      <div class="settings-card settings-card--stacked">
        <label for="set-delivery-mode">How to deliver</label>
        <select id="set-delivery-mode">
          ${modes.map(m => `<option value="${m.id}" ${deliveryMode === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}
        </select>
        <p class="hint">${esc(modes.find(m => m.id === deliveryMode)?.description || '')}</p>
      </div>
      <div class="settings-card settings-card--stacked">
        <label for="set-delivery-peer">Omnish recipient (optional)</label>
        <input type="text" id="set-delivery-peer" placeholder="* for all peers, or +15551234567" value="${esc(s.deliveryPeer || '')}"/>
        <p class="hint">Leave blank to use the default from omnishpilot.config.json.</p>
      </div>
      <div class="settings-card settings-card--stacked" id="delivery-link-wrap" ${deliveryMode !== 'link' ? 'hidden' : ''}>
        <label for="set-public-url">Public link base URL</label>
        <input type="text" id="set-public-url" placeholder="https://omnishpilot.eligapris.tech" value="${esc(s.publicUrl || '')}"/>
        <p class="hint">Used when delivery mode is Message + link.</p>
      </div>
      <div class="settings-actions">
        <button class="btn btn-outlined" id="btn-test-delivery">Test delivery</button>
      </div>
    </section>
    <section class="section">
      <h2>Workspaces</h2>
      <p class="section-lead">Each workspace is a project folder OmnishPilot can read and run jobs against.</p>
      ${(S.meta?.workspaces || []).map(w => `
        <div class="task-card" style="cursor:default;margin-bottom:8px">
          <div class="task-card__body">
            <div style="width:100%">
              <div class="task-title">${esc(w.name)}</div>
              ${w.description ? `<div class="task-sub">${esc(w.description)}</div>` : ''}
              <div style="margin-top:6px">${pathFieldHTML({ dataField: `ws-path-${esc(w.id)}`, value: w.rootPath, browse: false, readonly: true })}</div>
            </div>
          </div>
        </div>`).join('')}
      <p class="section-lead" style="margin-top:12px">Add workspaces in <code>omnishpilot.config.json</code>.</p>
      <div class="settings-actions" style="margin-top:16px">
        <button type="button" class="btn btn-outlined" id="btn-sign-out">Sign out</button>
      </div>
    </section>`;
}

function render() {
  const main = document.getElementById('main');
  if (S.tab === 'home') main.innerHTML = renderHome();
  else if (S.tab === 'calendar') main.innerHTML = renderCalendar();
  else if (S.tab === 'timeline') main.innerHTML = renderTimeline();
  else if (S.tab === 'compose') main.innerHTML = renderCompose();
  else if (S.tab === 'settings') main.innerHTML = renderSettings();
  bindMain();
}

function renderScheduleFields(schedule, prefix = 'w') {
  const type = normalizeScheduleType(schedule.type);
  const tz = S.meta?.scheduler?.defaultTimezone || 'America/Denver';
  const minInt = S.meta?.scheduler?.minIntervalMinutes || 5;
  const p = id => `${prefix}-${id}`;
  let fields = `<p class="hint" style="margin-bottom:.75rem">Times use ${esc(tz)}</p>`;
  if (type === 'once') {
    fields += `<div class="field"><label>Date & time</label><input type="datetime-local" id="${p('datetime')}" value="${esc(toLocalDatetime(schedule.runAt))}"/></div>`;
  }
  if (type === 'interval') {
    fields += `<div class="field"><label>Every how many minutes?</label><input type="number" id="${p('interval')}" min="${minInt}" value="${schedule.intervalMinutes || 30}"/><div class="hint">Minimum ${minInt} minutes</div></div>`;
  }
  if (type === 'hourly') {
    fields += `<div class="field"><label>At minute past the hour</label><input type="number" id="${p('minute')}" min="0" max="59" value="${schedule.minute ?? 0}"/></div>`;
  }
  if (type === 'daily') {
    fields += `<div class="field"><label>Time</label><input type="time" id="${p('time')}" value="${timeValue(schedule.hour ?? 9, schedule.minute)}"/></div>`;
  }
  if (type === 'weekly') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    fields += `<div class="field"><label>Day of week</label><select id="${p('dow')}">${days.map((d, i) => `<option value="${i}" ${(schedule.dayOfWeek ?? 1) === i ? 'selected' : ''}>${d}</option>`).join('')}</select></div>`;
    fields += `<div class="field"><label>Time</label><input type="time" id="${p('time')}" value="${timeValue(schedule.hour ?? 9, schedule.minute)}"/></div>`;
  }
  if (type === 'monthly') {
    fields += `<div class="field"><label>Day of month</label><input type="number" id="${p('dom')}" min="1" max="31" value="${schedule.dayOfMonth || 1}"/></div>`;
    fields += `<div class="field"><label>Time</label><input type="time" id="${p('time')}" value="${timeValue(schedule.hour ?? 9, schedule.minute)}"/></div>`;
  }
  if (type === 'campaign_day') {
    fields += `<div class="field"><label>Campaign day number</label><input type="number" id="${p('campaign-day')}" min="1" value="${schedule.campaignDay || 1}"/></div>`;
  }
  return fields;
}

function readScheduleFields(schedule, prefix = 'w') {
  const p = id => `${prefix}-${id}`;
  const type = normalizeScheduleType(schedule.type);
  schedule.type = type;
  schedule.timezone = S.meta?.scheduler?.defaultTimezone || 'America/Denver';
  if (type === 'once') {
    const dt = document.getElementById(p('datetime'))?.value;
    if (dt) schedule.runAt = new Date(dt).toISOString();
  }
  if (type === 'interval') schedule.intervalMinutes = Number(document.getElementById(p('interval'))?.value || 30);
  if (type === 'hourly') schedule.minute = Number(document.getElementById(p('minute'))?.value || 0);
  if (type === 'daily') {
    const t = document.getElementById(p('time'))?.value || '09:00';
    const [h, m] = t.split(':');
    schedule.hour = Number(h);
    schedule.minute = Number(m);
  }
  if (type === 'weekly') {
    schedule.dayOfWeek = Number(document.getElementById(p('dow'))?.value ?? 1);
    const t = document.getElementById(p('time'))?.value || '09:00';
    const [h, m] = t.split(':');
    schedule.hour = Number(h);
    schedule.minute = Number(m);
  }
  if (type === 'monthly') {
    schedule.dayOfMonth = Number(document.getElementById(p('dom'))?.value || 1);
    const t = document.getElementById(p('time'))?.value || '09:00';
    const [h, m] = t.split(':');
    schedule.hour = Number(h);
    schedule.minute = Number(m);
  }
  if (type === 'campaign_day') {
    schedule.campaignDay = Number(document.getElementById(p('campaign-day'))?.value || schedule.campaignDay || 1);
  }
  return schedule;
}

function renderTaskScheduleEditor(t) {
  const sched = { ...t.schedule };
  const type = normalizeScheduleType(sched.type);
  return `
    <div class="field" style="margin-top:.75rem">
      <label>Schedule</label>
      <select id="task-schedule-type">
        ${(S.meta?.scheduleTypes || []).map(s => `<option value="${s.id}" ${type === normalizeScheduleType(s.id) ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
      </select>
      <div id="task-schedule-fields" style="margin-top:.5rem">${renderScheduleFields(sched, 'task-w')}</div>
      ${sched.runAt ? `<p class="hint" style="margin-top:.35rem">Next run: ${new Date(sched.runAt).toLocaleString()}</p>` : ''}
      ${t.execution?.runCount ? `<p class="hint">Completed runs: ${t.execution.runCount}</p>` : ''}
      <button class="btn btn-outlined sm" type="button" id="task-save-schedule" style="margin-top:.5rem">Save schedule</button>
    </div>`;
}

const WIZARD_STEPS = ['Job type', 'Details', 'Schedule', 'Instructions'];

function wizardLastStep(w) {
  const tpl = (S.meta?.templates || []).find(t => t.id === w.templateId);
  return (tpl?.instructionSections?.length) ? 3 : 2;
}

function isShellTemplate(templateId) {
  return templateId === 'shell-command';
}

async function ensureWizardSuggestions(templateId) {
  const w = S.wizard;
  if (!templateId || w.suggestionsTemplateId === templateId) return;
  try {
    w.suggestions = await api(`/api/suggestions?templateId=${encodeURIComponent(templateId)}`);
  } catch {
    w.suggestions = null;
  }
  w.suggestionsTemplateId = templateId;
}

function openWizard(seed, origin) {
  S.wizard = seed
    ? { step: 0, templateId: seed.templateId || null, inputs: { ...seed.inputs }, runMode: seed.runMode || 'supervised', runModeOpen: false, advancedOpen: false, schedule: { ...seed.schedule }, instructions: { ...(seed.instructions || {}) } }
    : { step: 0, templateId: null, inputs: {}, runMode: 'supervised', runModeOpen: false, advancedOpen: false, schedule: { type: 'manual' }, instructions: {} };
  // A fresh, unseeded wizard is the only case where we auto-apply Frecency-Slot suggestions —
  // a seeded wizard (quick-add spec, pasted clipboard, macro suggestion) already carries
  // concrete values the user (or another suggester) already chose, so we don't second-guess it.
  S.wizard.freshWizard = !seed;
  S.wizard.suggestions = null;
  S.wizard.suggestionsTemplateId = null;
  S.wizard.quickAddOrigin = origin ? { ...origin, proposedSpec: seed } : null;
  S.instrTab = null;
  document.getElementById('wizard-modal').classList.remove('hidden');
  renderWizard();
}

function closeModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  calHideContextMenu();
  S.calQuickAdd = null;
}

function renderWizard() {
  const w = S.wizard;
  const lastStep = wizardLastStep(w);
  if (w.step > lastStep) w.step = lastStep;
  const stepLabels = WIZARD_STEPS.slice(0, lastStep + 1);
  document.getElementById('wizard-title').textContent = stepLabels[w.step] || 'New job';
  document.getElementById('wizard-steps').innerHTML = stepLabels.map((_, i) =>
    `<div class="wstep ${i < w.step ? 'done' : ''} ${i === w.step ? 'active' : ''}"></div>`
  ).join('');
  document.getElementById('wizard-back').hidden = w.step === 0;
  document.getElementById('wizard-next').textContent = w.step === lastStep ? 'Create job' : 'Continue';

  const body = document.getElementById('wizard-body');
  if (w.step === 0) {
    const clip = S.jobClipboard;
    body.innerHTML = `
      ${clip ? `
        <div class="paste-bar">
          <span>Clipboard: <strong>${esc(clip.title || 'Copied job')}</strong></span>
          <div class="paste-bar__actions">
            <button type="button" class="btn btn-tonal sm" id="wizard-paste">Paste into this job</button>
            <button type="button" class="btn btn-text sm" id="wizard-paste-clear">Clear</button>
          </div>
        </div>` : ''}
      <p class="section-lead">Pick a job type — agent work, or a plain terminal command/script with no AI.</p>
      <div class="template-grid">
        ${(S.meta?.templates || []).map(t => `
          <button type="button" class="template-card ${w.templateId === t.id ? 'selected' : ''}" data-template="${t.id}">
            <div class="icon">${t.icon}</div>
            <strong>${esc(t.name)}</strong>
            <p>${esc(t.description)}</p>
          </button>`).join('')}
      </div>`;
    document.getElementById('wizard-paste')?.addEventListener('click', () => {
      const c = S.jobClipboard;
      if (!c) return;
      w.templateId = c.templateId;
      w.inputs = { ...c.inputs, title: c.title ? `${c.title} (copy)` : c.inputs?.title };
      w.runMode = c.runMode || w.runMode;
      w.instructions = { ...c.instructions };
      w.schedule = { type: 'manual' };
      S.instrTab = null;
      toast('Pasted job details');
      w.step = 1;
      renderWizard();
    });
    document.getElementById('wizard-paste-clear')?.addEventListener('click', () => {
      S.jobClipboard = null;
      renderWizard();
    });
  } else if (w.step === 1) {
    const tpl = S.meta.templates.find(t => t.id === w.templateId);
    const hasAgent = tpl.fields.some(f => f.type === 'agent-select');
    // Auto-apply (not just hint) the Frecency-Slot suggestion for low-stakes, instantly-
    // editable fields — which CLI runs it, which folder it scans — on a fresh wizard only.
    // Schedule stays hands-off (see suggestion-chip below step 2): a wrong recurring-schedule
    // guess is a much bigger surprise than a wrong agent pick.
    const suggestionChip = (f) => {
      if (!w.freshWizard || !w.suggestions || w.inputs[f.key]) return '';
      if (f.type === 'agent-select' && w.suggestions.agentId) {
        w.inputs[f.key] = w.suggestions.agentId.value;
        const label = agentDefaults(w.suggestions.agentId.value).label || w.suggestions.agentId.value;
        return `<div class="suggestion-chip">💡 ${esc(label)} — used ${w.suggestions.agentId.count}× recently</div>`;
      }
      if (f.type === 'path' && f.key === 'workspace' && w.suggestions.workspacePath) {
        w.inputs[f.key] = w.suggestions.workspacePath.value;
        return `<div class="suggestion-chip">💡 Reused from last time — edit to change</div>`;
      }
      return '';
    };
    const fieldHTML = (f) => {
      const chip = suggestionChip(f);
      return `
      <div class="field">
        <label>${esc(f.label)}${f.required ? ' *' : ''}</label>
        ${f.type === 'textarea' ? `<textarea data-field="${f.key}" placeholder="${esc(f.placeholder || '')}">${esc(w.inputs[f.key] || '')}</textarea>`
          : f.type === 'agent-select' ? renderAgentSelect(f.key, w.inputs[f.key])
          : f.type === 'select' ? `<select data-field="${f.key}">${(f.options || []).map(o => `<option value="${o}" ${w.inputs[f.key] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
          : f.type === 'path' ? pathFieldHTML({ dataField: f.key, value: w.inputs[f.key], placeholder: f.placeholder })
          : `<input data-field="${f.key}" type="${f.type || 'text'}" value="${esc(w.inputs[f.key] || '')}" placeholder="${esc(f.placeholder || '')}"/>`}
        ${f.help ? `<div class="hint">${esc(f.help)}</div>` : ''}
        ${chip}
      </div>`;
    };
    const mainFields = tpl.fields.filter(f => !f.advanced);
    const advancedFields = tpl.fields.filter(f => f.advanced);
    const advancedAgentBlock = hasAgent ? `
      <div class="field">
        <label>Command template</label>
        <textarea data-field="commandTemplate" id="w-command-template" style="min-height:56px" placeholder="${esc(agentDefaults(w.inputs.agentId).commandTemplate || '')}">${esc(w.inputs.commandTemplate || '')}</textarea>
        <div class="hint">Placeholders: {BIN} {WORKSPACE} {MODEL} {PROMPT}. Leave blank to use the agent's default shown above.</div>
      </div>
      <label class="field" style="flex-direction:row;align-items:center;gap:8px">
        <input type="checkbox" data-field="flattenPrompt" id="w-flatten-prompt" ${(w.inputs.flattenPrompt ?? agentDefaults(w.inputs.agentId).flattenPrompt) ? 'checked' : ''}/> Flatten prompt to a single line
      </label>
      <div class="status-actions" style="margin-bottom:12px">
        <button type="button" class="btn btn-text" id="w-preview-command">Preview command</button>
      </div>
      <pre class="log-box" id="w-command-preview" style="display:none;white-space:pre-wrap;word-break:break-all"></pre>
    ` : '';
    body.innerHTML = mainFields.map(fieldHTML).join('') + ((advancedFields.length || hasAgent) ? `
      <div class="advanced-toggle">
        <button type="button" class="btn btn-text sm" id="w-advanced-toggle">${w.advancedOpen ? 'Hide advanced settings' : 'Advanced settings (optional)'}</button>
      </div>
      <div class="advanced-panel${w.advancedOpen ? '' : ' hidden'}">
        ${advancedFields.map(fieldHTML).join('')}
        ${advancedAgentBlock}
      </div>` : '');
  } else if (w.step === 2) {
    // Schedule is deliberate user intent, not an incidental default — so unlike agent/path
    // above, we only ever hint at the usual choice and let the user opt in with one click.
    const schedSuggestion = (w.freshWizard && w.suggestions?.scheduleType) ? w.suggestions.scheduleType : null;
    const schedSuggestionLabel = schedSuggestion
      ? (S.meta?.scheduleTypes || []).find(s => s.id === schedSuggestion.value)?.label
      : null;
    const showSchedHint = schedSuggestionLabel && normalizeScheduleType(w.schedule.type) !== normalizeScheduleType(schedSuggestion.value);
    const shellJob = isShellTemplate(w.templateId);
    if (shellJob) w.runMode = 'manual';
    const modeBlock = shellJob ? `
      <div class="mode-summary">
        <strong>Terminal only</strong>
        <span>Runs your command directly — no agent, no prompts.</span>
      </div>` : `
      <div class="field"><label>How should it run?</label></div>
      ${w.runModeOpen ? `
        <div class="mode-chips">
          ${(S.meta?.runModes || []).map(m => `
            <button type="button" class="mode-chip ${w.runMode === m.id ? 'selected' : ''}" data-mode="${m.id}">
              <strong>${esc(m.label)}</strong><span>${esc(m.description)}</span>
            </button>`).join('')}
        </div>
        <button type="button" class="btn btn-text sm" id="w-mode-collapse">Hide options</button>
      ` : (() => {
        const current = (S.meta?.runModes || []).find(m => m.id === w.runMode);
        return `
          <div class="mode-summary">
            <strong>${esc(current?.label || 'Recommended for this job')}</strong>
            <span>${esc(current?.description || '')}</span>
          </div>
          <button type="button" class="btn btn-text sm" id="w-mode-expand">Change how it runs</button>`;
      })()}`;
    body.innerHTML = `
      <div class="field"><label>When should this run?</label>
        <select id="w-schedule">
          ${(S.meta?.scheduleTypes || []).map(s => `<option value="${s.id}" ${normalizeScheduleType(w.schedule.type) === normalizeScheduleType(s.id) ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
        </select>
        ${showSchedHint ? `<div class="suggestion-chip">💡 Usually "${esc(schedSuggestionLabel)}" for this job (${schedSuggestion.count}×) <button type="button" class="btn btn-text sm" id="w-schedule-suggest-apply">Use it</button></div>` : ''}
      </div>
      <div id="w-schedule-fields">${renderScheduleFields(w.schedule)}</div>
      ${modeBlock}`;
  } else if (w.step === 3) {
    const tpl = S.meta.templates.find(t => t.id === w.templateId);
    if (!Object.keys(w.instructions).length) {
      w.instructions = buildInstructionsFromInputs(tpl, w.inputs, w.freshWizard ? w.suggestions?.instructions : null);
    }
    const keys = tpl.instructionSections.map(s => s.key);
    if (!keys.includes(S.instrTab)) S.instrTab = keys[0];
    const activeSkeleton = w.freshWizard ? w.suggestions?.instructions?.[S.instrTab] : null;
    const wasAutoFilled = activeSkeleton && w.instructions[S.instrTab] === activeSkeleton.text;
    body.innerHTML = `
      <p class="section-lead" style="margin-bottom:12px">Edit what the agent follows. You can change this any time before the job runs.</p>
      <div class="instr-tabs">${tpl.instructionSections.map(s =>
        `<button type="button" class="instr-tab ${S.instrTab === s.key ? 'active' : ''}" data-instr="${s.key}">${esc(s.label)}</button>`
      ).join('')}</div>
      <div class="field">
        <div class="hint" style="margin-bottom:.35rem">${esc(tpl.instructionSections.find(s => s.key === S.instrTab)?.help || '')}</div>
        <textarea class="instr-editor" id="instr-editor">${esc(w.instructions[S.instrTab] || '')}</textarea>
        ${wasAutoFilled ? `<div class="suggestion-chip">💡 Auto-filled from your last ${activeSkeleton.sampleCount} uses — replace the {{slot_n}} parts, or edit freely</div>` : ''}
      </div>
      <div class="field"><label>Preview title</label><div class="preview-box">${esc(w.inputs.title || tpl.name)}</div></div>`;
  }

  body.querySelectorAll('[data-template]').forEach(btn => {
    btn.onclick = async () => {
      w.templateId = btn.dataset.template;
      const tpl = S.meta.templates.find(t => t.id === w.templateId);
      w.runMode = tpl?.defaultRunMode || w.runMode;
      body.querySelectorAll('.template-card').forEach(c => c.classList.remove('selected'));
      btn.classList.add('selected');
      if (w.freshWizard) await ensureWizardSuggestions(w.templateId);
    };
  });
  body.querySelectorAll('[data-mode]').forEach(btn => {
    btn.onclick = () => { w.runMode = btn.dataset.mode; body.querySelectorAll('.mode-chip').forEach(c => c.classList.remove('selected')); btn.classList.add('selected'); };
  });
  document.getElementById('w-mode-expand')?.addEventListener('click', () => { w.runModeOpen = true; renderWizard(); });
  document.getElementById('w-mode-collapse')?.addEventListener('click', () => { w.runModeOpen = false; renderWizard(); });
  document.getElementById('w-advanced-toggle')?.addEventListener('click', () => {
    document.querySelectorAll('[data-field]').forEach(el => {
      w.inputs[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
    });
    w.advancedOpen = !w.advancedOpen;
    renderWizard();
  });
  body.querySelector('[data-field="agentId"]')?.addEventListener('change', (e) => {
    const tplField = document.getElementById('w-command-template');
    if (tplField) tplField.placeholder = agentDefaults(e.target.value).commandTemplate || '';
  });
  wirePathPickers(body);
  document.getElementById('w-preview-command')?.addEventListener('click', async () => {
    const pre = document.getElementById('w-command-preview');
    pre.style.display = 'block';
    pre.textContent = 'Resolving…';
    document.querySelectorAll('[data-field]').forEach(el => {
      w.inputs[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
    });
    const tpl = S.meta.templates.find(t => t.id === w.templateId);
    if (!Object.keys(w.instructions).length) w.instructions = buildInstructionsFromInputs(tpl, w.inputs);
    try {
      const r = await api('/api/agents/preview', {
        method: 'POST',
        body: {
          inputs: w.inputs,
          instructions: w.instructions,
          title: w.inputs.title || tpl.name,
          agentId: w.inputs.agentId || 'auto',
          commandTemplate: w.inputs.commandTemplate || undefined,
          flattenPrompt: w.inputs.flattenPrompt,
        },
      });
      pre.textContent = r.command;
    } catch (e) {
      pre.textContent = `Error: ${e.message}`;
    }
  });
  body.querySelectorAll('[data-instr]').forEach(btn => {
    btn.onclick = () => {
      w.instructions[S.instrTab] = document.getElementById('instr-editor')?.value || '';
      S.instrTab = btn.dataset.instr;
      renderWizard();
    };
  });
  const sched = body.querySelector('#w-schedule');
  sched?.addEventListener('change', () => {
    w.schedule.type = sched.value;
    const fields = document.getElementById('w-schedule-fields');
    if (fields) fields.innerHTML = renderScheduleFields({ ...w.schedule, type: sched.value });
  });
  document.getElementById('w-schedule-suggest-apply')?.addEventListener('click', () => {
    if (w.suggestions?.scheduleType) w.schedule.type = w.suggestions.scheduleType.value;
    renderWizard();
  });
}

function buildInstructionsFromInputs(tpl, inputs, learnedSkeletons) {
  const ins = {};
  for (const sec of tpl.instructionSections) {
    if (sec.key === 'agentPrompt' && inputs.goal) {
      ins.agentPrompt = `# ${inputs.title || 'Task'}\n\n## Goal\n${inputs.goal}\n`;
    } else if (sec.key === 'voScript' && inputs.hook) ins.voScript = inputs.hook;
    else if (learnedSkeletons?.[sec.key]?.text) ins[sec.key] = learnedSkeletons[sec.key].text;
    else ins[sec.key] = '';
  }
  return ins;
}

async function submitWizard() {
  const w = S.wizard;
  const tpl = S.meta.templates.find(t => t.id === w.templateId);
  if (document.getElementById('instr-editor')) {
    w.instructions[S.instrTab] = document.getElementById('instr-editor')?.value || w.instructions[S.instrTab];
  }
  const schedule = readScheduleFields({ ...w.schedule });
  if (w.inputs.dayNumber && schedule.type === 'campaign_day') schedule.campaignDay = Number(w.inputs.dayNumber);
  if (isShellTemplate(w.templateId)) w.runMode = 'manual';

  await api('/api/tasks', {
    method: 'POST',
    body: {
      templateId: w.templateId,
      title: w.inputs.title || tpl.name,
      inputs: w.inputs,
      instructions: w.instructions,
      runMode: w.runMode,
      schedule,
      // If this wizard was opened from "Edit before creating" on a quick-add suggestion,
      // carry the original request text + first-guess spec through so the server can log
      // what the user actually changed — see ledger.js's quick_add_resolved event.
      quickAddOrigin: w.quickAddOrigin || undefined,
    },
  });
  toast('Job created');
  closeModals();
  await refresh();
}

async function openTask(id) {
  const data = await api(`/api/tasks/${id}`);
  S.selectedTask = data;
  document.getElementById('task-modal-title').textContent = data.task.title;
  const t = data.task;
  const editable = data.editable;
  const body = document.getElementById('task-modal-body');

  let media = '';
  if (data.artifacts?.length) {
    const thumb = data.artifacts.find(a => a.name === 'thumbnail.png');
    const vid = data.artifacts.find(a => a.name === 'video.mp4');
    media = `<div class="preview-media">${thumb ? `<img src="${thumb.url}" alt="thumb"/>` : ''}${vid ? `<video src="${vid.url}" controls></video>` : ''}</div>`;
  }

  const instrKeys = data.template?.instructionSections || [];
  const instrKeySet = instrKeys.map(s => s.key);
  if (!instrKeySet.includes(S.instrTab)) S.instrTab = instrKeys[0]?.key;

  const muteEligible = !['running', 'completed'].includes(t.status);
  const muteBtn = muteEligible ? `<button class="btn btn-text" id="task-mute">${t.muted ? 'Unmute' : 'Mute'}</button>` : '';
  const copyBtn = '<button class="btn btn-text" id="task-copy">Copy</button>';
  const hasAgentField = data.template?.fields?.some(f => f.type === 'agent-select');
  const shellJob = isShellTemplate(t.templateId);

  body.innerHTML = `
    <p style="margin-bottom:.75rem">${statusBadge(t.status)}${t.muted ? '<span class="badge muted" style="margin-left:.35rem">Muted</span>' : ''} <span style="color:var(--md-sys-color-on-surface-variant);margin-left:.5rem">${esc(shellJob ? 'Terminal' : runModeLabel(t.runMode))} · ${esc(scheduleLabelForTask(t))}</span></p>
    ${t.execution?.error ? `<div class="post-box is-error" style="margin-bottom:12px">${esc(t.execution.error)}</div>` : ''}
    ${t.summary ? `<p style="color:var(--md-sys-color-on-surface-variant);margin-bottom:.75rem">${esc(t.summary)}</p>` : ''}
    ${media}
    ${editable && (t.status === 'scheduled' || t.status === 'draft') ? renderTaskScheduleEditor(t) : ''}
    ${editable && shellJob ? `
      <h3 class="section-title">Command</h3>
      <div class="field">
        <label>Terminal command</label>
        <textarea class="instr-editor" id="task-shell-command" style="min-height:72px;font-family:ui-monospace,monospace">${esc(t.inputs?.command || '')}</textarea>
      </div>
      <div class="field">
        <label>Working directory</label>
        ${pathFieldHTML({ id: 'task-shell-cwd', value: t.inputs?.cwd || '', placeholder: '/path/to/folder' })}
      </div>
      <div class="status-actions" style="margin-bottom:12px">
        <button class="btn btn-outlined" id="task-save-shell">Save command</button>
        <button class="btn btn-tonal" id="task-start">Run now</button>
        ${['scheduled', 'failed'].includes(t.status) ? '<button class="btn btn-text" id="task-stop">Stop</button>' : ''}
        ${muteBtn}
        ${copyBtn}
      </div>
    ` : ''}
    ${editable && hasAgentField ? `
      <h3 class="section-title">Agent</h3>
      <div class="field"><label>Agent</label>${renderAgentSelect('task-agent-id', t.inputs?.agentId)}</div>
      <div class="field">
        <label>Command template</label>
        <textarea class="instr-editor" id="task-command-template" style="min-height:56px" placeholder="${esc(agentDefaults(t.inputs?.agentId).commandTemplate || '')}">${esc(t.inputs?.commandTemplate || '')}</textarea>
        <div class="hint">Placeholders: {BIN} {WORKSPACE} {MODEL} {PROMPT}. Leave blank to use the agent's default shown above.</div>
      </div>
      <label class="field" style="flex-direction:row;align-items:center;gap:8px">
        <input type="checkbox" id="task-flatten-prompt" ${(t.inputs?.flattenPrompt ?? agentDefaults(t.inputs?.agentId).flattenPrompt) ? 'checked' : ''}/> Flatten prompt to a single line
      </label>
      <div class="status-actions" style="margin-bottom:12px">
        <button class="btn btn-outlined" id="task-save-agent">Save agent settings</button>
        <button class="btn btn-text" id="task-preview-command">Preview command</button>
      </div>
      <pre class="log-box" id="task-command-preview" style="display:none;white-space:pre-wrap;word-break:break-all"></pre>
    ` : ''}
    ${editable && !shellJob ? `
      <p class="section-lead" style="margin:12px 0">Edit instructions, then run when you are ready.${t.status === 'failed' ? ' Fix the workspace path or leave it blank to use the default.' : ''}</p>
      <div class="instr-tabs">${instrKeys.map(s =>
        `<button type="button" class="instr-tab ${S.instrTab === s.key ? 'active' : ''}" data-instr-task="${s.key}">${esc(s.label)}</button>`
      ).join('')}</div>
      <textarea class="instr-editor" id="task-instr-editor">${esc(t.instructions[S.instrTab] || '')}</textarea>
      <div class="status-actions">
        <button class="btn btn-filled" id="task-save-instr">Save instructions</button>
        <button class="btn btn-tonal" id="task-start">Run now</button>
        ${['scheduled', 'failed'].includes(t.status) ? '<button class="btn btn-text" id="task-stop">Stop</button>' : ''}
        ${muteBtn}
        ${copyBtn}
      </div>` : editable && shellJob ? '' : `
      <div class="status-actions">
        ${t.status === 'failed' ? '<button class="btn btn-filled" id="task-retry">Try again</button>' : ''}
        ${t.status === 'completed' ? '<button class="btn btn-outlined" id="task-deliver">Send via Omnish</button>' : ''}
        ${t.status === 'running' ? '<button class="btn btn-text" id="task-stop">Stop</button>' : ''}
        ${t.status === 'paused' ? '<button class="btn btn-filled" id="task-resume">Resume</button>' : ''}
        ${muteBtn}
        <button class="btn btn-text" id="task-duplicate">Duplicate</button>
        ${copyBtn}
      </div>
      ${t.instructions?.socialPost ? `<h3 class="section-title" style="margin-top:16px">Social copy</h3><div class="post-box">${esc((t.instructions.socialPost || '').slice(0, 800))}</div>` : ''}`}
    <h3 class="section-title" style="margin-top:16px">Activity log</h3>
    <div class="log-box" id="task-log">Loading…</div>
    ${data.artifacts?.length ? `<div class="asset-row">${data.artifacts.map(a => `<a class="btn ghost" href="${a.url}" target="_blank">${esc(a.name)}</a>`).join('')}</div>` : ''}`;

  document.getElementById('task-modal').classList.remove('hidden');
  wirePathPickers(body);

  body.querySelectorAll('[data-instr-task]').forEach(btn => {
    btn.onclick = () => {
      t.instructions[S.instrTab] = document.getElementById('task-instr-editor')?.value || '';
      S.instrTab = btn.dataset.instrTask;
      openTask(id);
    };
  });

  document.getElementById('task-save-shell')?.addEventListener('click', async () => {
    const inputs = {
      ...t.inputs,
      command: document.getElementById('task-shell-command')?.value || '',
      cwd: document.getElementById('task-shell-cwd')?.value?.trim() || '',
    };
    if (!inputs.command.trim()) { toast('Command is required'); return; }
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: { inputs } });
    t.inputs = inputs;
    toast('Command saved');
  });

  document.getElementById('task-save-instr')?.addEventListener('click', async () => {
    t.instructions[S.instrTab] = document.getElementById('task-instr-editor').value;
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: { instructions: t.instructions } });
    toast('Instructions saved');
  });
  document.getElementById('task-agent-id')?.addEventListener('change', (e) => {
    const tpl = document.getElementById('task-command-template');
    if (tpl) tpl.placeholder = agentDefaults(e.target.value).commandTemplate || '';
  });
  document.getElementById('task-save-agent')?.addEventListener('click', async () => {
    const inputs = {
      ...t.inputs,
      agentId: document.getElementById('task-agent-id')?.value || 'auto',
      commandTemplate: document.getElementById('task-command-template')?.value?.trim() || '',
      flattenPrompt: document.getElementById('task-flatten-prompt')?.checked,
    };
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: { inputs } });
    t.inputs = inputs;
    toast('Agent settings saved');
  });
  document.getElementById('task-preview-command')?.addEventListener('click', async () => {
    const pre = document.getElementById('task-command-preview');
    pre.style.display = 'block';
    pre.textContent = 'Resolving…';
    try {
      const r = await api('/api/agents/preview', {
        method: 'POST',
        body: {
          inputs: t.inputs,
          instructions: { ...t.instructions, [S.instrTab]: document.getElementById('task-instr-editor')?.value ?? t.instructions[S.instrTab] },
          title: t.title,
          summary: t.summary,
          agentId: document.getElementById('task-agent-id')?.value || 'auto',
          commandTemplate: document.getElementById('task-command-template')?.value?.trim() || undefined,
          flattenPrompt: document.getElementById('task-flatten-prompt')?.checked,
        },
      });
      pre.textContent = r.command;
    } catch (e) {
      pre.textContent = `Error: ${e.message}`;
    }
  });
  document.getElementById('task-schedule-type')?.addEventListener('change', () => {
    const type = document.getElementById('task-schedule-type').value;
    const fields = document.getElementById('task-schedule-fields');
    if (fields) fields.innerHTML = renderScheduleFields({ ...t.schedule, type }, 'task-w');
  });
  document.getElementById('task-save-schedule')?.addEventListener('click', async () => {
    const type = document.getElementById('task-schedule-type')?.value || t.schedule.type;
    const schedule = readScheduleFields({ ...t.schedule, type }, 'task-w');
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: { schedule } });
    toast('Schedule saved');
    await openTask(id);
  });
  document.getElementById('task-start')?.addEventListener('click', async () => {
    await api(`/api/tasks/${id}/start`, { method: 'POST' });
    toast('Job queued. Omnish will notify you.');
    closeModals();
    await refresh();
  });
  document.getElementById('task-retry')?.addEventListener('click', async () => {
    await api(`/api/tasks/${id}/start`, { method: 'POST' });
    toast('Re-queued');
    closeModals();
    await refresh();
  });
  document.getElementById('task-stop')?.addEventListener('click', async () => {
    await api(`/api/tasks/${id}/stop`, { method: 'POST' });
    toast('Stopped. It will not retry until resumed.');
    closeModals();
    await refresh();
  });
  document.getElementById('task-resume')?.addEventListener('click', async () => {
    await api(`/api/tasks/${id}/resume`, { method: 'POST' });
    toast('Resumed and re-queued');
    closeModals();
    await refresh();
  });
  document.getElementById('task-deliver')?.addEventListener('click', async () => {
    await api('/api/tasks', { method: 'POST', body: {
      templateId: 'deliver-content',
      title: `Deliver: ${t.title}`,
      inputs: { title: t.title, sourceDay: t.inputs?.dayNumber || t.schedule?.campaignDay },
      schedule: { type: 'now' },
    }});
    toast('Delivery queued');
    closeModals();
    await refresh();
  });
  document.getElementById('task-duplicate')?.addEventListener('click', async () => {
    await api(`/api/tasks/${id}/duplicate`, { method: 'POST' });
    toast('Duplicated. Edit it in Up next.');
    closeModals();
    await refresh();
  });
  document.getElementById('task-mute')?.addEventListener('click', async () => {
    await api(`/api/tasks/${id}/${t.muted ? 'unmute' : 'mute'}`, { method: 'POST' });
    toast(t.muted ? 'Unmuted — back on schedule' : "Muted — it'll stay scheduled but won't run until unmuted");
    closeModals();
    await refresh();
  });
  document.getElementById('task-copy')?.addEventListener('click', () => {
    S.jobClipboard = {
      templateId: t.templateId,
      title: t.title,
      summary: t.summary,
      runMode: t.runMode,
      inputs: { ...t.inputs },
      instructions: { ...t.instructions },
    };
    toast(`Copied "${t.title}" — paste it from New job`);
  });

  const log = await api(`/api/tasks/${id}/log`);
  document.getElementById('task-log').textContent = log.log || '(no log yet)';
}

function bindMain() {
  wirePathPickers(document.getElementById('main'));
  document.getElementById('cal-prev')?.addEventListener('click', () => {
    let m = S.calMonth - 1;
    let y = S.calYear;
    if (m < 1) { m = 12; y -= 1; }
    loadCalendar({ year: y, month: m, day: null });
  });
  document.getElementById('cal-next')?.addEventListener('click', () => {
    let m = S.calMonth + 1;
    let y = S.calYear;
    if (m > 12) { m = 1; y += 1; }
    loadCalendar({ year: y, month: m, day: null });
  });
  document.getElementById('cal-today')?.addEventListener('click', () => {
    const now = new Date();
    loadCalendar({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() });
  });
  document.querySelectorAll('[data-cal-day]').forEach(btn => {
    btn.addEventListener('click', () => {
      const day = Number(btn.dataset.calDay);
      if (!day) return;
      loadCalendar({ day });
    });
  });
  initCalendarDayTimeline();
  document.querySelectorAll('[data-start-task]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/tasks/${btn.dataset.startTask}/start`, { method: 'POST' });
      toast('Day queued. Omnish will notify you.');
      await refresh();
    });
  });
  document.querySelectorAll('[data-pause-workspace]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/workspaces/${btn.dataset.pauseWorkspace}/pause`, { method: 'POST' });
      toast('Campaign paused. No new runs until resumed.');
      await refresh();
    });
  });
  document.querySelectorAll('[data-resume-workspace]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/workspaces/${btn.dataset.resumeWorkspace}/resume`, { method: 'POST' });
      toast('Campaign resumed.');
      await refresh();
    });
  });
  document.querySelectorAll('[data-macro-run]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const { macro } = await api(`/api/suggestions/macro/${btn.dataset.macroRun}`);
        openWizard(macro.spec);
        toast(`Prefilled "${macro.label}" from your usual next step — review and create.`);
      } catch {
        toast('No suggestion available right now');
      }
    });
  });
  document.querySelectorAll('[data-workspace-switch]').forEach(el => {
    el.addEventListener('change', () => switchWorkspace(el.value));
  });
  document.getElementById('compose-add-day')?.addEventListener('click', () => {
    syncComposerStateFromDom();
    const nextDay = (S.composerDays || []).reduce((m, d) => Math.max(m, d.day), 0) + 1;
    S.composerDays = [...(S.composerDays || []), { day: nextDay, title: '' }];
    S.composerExpanded[nextDay] = true;
    render();
  });
  document.getElementById('compose-save')?.addEventListener('click', () => saveComposer(false));
  document.getElementById('compose-save-sync')?.addEventListener('click', () => saveComposer(true));
  document.getElementById('compose-install-cron')?.addEventListener('click', async () => {
    try {
      await api(`/api/workspaces/${S.activeWorkspaceId}/install-cron`, { method: 'POST' });
      toast('Cron installed — daily automation is live');
    } catch (e) {
      toast(e.message);
    }
  });
  document.querySelectorAll('[data-toggle-more]').forEach(btn => {
    btn.addEventListener('click', () => {
      syncComposerStateFromDom();
      const day = Number(btn.dataset.toggleMore);
      S.composerExpanded[day] = !S.composerExpanded[day];
      render();
    });
  });
  document.querySelectorAll('[data-delete-day]').forEach(btn => {
    btn.addEventListener('click', () => {
      syncComposerStateFromDom();
      const day = Number(btn.dataset.deleteDay);
      S.composerDays = S.composerDays.filter(d => d.day !== day);
      delete S.composerExpanded[day];
      render();
    });
  });
  document.querySelectorAll('[data-tab-jump]').forEach(btn => {
    btn.addEventListener('click', () => {
      setActiveTab(btn.dataset.tabJump);
    });
  });
  document.querySelectorAll('[data-task]:not([data-cal-event]), [data-open-task]').forEach(el => {
    el.addEventListener('click', () => openTask(el.dataset.task || el.dataset.openTask));
  });
  document.querySelectorAll('[data-day-task]').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.dayTask) {
        openTask(el.dataset.dayTask);
        return;
      }
      const day = Number(el.dataset.day);
      if (el.dataset.hasPlan === '1') {
        openImportModal({ mode: 'campaign', fromDay: day, toDay: day });
        return;
      }
      toast(`Day ${day} has no campaign plan. Use Import jobs or create a custom job.`);
    });
  });
  document.getElementById('btn-import-jobs')?.addEventListener('click', () => openImportModal());
  document.getElementById('btn-new-campaign')?.addEventListener('click', openNewCampaignModal);
  document.getElementById('btn-add-inline')?.addEventListener('click', () => openWizard());
  document.getElementById('btn-add-inline2')?.addEventListener('click', () => openWizard());
  document.getElementById('btn-sync')?.addEventListener('click', async () => {
    const total = S.timeline?.totalDays || 30;
    const r = await api('/api/tasks/bulk', {
      method: 'POST',
      body: { mode: 'campaign', workspaceId: S.activeWorkspaceId, fromDay: 1, toDay: total },
    });
    toast(`Synced ${r.synced || 0} campaign jobs`);
    await refresh();
  });
  document.getElementById('btn-test-notify')?.addEventListener('click', async () => {
    const r = await api('/api/notify/test', { method: 'POST' });
    if (r.skipped) toast('Notifications disabled in config');
    else if (!r.ok) toast(`Notification failed: ${r.error || 'unknown'}`);
    else toast('Test notification sent');
  });
  document.getElementById('btn-test-delivery')?.addEventListener('click', async () => {
    await saveSettings();
    const r = await api('/api/delivery/test', { method: 'POST' });
    if (r.skipped) toast('Delivery skipped');
    else if (!r.ok) toast(`Delivery failed: ${r.error || 'unknown'}`);
    else toast('Test delivery sent');
  });
  document.getElementById('btn-sign-out')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    location.replace('/login.html');
  });
  document.getElementById('set-start')?.addEventListener('change', saveSettings);
  document.getElementById('set-done')?.addEventListener('change', saveSettings);
  document.getElementById('set-fail')?.addEventListener('change', saveSettings);
  document.getElementById('set-sup')?.addEventListener('change', saveSettings);
  document.getElementById('set-delivery')?.addEventListener('change', saveSettings);
  document.getElementById('set-delivery-mode')?.addEventListener('change', () => {
    const mode = document.getElementById('set-delivery-mode')?.value;
    const wrap = document.getElementById('delivery-link-wrap');
    if (wrap) wrap.hidden = mode !== 'link';
    const hint = document.querySelector('#set-delivery-mode')?.closest('.settings-card')?.querySelector('.hint');
    const modes = S.meta?.deliveryModes || [];
    if (hint) hint.textContent = modes.find(m => m.id === mode)?.description || '';
    saveSettings();
  });
  document.getElementById('set-delivery-peer')?.addEventListener('change', saveSettings);
  document.getElementById('set-public-url')?.addEventListener('change', saveSettings);
}

async function saveSettings() {
  await api('/api/settings', {
    method: 'PATCH',
    body: {
      notifyOnStart: document.getElementById('set-start')?.checked,
      notifyOnComplete: document.getElementById('set-done')?.checked,
      notifyOnFail: document.getElementById('set-fail')?.checked,
      supervisorEnabled: document.getElementById('set-sup')?.checked,
      deliveryOnComplete: document.getElementById('set-delivery')?.checked,
      deliveryMode: document.getElementById('set-delivery-mode')?.value,
      deliveryPeer: document.getElementById('set-delivery-peer')?.value?.trim() || '',
      publicUrl: document.getElementById('set-public-url')?.value?.trim() || '',
    },
  });
}

const TAB_TITLES = {
  home: 'Overview',
  calendar: 'Calendar',
  timeline: 'Timeline',
  compose: 'Compose',
  settings: 'Settings',
};

function setActiveTab(tab) {
  S.tab = tab;
  document.querySelectorAll('[data-tab]').forEach(el => {
    if (el.classList.contains('bottom-nav__item') || el.classList.contains('sidebar-nav__item')) {
      el.classList.toggle('active', el.dataset.tab === tab);
    }
  });
  const title = document.getElementById('page-title');
  if (title) title.textContent = TAB_TITLES[tab] || 'OmnishPilot';
  if (tab === 'calendar') {
    loadCalendar().catch(e => toast(e.message));
    return;
  }
  if (tab === 'compose') {
    loadComposer().catch(e => toast(e.message));
    return;
  }
  render();
}

document.querySelectorAll('[data-tab]').forEach(tab => {
  if (tab.classList.contains('bottom-nav__item') || tab.classList.contains('sidebar-nav__item')) {
    tab.addEventListener('click', () => setActiveTab(tab.dataset.tab));
  }
});

document.getElementById('btn-add-work').addEventListener('click', () => openWizard());
document.getElementById('btn-add-work-sidebar')?.addEventListener('click', () => openWizard());
document.getElementById('fab-add-work').addEventListener('click', () => openWizard());

// --- Quick add: one text box that interprets a plain-language request into a job spec,
// sitting alongside (not replacing) the full New job wizard. Lives outside #main so the
// 10s dashboard poll never wipes what the user is mid-typing.
const quickAddFolderRow = document.getElementById('quick-add-folder-row');
if (quickAddFolderRow) {
  quickAddFolderRow.innerHTML = pathFieldHTML({ id: 'quick-add-workspace', placeholder: '/path/to/project (optional)' });
  wirePathPickers(quickAddFolderRow);
}
document.getElementById('quick-add-folder-toggle')?.addEventListener('click', () => {
  quickAddFolderRow?.classList.toggle('hidden');
});
document.getElementById('quick-add-go')?.addEventListener('click', submitQuickAdd);
document.getElementById('quick-add-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitQuickAdd(); }
});

async function submitQuickAdd() {
  const input = document.getElementById('quick-add-input');
  const text = input.value.trim();
  const result = document.getElementById('quick-add-result');
  if (!text) { toast('Type what you want done first'); return; }
  const workspace = document.getElementById('quick-add-workspace')?.value.trim() || '';
  const goBtn = document.getElementById('quick-add-go');
  goBtn.disabled = true;
  result.innerHTML = `<div class="quick-add-preview quick-add-preview--loading">Thinking it through…</div>`;
  try {
    const { spec } = await api('/api/quick-add/interpret', { method: 'POST', body: { text, workspace } });
    renderQuickAddPreview(spec, text, workspace);
  } catch (e) {
    result.innerHTML = `
      <div class="quick-add-preview quick-add-preview--error">
        <p>${esc(e.message || "Couldn't understand that.")}</p>
        <button type="button" class="btn btn-text sm" id="quick-add-fallback">Open New Job with this instead</button>
      </div>`;
    document.getElementById('quick-add-fallback')?.addEventListener('click', () => {
      openWizard({
        templateId: 'agent-task',
        inputs: { title: text.slice(0, 60), goal: text, workspace },
        schedule: { type: 'manual' },
        runMode: 'supervised',
      });
    });
  } finally {
    goBtn.disabled = false;
  }
}

function renderQuickAddPreview(spec, text, workspace) {
  const result = document.getElementById('quick-add-result');
  const tpl = S.meta?.templates?.find(t => t.id === spec.templateId);
  const origin = { text, workspace };
  result.innerHTML = `
    <div class="quick-add-preview">
      <div class="quick-add-preview__row">
        <span class="icon">${tpl?.icon || '🤖'}</span>
        <div style="min-width:0">
          <strong>${esc(spec.title)}</strong>
          <div class="quick-add-preview__meta">${esc(tpl?.name || 'Custom agent job')} · ${esc(formatScheduleLabel(spec.schedule))} · ${esc(runModeLabel(spec.runMode))}</div>
          ${spec._reused ? `<div class="suggestion-chip">💡 Reused from a similar request last time</div>` : ''}
        </div>
      </div>
      <div class="quick-add-preview__actions">
        <button type="button" class="btn btn-filled sm" id="quick-add-confirm">Create it</button>
        <button type="button" class="btn btn-outlined sm" id="quick-add-edit">Edit before creating</button>
        <button type="button" class="btn btn-text sm" id="quick-add-dismiss">Try again</button>
      </div>
    </div>`;
  document.getElementById('quick-add-confirm')?.addEventListener('click', () => finalizeQuickAdd(spec, origin));
  document.getElementById('quick-add-edit')?.addEventListener('click', () => openWizard(spec, origin));
  document.getElementById('quick-add-dismiss')?.addEventListener('click', () => {
    result.innerHTML = '';
    document.getElementById('quick-add-input')?.focus();
  });
}

async function finalizeQuickAdd(spec, origin) {
  await api('/api/tasks', {
    method: 'POST',
    body: {
      templateId: spec.templateId,
      title: spec.title,
      inputs: spec.inputs,
      instructions: spec.instructions,
      runMode: spec.runMode,
      schedule: spec.schedule,
      // Logged even when accepted as-is (corrected: false) — see quickAdd.findReusableSpec,
      // which reuses this exact request+spec pairing for a near-duplicate future request.
      quickAddOrigin: origin ? { text: origin.text, workspace: origin.workspace, proposedSpec: spec } : undefined,
    },
  });
  toast('Job created');
  document.getElementById('quick-add-input').value = '';
  document.getElementById('quick-add-result').innerHTML = '';
  document.getElementById('quick-add-folder-row')?.classList.add('hidden');
  await refresh();
}

async function refresh() {
  S.meta = await api('/api/meta');
  S.dashboard = await api('/api/dashboard');
  try {
    S.agents = (await api('/api/agents')).agents;
  } catch {
    S.agents = [];
  }
  if (!S.activeWorkspaceId) {
    S.activeWorkspaceId = S.meta?.workspaces?.find(w => w.enabled)?.id || S.meta?.workspaces?.[0]?.id || null;
  }
  try {
    S.timeline = S.activeWorkspaceId
      ? await api(`/api/timeline?workspaceId=${encodeURIComponent(S.activeWorkspaceId)}`)
      : null;
  } catch {
    S.timeline = null;
  }
  if (S.tab === 'calendar') {
    await loadCalendar();
    return;
  }
  if (S.tab === 'compose') {
    await loadComposer();
    return;
  }
  render();
}

async function switchWorkspace(wsId) {
  S.activeWorkspaceId = wsId;
  try {
    S.timeline = await api(`/api/timeline?workspaceId=${encodeURIComponent(wsId)}`);
  } catch {
    S.timeline = null;
  }
  if (S.tab === 'compose') {
    await loadComposer();
  } else {
    render();
  }
}

function renderWorkspaceSwitcher() {
  const list = S.meta?.workspaces || [];
  if (list.length < 2) return '';
  return `<div class="field" style="max-width:260px;margin-bottom:12px">
    <label>Campaign</label>
    <select data-workspace-switch>
      ${list.map(w => `<option value="${w.id}" ${w.id === S.activeWorkspaceId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}
    </select>
  </div>`;
}

document.getElementById('import-submit')?.addEventListener('click', submitImport);
document.getElementById('new-campaign-submit')?.addEventListener('click', submitNewCampaign);

document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', closeModals));

function closePathPicker() {
  document.getElementById('path-picker-modal')?.classList.add('hidden');
}
document.querySelectorAll('[data-close-picker]').forEach(el => el.addEventListener('click', closePathPicker));

document.getElementById('path-picker-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') pathPickerLoad(e.target.value.trim());
});
document.getElementById('path-picker-select')?.addEventListener('click', () => {
  const picked = S.pathPickerCurrent;
  const onSelect = S.pathPicker?.onSelect;
  closePathPicker();
  if (picked && onSelect) onSelect(picked);
});

function closeNewFolderModal() {
  document.getElementById('new-folder-modal')?.classList.add('hidden');
}
document.querySelectorAll('[data-close-new-folder]').forEach(el => el.addEventListener('click', closeNewFolderModal));

document.getElementById('path-picker-new-folder')?.addEventListener('click', () => {
  const currentPath = S.pathPickerCurrent;
  if (!currentPath) {
    toast('No path loaded');
    return;
  }
  const input = document.getElementById('new-folder-input');
  input.value = '';
  document.getElementById('new-folder-modal').classList.remove('hidden');
  setTimeout(() => input.focus(), 50);
});

async function submitNewFolder() {
  const currentPath = S.pathPickerCurrent;
  if (!currentPath) return;
  const folderName = document.getElementById('new-folder-input').value;
  if (!folderName || !folderName.trim()) return;
  const target = currentPath.replace(/\/+$/, '') + '/' + folderName.trim();
  try {
    await api('/api/fs/mkdir', { method: 'POST', body: { path: target } });
    toast('Folder created');
    closeNewFolderModal();
    pathPickerLoad(target);
  } catch (e) {
    toast(e.error || e.message || 'Could not create folder');
  }
}
document.getElementById('new-folder-submit')?.addEventListener('click', submitNewFolder);
document.getElementById('new-folder-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitNewFolder();
});

document.getElementById('cal-quick-add-submit')?.addEventListener('click', submitCalendarQuickAdd);
document.getElementById('cal-quick-add-title-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitCalendarQuickAdd();
});

document.addEventListener('click', (e) => {
  const menu = document.getElementById('cal-context-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  if (e.target.closest('#cal-context-menu') || e.target.closest('#cal-track-hit')) return;
  calHideContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') calHideContextMenu();
});
document.addEventListener('scroll', calHideContextMenu, true);

document.getElementById('wizard-back').addEventListener('click', () => {
  if (S.wizard.step > 0) { S.wizard.step--; renderWizard(); }
});
document.getElementById('wizard-next').addEventListener('click', async () => {
  const w = S.wizard;
  if (w.step === 0 && !w.templateId) { toast('Choose a job type'); return; }
  if (w.step === 1) {
    document.querySelectorAll('[data-field]').forEach(el => {
      w.inputs[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
    });
    const tpl = S.meta.templates.find(t => t.id === w.templateId);
    if (tpl.fields.some(f => f.required && !w.inputs[f.key])) { toast('Fill required fields'); return; }
  }
  if (w.step === 2) {
    w.schedule.type = document.getElementById('w-schedule')?.value || w.schedule.type;
    readScheduleFields(w.schedule);
    if (isShellTemplate(w.templateId)) w.runMode = 'manual';
    else w.runMode = document.querySelector('.mode-chip.selected')?.dataset.mode || w.runMode;
  }
  const lastStep = wizardLastStep(w);
  if (w.step < lastStep) { w.step++; renderWizard(); return; }
  if (document.getElementById('instr-editor')) {
    w.instructions[S.instrTab] = document.getElementById('instr-editor')?.value || '';
  }
  await submitWizard();
});

refresh().then(() => { S.poll = setInterval(refresh, 10000); }).catch(e => {
  document.getElementById('main').innerHTML = `<div class="empty">${esc(e.message)}<br><br>Start the server: <code>cd AgentBoard && npm start</code></div>`;
});
