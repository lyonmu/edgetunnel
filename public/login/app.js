const form = document.querySelector('#login-form');
const password = document.querySelector('#password');
const message = document.querySelector('#login-message');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  message.textContent = '正在验证…';
  message.classList.remove('error');
  try {
    const response = await fetch('/api/admin/v1/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error?.message || '登录失败');
    }
    password.value = '';
    window.location.assign('/admin');
  } catch (error) {
    password.value = '';
    message.textContent = error instanceof Error ? error.message : '登录失败';
    message.classList.add('error');
  } finally {
    button.disabled = false;
  }
});
