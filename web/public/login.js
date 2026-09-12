// Sign-in: password + 6-digit code. On success the server sets an HttpOnly session cookie.
const form = document.getElementById('gate-form');
const password = document.getElementById('password');
const code = document.getElementById('code');
const submit = document.getElementById('submit');
const message = document.getElementById('message');

let busy = false;

async function signIn() {
  if (busy) return;
  if (!password.value || code.value.length !== 6) {
    message.textContent = '请输入密码和 6 位验证码';
    return;
  }
  busy = true;
  submit.disabled = true;
  message.textContent = '';
  try {
    const response = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: password.value, code: code.value }),
    });
    if (response.ok) {
      location.replace('/app/');
      return;
    }
    const body = await response.json().catch(() => ({}));
    message.textContent = body.error === 'too-many-attempts'
      ? `尝试次数过多，请 ${body.retryAfterSec} 秒后再试`
      : '密码或验证码不正确';
    code.value = '';
    code.focus();
  } catch {
    message.textContent = '网络不通，请稍后再试';
  } finally {
    busy = false;
    submit.disabled = false;
  }
}

// Codes from the keyboard suggestion or a paste sign in right away.
code.addEventListener('input', () => {
  code.value = code.value.replace(/\D/g, '').slice(0, 6);
  if (code.value.length === 6 && password.value) signIn();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  signIn();
});
