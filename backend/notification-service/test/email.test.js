import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailService, resolveEmailConfig } from '../src/emailService.js';
import { otpEmail, receiptEmail } from '../src/emailTemplates.js';

const gmail = {
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: '465',
  SMTP_SECURE: 'true',
  SMTP_USER: 'payer@gmail.com',
  SMTP_PASS: 'abcd efgh ijkl mnop',
  MAIL_FROM: '"NT iBANKING" <payer@gmail.com>',
};

test('development with SMTP missing is explicitly disabled and does not fake a send', async () => {
  const warnings = [];
  const service = await createEmailService({ NODE_ENV: 'development' }, { warn: (message) => warnings.push(message) });
  assert.equal(service.mode, 'DISABLED');
  assert.match(warnings[0], /chưa cấu hình/);
  await assert.rejects(service.sendOtp({ otp: '123456' }), (error) => error.status === 503 && !error.message.includes('123456'));
});

test('Gmail SMTP settings require complete credentials and correct TLS pairing', () => {
  assert.throws(() => resolveEmailConfig({ ...gmail, SMTP_PASS: '' }), /chưa đầy đủ/);
  assert.throws(() => resolveEmailConfig({ ...gmail, SMTP_HOST: 'smtp.example.test' }), /smtp.gmail.com/);
  assert.throws(() => resolveEmailConfig({ ...gmail, MAIL_FROM: 'other@gmail.com' }), /trùng với SMTP_USER/);
  assert.throws(() => resolveEmailConfig({ ...gmail, SMTP_PORT: '465', SMTP_SECURE: 'false' }), /465 yêu cầu/);
  const config = resolveEmailConfig(gmail);
  assert.equal(config.mode, 'SMTP');
  assert.equal(config.secure, true);
  assert.equal(config.password, 'abcdefghijklmnop');
});

test('OTP email uses NT iBANKING subject, transaction details and escapes untrusted fields', () => {
  const mail = otpEmail({ fullName: '<img src=x>', otp: '123456', transactionCode: 'IBK-123', studentCode: '521H0004', studentName: 'Sinh viên', amount: 2000000 });
  assert.equal(mail.subject, '[NT iBANKING] Mã OTP xác thực thanh toán học phí');
  assert.match(mail.text, /123456/);
  assert.match(mail.text, /521H0004/);
  assert.match(mail.html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(mail.html, /<img src=x>/);
  assert.match(mail.html, /5 phút/);
  assert.match(mail.html, /Không chia sẻ mã OTP/);
});

test('receipt email includes success subject, payment amount, remaining balance and timestamp', () => {
  const mail = receiptEmail({ payerName: 'Người nộp', transactionCode: 'IBK-123', studentCode: '521H0004', studentName: 'Sinh viên', amount: 2000000, balanceRemaining: 28000000, completedAt: '2026-11-10T02:00:00.000Z' });
  assert.equal(mail.subject, '[NT iBANKING] Xác nhận thanh toán học phí thành công');
  assert.match(mail.text, /THÀNH CÔNG/);
  assert.match(mail.html, /521H0004/);
  assert.match(mail.html, /2\.000\.000 VND/);
  assert.match(mail.html, /28\.000\.000 VND/);
});
