import { createLink, setStatusBadge } from '/shared/webrtc-link.js';
import { populateDeviceSelects } from '/shared/device-picker.js';
import { renderHeader } from '/shared/header.js';

renderHeader(document.getElementById('appHeader'));

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const refreshDevicesBtn = document.getElementById('refreshDevicesBtn');
const statusEl = document.getElementById('status');
const linkNameEl = document.getElementById('linkName');
const rttEl = document.getElementById('rtt');
const remoteAudio = document.getElementById('remoteAudio');
const inputSelect = document.getElementById('inputSelect');
const outputSelect = document.getElementById('outputSelect');

// The Link's id is the last path segment (this page is served at
// /client/<id> — see server/index.js). Multi-link Stage 3: a Client is
// always for one specific Link now, not a single global one.
const linkId = location.pathname.replace(/\/+$/, '').split('/').pop();

let linkActive = false;

// Client always offers — it's the side that initiates and terminates the
// link per docs/requirements.md.
const link = createLink({
  role: 'offerer',
  statusEl,
  remoteAudioEl: remoteAudio,
  rttEl,
  onEnded: () => {
    linkActive = false;
    stopBtn.disabled = true;
    refreshSessionAvailability();
  },
});

// Single-session exclusivity (per Link) is enforced server-side (an offer
// while another client is already on this Link gets rejected), but that
// only tells us *after* we've already grabbed the mic and built a peer
// connection. Polling this Link's status lets the Start button reflect
// "busy" up front instead.
const BLOCKED_STATUS_PREFIXES = ['busy', 'link is currently unavailable'];

async function refreshSessionAvailability() {
  if (linkActive) return;
  try {
    const res = await fetch(`/api/links/${linkId}/status`);
    const { active, enabled } = await res.json();
    const blocked = active || !enabled;
    startBtn.disabled = blocked;
    if (!enabled) {
      setStatusBadge(statusEl, 'link is currently unavailable', 'warning');
    } else if (active) {
      setStatusBadge(statusEl, 'busy — another session is already active', 'warning');
    } else if (BLOCKED_STATUS_PREFIXES.some((p) => statusEl.textContent.startsWith(p))) {
      setStatusBadge(statusEl, 'idle', 'idle');
    }
  } catch {
    // Ignore — the server-side rejection on offer is still the real guard.
  }
}

async function init() {
  if (!linkId) {
    linkNameEl.textContent = 'No link specified.';
    startBtn.disabled = true;
    return;
  }

  try {
    const res = await fetch(`/api/links/${linkId}`);
    if (!res.ok) {
      linkNameEl.textContent = 'Link not found.';
      startBtn.disabled = true;
      return;
    }
    const { name } = await res.json();
    linkNameEl.textContent = `Link: ${name}`;
    refreshSessionAvailability();
    setInterval(refreshSessionAvailability, 5000);
  } catch (err) {
    linkNameEl.textContent = `error: ${err.message}`;
    startBtn.disabled = true;
  }
}

init();

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

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  try {
    await link.start({ inputDeviceId: inputSelect.value, outputDeviceId: outputSelect.value, linkId });
    linkActive = true;
    stopBtn.disabled = false;
  } catch (err) {
    console.error(err);
    setStatusBadge(statusEl, `error: ${err.message}`, 'error');
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', () => {
  link.stop();
});
