// Shared by /admin and /studio — wires up a Logout button to clear the
// session and return to the login page.
export function wireLogoutButton(button) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await fetch('/api/logout', { method: 'POST' });
    } finally {
      location.href = '/login';
    }
  });
}
