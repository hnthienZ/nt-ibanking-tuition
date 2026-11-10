import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4000';

async function call(path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    response,
    data: await response.json().catch(() => ({})),
    cookie: response.headers.getSetCookie()[0]?.split(';')[0],
  };
}

test('integration smoke: gateway, authentication, profile, tuition and protected OTP APIs', async (t) => {
  let health;
  try { health = await fetch(`${base}/health`); } catch {}
  if (!health?.ok) {
    t.skip(`API Gateway is not running at ${base}; start the stack with npm run dev.`);
    return;
  }

  const login = await call('/auth/login', { method: 'POST', body: { username: 'demo2', password: 'Midterm2026!' } });
  assert.equal(login.response.status, 200);
  assert.ok(login.cookie?.startsWith('ibanking_session='));
  assert.equal(login.data.data.token, undefined, 'JWT must not be exposed in JSON');

  const profile = await call('/users/profile', { cookie: login.cookie });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.data.data.user.username, 'demo2');

  const lookup = await call('/tuition/521H0004', { cookie: login.cookie });
  assert.equal(lookup.response.status, 200);
  assert.equal(lookup.data.data.student.studentCode, '521H0004');

  assert.equal((await call('/otp/send', { method: 'POST', body: { transactionId: '507f1f77bcf86cd799439011' } })).response.status, 401);
  assert.equal((await call('/otp/verify', { method: 'POST', body: { transactionId: '507f1f77bcf86cd799439011', email: 'demo2@example.com', otp: '123456' } })).response.status, 401);
  assert.equal((await call('/payments/confirm', { method: 'POST', body: { transactionId: '507f1f77bcf86cd799439011', email: 'demo2@example.com' } })).response.status, 401);
});
