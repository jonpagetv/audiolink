const form = document.getElementById('loginForm');
const errorEl = document.getElementById('error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.textContent = '';

  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      errorEl.textContent = 'Invalid username or password';
      return;
    }

    // Each role has exactly one home page — no need for a ?next= param.
    const { role } = await res.json();
    location.href = role === 'admin' ? '/admin' : '/studio';
  } catch (err) {
    errorEl.textContent = `error: ${err.message}`;
  }
});
