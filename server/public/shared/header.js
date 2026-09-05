// Shared brand header for /studio, /admin, and /client — the logo (which
// already includes the "audiolink" wordmark) on the left; for logged-in
// pages (studio/admin), the account's role and a Logout button on the
// right. Centralized here rather than duplicated per page since all three
// need the identical brand mark.
import { wireLogoutButton } from './logout.js';

export async function renderHeader(mountEl, { withAccount = false } = {}) {
  mountEl.innerHTML = `
    <div class="header-brand">
      <img src="/shared/img/logo.png" alt="audiolink" class="header-logo" />
    </div>
    ${
      withAccount
        ? `<div class="header-account">
             <span class="header-username" id="headerUsername"></span>
             <button id="headerLogoutBtn" type="button" class="btn-ghost">Log Out</button>
           </div>`
        : ''
    }
  `;

  if (!withAccount) return;

  wireLogoutButton(document.getElementById('headerLogoutBtn'));

  try {
    const res = await fetch('/api/whoami');
    const { role } = await res.json();
    document.getElementById('headerUsername').textContent = role || '';
  } catch {
    // Non-critical — the page itself is already auth-gated server-side.
  }
}
