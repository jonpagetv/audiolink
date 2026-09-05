import { createLink, setStatusBadge } from '/shared/webrtc-link.js';
import { populateDeviceSelects } from '/shared/device-picker.js';
import { renderHeader } from '/shared/header.js';
import { formatCreatedAt, createStatusBadge, createCopyUrlButton, createDeleteButton, wireCreateLinkForm } from '/shared/link-manage.js';

const refreshDevicesBtn = document.getElementById('refreshDevicesBtn');
const refreshLinksBtn = document.getElementById('refreshLinksBtn');
const linksListEl = document.getElementById('linksList');
const statusEl = document.getElementById('status');
const rttEl = document.getElementById('rtt');
const remoteAudio = document.getElementById('remoteAudio');
const inputSelect = document.getElementById('inputSelect');
const outputSelect = document.getElementById('outputSelect');

renderHeader(document.getElementById('appHeader'), { withAccount: true });

let lastDevices = { inputDeviceId: '', outputDeviceId: '' };
let lastLinkId = null;
let activeOnThisBrowser = false;
let currentLinks = [];

async function startListening(linkId) {
  lastLinkId = linkId;
  activeOnThisBrowser = true;
  renderLinks(currentLinks);
  try {
    await link.start({ ...lastDevices, linkId });
  } catch (err) {
    console.error(err);
    setStatusBadge(statusEl, `error: ${err.message}`, 'error');
    activeOnThisBrowser = false;
    renderLinks(currentLinks);
  }
}

// A session ending because the caller hung up or timed out should re-arm
// the same Link automatically (kiosk-style — no operator action needed for
// the next caller). Admin force-terminating it should NOT: that's a
// deliberate moderation/emergency action (same as the operator's own Stop
// click), and instantly reopening the exact same channel would make Force
// Terminate look like it did nothing — the Link needs to visibly go idle
// so whoever force-terminated it can see that it worked, and a Studio
// operator needs to consciously decide to take the next caller. A rejected
// activation (already claimed elsewhere, disabled, deleted) shouldn't
// auto-rearm either — retrying a claim that just failed in a loop would
// be wrong, not helpful.
const AUTO_REARM_REASONS = ['timeout', 'peer-ended'];

// Studio always answers — it waits for the client to initiate. Selecting a
// Link and starting it arms getUserMedia/signaling ahead of the offer; on
// the real Studio PC this becomes kiosk-launch-triggered instead of manual.
const link = createLink({
  role: 'answerer',
  statusEl,
  remoteAudioEl: remoteAudio,
  rttEl,
  onEnded: (reason) => {
    activeOnThisBrowser = false;
    if (AUTO_REARM_REASONS.includes(reason)) {
      startListening(lastLinkId);
    } else {
      // Fetch fresh rather than re-render the (possibly now stale, up to
      // 5s old) cached list — this Link's status just changed server-side
      // and the row should reflect that immediately, not on the next poll.
      refreshLinks();
    }
  },
});

// Studio never sends an offer, so it never gets the 'busy'/'unavailable'
// messages the server sends in response to one — it has no other way to
// learn the link's been disabled. Poll the same global switch the client
// checks, but only touch the text while resting (idle or armed-and-
// waiting): a live call's status is driven by connectionstatechange and
// shouldn't be clobbered.
const RESTING_STATUSES = ['idle', 'waiting for client...'];
const RESTING_KIND = { idle: 'idle', 'waiting for client...': 'pending' };
let statusBeforeUnavailable = null;

async function refreshLinkAvailability() {
  try {
    const res = await fetch('/api/status');
    const { enabled } = await res.json();
    const current = statusEl.textContent;
    if (!enabled && RESTING_STATUSES.includes(current)) {
      statusBeforeUnavailable = current;
      setStatusBadge(statusEl, 'link is currently unavailable', 'warning');
    } else if (enabled && current === 'link is currently unavailable') {
      const restored = statusBeforeUnavailable || 'idle';
      setStatusBadge(statusEl, restored, RESTING_KIND[restored] || 'idle');
    }
  } catch {
    // Ignore — the server-side rejection on activation is still the real guard.
  }
}

refreshLinkAvailability();
setInterval(refreshLinkAvailability, 5000);

function renderLinks(links) {
  currentLinks = links;
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
    const isActiveHere = activeOnThisBrowser && lastLinkId === linkInfo.id;

    const actionBtn = document.createElement('button');
    if (isActiveHere) {
      actionBtn.textContent = 'Stop';
      actionBtn.className = 'btn-secondary';
      actionBtn.addEventListener('click', () => link.stop());
    } else {
      actionBtn.textContent = 'Start';
      actionBtn.className = 'btn-primary';
      // Disabled if this browser is already busy on a different Link, or
      // if this Link is already armed/live — on this browser (shouldn't
      // happen, isActiveHere would be true instead) or, more commonly,
      // claimed by a different Studio browser entirely.
      actionBtn.disabled = activeOnThisBrowser || linkInfo.status !== 'idle';
      actionBtn.addEventListener('click', () => {
        lastDevices = { inputDeviceId: inputSelect.value, outputDeviceId: outputSelect.value };
        startListening(linkInfo.id);
      });
    }
    actionsTd.appendChild(actionBtn);

    const deleteBtn = createDeleteButton(linkInfo, refreshLinks);
    deleteBtn.disabled = linkInfo.status !== 'idle';
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(actionsTd);
    linksListEl.appendChild(tr);
  }
}

async function refreshLinks() {
  try {
    const res = await fetch('/api/links');
    const { links } = await res.json();
    renderLinks(links);
  } catch (err) {
    console.error(err);
  }
}

wireCreateLinkForm({
  form: document.getElementById('createLinkForm'),
  nameInput: document.getElementById('newLinkName'),
  errorEl: document.getElementById('createLinkError'),
  onCreated: refreshLinks,
});

refreshLinksBtn.addEventListener('click', refreshLinks);
refreshLinks();
setInterval(refreshLinks, 5000);

refreshDevicesBtn.addEventListener('click', async () => {
  refreshDevicesBtn.disabled = true;
  try {
    await populateDeviceSelects({ inputSelect, outputSelect });
    inputSelect.disabled = false;
  } catch (err) {
    console.error(err);
    setStatusBadge(statusEl, `error: ${err.message}`, 'error');
  } finally {
    refreshDevicesBtn.disabled = false;
  }
});
