import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4000';
const password = process.env.DEMO_PASSWORD || 'Midterm2026!';
const rl = createInterface({ input: stdin, output: stdout });

async function request(path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, payload: await response.json().catch(() => ({})) };
}

async function session(username) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, `Login failed for ${username}`);
  const cookie = response.headers.getSetCookie()[0].split(';')[0];
  const profile = await request('/users/profile', { cookie });
  return { cookie, email: profile.payload.data.user.email };
}

async function create(user, studentCode, idempotencyKey = crypto.randomUUID()) {
  return request('/payments', {
    method: 'POST', cookie: user.cookie,
    body: { studentCode, termsAccepted: true, idempotencyKey },
  });
}

async function readOtp(label) {
  const value = (await rl.question(`Open the Gmail message for ${label} and enter its 6-digit OTP: `)).trim();
  assert.match(value, /^\d{6}$/);
  return value;
}

async function verify(user, payment, otp) {
  return request('/otp/verify', {
    method: 'POST', cookie: user.cookie,
    body: { transactionId: payment.id, email: user.email, otp },
  });
}

async function confirm(user, payment) {
  return request('/payments/confirm', {
    method: 'POST', cookie: user.cookie,
    body: { transactionId: payment.id, email: user.email },
  });
}

try {
  const payer = await session('demo2');
  const first = await create(payer, '521H0004');
  assert.equal(first.status, 201);
  const payment = first.payload.data.payment;
  assert.equal(first.payload.data.emailSent, true);
  assert.equal(first.payload.data.demoOtp, undefined, 'OTP must not appear in API responses');
  assert.equal((await request('/otp/send', { method: 'POST', cookie: payer.cookie, body: { transactionId: payment.id } })).status, 429, 'resend must respect cooldown');

  const code = await readOtp('521H0004');
  const wrongCode = code === '000000' ? '000001' : '000000';
  assert.equal((await verify(payer, payment, wrongCode)).status, 400, 'wrong OTP must be rejected');
  assert.equal((await verify(payer, payment, code)).status, 200);
  assert.equal((await confirm(payer, payment)).payload.data.payment.status, 'SUCCEEDED');
  const balance = (await request('/users/balance', { cookie: payer.cookie })).payload.data.balance;
  assert.equal((await verify(payer, payment, code)).status, 409, 'OTP reuse must be rejected');
  await confirm(payer, payment);
  assert.equal((await request('/users/balance', { cookie: payer.cookie })).payload.data.balance, balance, 'confirm replay must not debit twice');

  const a = await create(payer, '521H0006');
  const b = await create(payer, '521H0007');
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const codeA = await readOtp('521H0006');
  const codeB = await readOtp('521H0007');
  assert.equal((await verify(payer, a.payload.data.payment, codeB)).status, 400, 'OTP must be bound to its transaction');
  assert.equal((await verify(payer, a.payload.data.payment, codeA)).status, 200);
  assert.equal((await confirm(payer, a.payload.data.payment)).status, 200);
  assert.equal((await verify(payer, b.payload.data.payment, codeB)).status, 200);
  assert.equal((await confirm(payer, b.payload.data.payment)).status, 200);

  const expiring = await create(payer, '521H0008');
  assert.equal(expiring.status, 201);
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/?replicaSet=rs0', {
    dbName: process.env.NOTIFICATION_DB || 'ibanking_notification',
  });
  await mongoose.connection.collection('otps').updateOne(
    { transactionId: expiring.payload.data.payment.id },
    { $set: { expiresAt: new Date(Date.now() - 1000), purgeAt: new Date(Date.now() + 60000) } },
  );
  await mongoose.disconnect();
  assert.equal((await verify(payer, expiring.payload.data.payment, '123456')).status, 410, 'expired OTP must cancel the payment');
  const state = await request(`/payments/${expiring.payload.data.payment.id}`, { cookie: payer.cookie });
  assert.equal(state.payload.data.payment.status, 'FAILED');
  console.log('OTP demo passed: cooldown, incorrect OTP, one-time use, transaction binding and expiry cancellation.');
} finally {
  await mongoose.disconnect().catch(() => {});
  rl.close();
}
