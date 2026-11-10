import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4000';
const username = process.argv[2] || 'demo2';
const studentCode = process.argv[3] || '521H0004';
async function request(path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `Request failed (${response.status})`);
  return { payload, response };
}

const password = process.env.DEMO_PASSWORD || 'Midterm2026!';
const login = await request('/auth/login', { method: 'POST', body: { username, password } });
const cookie = login.response.headers.getSetCookie()[0].split(';')[0];
const created = await request('/payments', {
  method: 'POST', cookie,
  body: { studentCode, termsAccepted: true, idempotencyKey: crypto.randomUUID() },
});
const payment = created.payload.data.payment;
const payerEmail = created.payload.data.emailMasked;
console.log(`Transaction ${payment.transactionCode} created; OTP sent to ${payerEmail}.`);
console.log('The OTP is only available in the account Gmail inbox. It is never returned by the API or printed here.');
const rl = createInterface({ input: stdin, output: stdout });
const otp = (await rl.question('Enter the 6-digit OTP from Gmail: ')).trim();
rl.close();
const verified = await request('/otp/verify', {
  method: 'POST', cookie,
  body: { transactionId: payment.id, email: login.payload.data.user.email, otp },
});
if (!verified.payload.data.verified) throw new Error('OTP was not verified.');
const confirmed = await request('/payments/confirm', {
  method: 'POST', cookie,
  body: { transactionId: payment.id, email: login.payload.data.user.email },
});
const profile = await request('/users/profile', { cookie });
console.log(`Status: ${confirmed.payload.data.payment.status}`);
console.log(`Available balance: ${new Intl.NumberFormat('vi-VN').format(profile.payload.data.user.balance)} VND`);
