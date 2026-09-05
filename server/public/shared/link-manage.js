// Shared by /studio and /admin — both can create/delete Links and need to
// show the same list details (per docs/requirements.md: name, created
// date/time, shareable URL, current status).
export function formatCreatedAt(createdAt) {
  return new Date(createdAt).toLocaleString();
}

export function formatStatus(link) {
  if (link.status === 'connected') {
    const seconds = Math.max(0, Math.round((Date.now() - link.startedAt) / 1000));
    const m = Math.floor(seconds / 60);
    const s = String(seconds % 60).padStart(2, '0');
    return `live (${m}:${s})`;
  }
  if (link.status === 'armed') return 'armed, waiting for caller';
  return 'idle';
}

// Same three states as formatStatus, as a status-badge element (see
// style.css) instead of plain text — armed gets the "needs a look" amber
// treatment since it's a Studio actively waiting, live gets the pulsing
// green "on air" treatment.
export function createStatusBadge(link) {
  const span = document.createElement('span');
  const kind = link.status === 'connected' ? 'live' : link.status === 'armed' ? 'warning' : 'idle';
  span.className = `status-badge status-${kind}`;
  span.textContent = formatStatus(link);
  return span;
}

export function createCopyUrlButton(url) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-ghost';
  btn.textContent = 'Copy URL';
  btn.addEventListener('click', async () => {
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = 'Copied!';
    } catch (err) {
      console.error(err);
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  });
  return btn;
}

export function createDeleteButton(link, onDeleted) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-danger';
  btn.textContent = 'Delete';
  btn.addEventListener('click', async () => {
    if (!confirm(`Delete "${link.name}"? This can't be undone.`)) return;
    btn.disabled = true;
    try {
      await fetch(`/api/links/${link.id}`, { method: 'DELETE' });
      onDeleted();
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

export function wireCreateLinkForm({ form, nameInput, errorEl, onCreated }) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    try {
      const res = await fetch('/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameInput.value }),
      });
      const data = await res.json();
      if (!res.ok) {
        errorEl.textContent = data.error || 'failed to create link';
        return;
      }
      nameInput.value = '';
      onCreated();
    } catch (err) {
      errorEl.textContent = `error: ${err.message}`;
    }
  });
}
