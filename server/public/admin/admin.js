import { renderHeader } from '/shared/header.js';
import { formatCreatedAt, createStatusBadge, createCopyUrlButton, createDeleteButton, wireCreateLinkForm } from '/shared/link-manage.js';

const enabledStatusEl = document.getElementById('enabledStatus');
const toggleEnabledBtn = document.getElementById('toggleEnabledBtn');
const refreshLinksBtn = document.getElementById('refreshLinksBtn');
const linksListEl = document.getElementById('linksList');
const refreshActivityBtn = document.getElementById('refreshActivityBtn');
const activityListEl = document.getElementById('activityList');

renderHeader(document.getElementById('appHeader'), { withAccount: true });

let currentEnabled = true;

async function refreshStatus() {
  const res = await fetch('/api/status');
  const { enabled } = await res.json();
  currentEnabled = enabled;
  enabledStatusEl.textContent = enabled ? 'enabled' : 'disabled';
  enabledStatusEl.className = `status-badge ${enabled ? 'status-live' : 'status-warning'}`;
  toggleEnabledBtn.textContent = enabled ? 'Disable Link' : 'Enable Link';
  // Clicking while enabled is about to restrict service for everyone —
  // flag it as the danger variant; re-enabling is the safe/restorative
  // direction, so it stays the plain secondary button.
  toggleEnabledBtn.className = enabled ? 'btn-danger' : 'btn-secondary';
}

toggleEnabledBtn.addEventListener('click', async () => {
  // Only confirm on the way to disabling — that's the consequential
  // direction (blocks every Link for every caller); re-enabling is safe
  // and restorative, so it doesn't need a second click to confirm.
  if (currentEnabled && !confirm('Disable Link availability? This blocks every Link for every caller until re-enabled.')) {
    return;
  }
  toggleEnabledBtn.disabled = true;
  try {
    await fetch('/api/admin/enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !currentEnabled }),
    });
    await refreshStatus();
  } finally {
    toggleEnabledBtn.disabled = false;
  }
});

const changePasswordForm = document.getElementById('changePasswordForm');
const passwordRoleSelect = document.getElementById('passwordRole');
const newPasswordInput = document.getElementById('newPassword');
const confirmPasswordInput = document.getElementById('confirmPassword');
const changePasswordError = document.getElementById('changePasswordError');
const changePasswordSuccess = document.getElementById('changePasswordSuccess');

changePasswordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  changePasswordError.textContent = '';
  changePasswordSuccess.textContent = '';

  if (newPasswordInput.value !== confirmPasswordInput.value) {
    changePasswordError.textContent = 'Passwords do not match.';
    return;
  }

  const submitBtn = changePasswordForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/admin/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: passwordRoleSelect.value, newPassword: newPasswordInput.value }),
    });
    const data = await res.json();
    if (!res.ok) {
      changePasswordError.textContent = data.error || 'Failed to change password.';
      return;
    }
    changePasswordSuccess.textContent = `${passwordRoleSelect.value === 'admin' ? 'Admin' : 'Studio'} password changed.`;
    changePasswordForm.reset();
  } catch (err) {
    changePasswordError.textContent = `error: ${err.message}`;
  } finally {
    submitBtn.disabled = false;
  }
});

function renderLinks(links) {
  linksListEl.innerHTML = '';

  for (const linkInfo of links) {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    nameTd.textContent = linkInfo.name;
    tr.appendChild(nameTd);

    const createdTd = document.createElement('td');
    createdTd.textContent = formatCreatedAt(linkInfo.createdAt);
    tr.appendChild(createdTd);

    const statusTd = document.createElement('td');
    statusTd.appendChild(createStatusBadge(linkInfo));
    tr.appendChild(statusTd);

    const urlTd = document.createElement('td');
    urlTd.appendChild(createCopyUrlButton(linkInfo.url));
    tr.appendChild(urlTd);

    const actionsTd = document.createElement('td');

    const terminateBtn = document.createElement('button');
    terminateBtn.className = 'btn-danger';
    terminateBtn.textContent = 'Force Terminate';
    terminateBtn.disabled = linkInfo.status === 'idle';
    terminateBtn.addEventListener('click', async () => {
      if (!confirm(`Force-terminate "${linkInfo.name}"?`)) return;
      terminateBtn.disabled = true;
      try {
        await fetch(`/api/admin/links/${linkInfo.id}/terminate`, { method: 'POST' });
        await refreshLinks();
      } finally {
        terminateBtn.disabled = false;
      }
    });
    actionsTd.appendChild(terminateBtn);

    const deleteBtn = createDeleteButton(linkInfo, refreshLinks);
    deleteBtn.disabled = linkInfo.status !== 'idle';
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(actionsTd);
    linksListEl.appendChild(tr);
  }
}

async function refreshLinks() {
  const res = await fetch('/api/links');
  const { links } = await res.json();
  renderLinks(links);
}

wireCreateLinkForm({
  form: document.getElementById('createLinkForm'),
  nameInput: document.getElementById('newLinkName'),
  errorEl: document.getElementById('createLinkError'),
  onCreated: refreshLinks,
});

refreshLinksBtn.addEventListener('click', refreshLinks);

refreshStatus();
setInterval(refreshStatus, 3000);
refreshLinks();
setInterval(refreshLinks, 5000);

// Purely cosmetic grouping for the badge color — not a statement about
// severity, just "created/started" reads as positive, "problem" as a
// warning, and routine stop/delete stay neutral.
const EVENT_BADGE_KIND = {
  'link-created': 'live',
  'link-started': 'live',
  'link-stopped': 'idle',
  'link-deleted': 'idle',
  'quality-problem': 'warning',
};

function renderActivity(events) {
  activityListEl.innerHTML = '';
  for (const event of events) {
    const tr = document.createElement('tr');

    const whenTd = document.createElement('td');
    whenTd.textContent = formatCreatedAt(event.at);
    tr.appendChild(whenTd);

    const eventTd = document.createElement('td');
    const eventBadge = document.createElement('span');
    eventBadge.className = `status-badge status-${EVENT_BADGE_KIND[event.type] || 'idle'}`;
    eventBadge.textContent = event.type;
    eventTd.appendChild(eventBadge);
    tr.appendChild(eventTd);

    const linkTd = document.createElement('td');
    linkTd.textContent = event.name || event.linkId || '';
    tr.appendChild(linkTd);

    const detailTd = document.createElement('td');
    detailTd.textContent = event.detail || event.reason || '';
    tr.appendChild(detailTd);

    activityListEl.appendChild(tr);
  }
}

const activityFromInput = document.getElementById('activityFrom');
const activityToInput = document.getElementById('activityTo');
const activityPrevBtn = document.getElementById('activityPrevBtn');
const activityNextBtn = document.getElementById('activityNextBtn');
const activityPageInfo = document.getElementById('activityPageInfo');

let activityPage = 1;

// datetime-local gives a value like "2026-08-28T14:30" with no timezone —
// `new Date(...)` parses that as local time (matching what the operator
// actually picked), so converting to epoch ms here is enough; the server
// just compares numbers, no timezone logic on that side at all.
function activityRangeParams() {
  const params = new URLSearchParams({ page: String(activityPage) });
  if (activityFromInput.value) params.set('from', String(new Date(activityFromInput.value).getTime()));
  if (activityToInput.value) params.set('to', String(new Date(activityToInput.value).getTime()));
  return params;
}

async function refreshActivity() {
  const res = await fetch(`/api/admin/activity?${activityRangeParams()}`);
  const { events, total, page, pageSize } = await res.json();
  renderActivity(events);

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  activityPage = page;
  activityPageInfo.textContent = `Page ${page} of ${lastPage} (${total} event${total === 1 ? '' : 's'})`;
  activityPrevBtn.disabled = page <= 1;
  activityNextBtn.disabled = page >= lastPage;
}

refreshActivityBtn.addEventListener('click', refreshActivity);

document.getElementById('applyActivityFilterBtn').addEventListener('click', () => {
  activityPage = 1;
  refreshActivity();
});

document.getElementById('clearActivityFilterBtn').addEventListener('click', () => {
  activityFromInput.value = '';
  activityToInput.value = '';
  activityPage = 1;
  refreshActivity();
});

activityPrevBtn.addEventListener('click', () => {
  activityPage = Math.max(1, activityPage - 1);
  refreshActivity();
});

activityNextBtn.addEventListener('click', () => {
  activityPage += 1;
  refreshActivity();
});

refreshActivity();
