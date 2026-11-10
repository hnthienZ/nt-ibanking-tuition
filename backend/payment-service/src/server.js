import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  asyncRoute, connectDb, errorHandler, internalRequest, ok, requireAuth, requireService,
} from '@ibanking/shared';
import { Payment } from './models/Payment.js';
import { Outbox } from './models/Outbox.js';

const app = express();
app.use(express.json());
const AUTH = process.env.AUTH_URL || 'http://127.0.0.1:4001';
const TUITION = process.env.TUITION_URL || 'http://127.0.0.1:4002';
const NOTICE = process.env.NOTIFICATION_URL || 'http://127.0.0.1:4004';
const request = (url, options) => internalRequest(url, options);
const internalHeaders = { 'x-service-token': process.env.JWT_SECRET };
const emailSchema = z.string().trim().email();
const transactionIdSchema = z.string().regex(/^[a-f\d]{24}$/i);
const maskEmail = (email = '') => email.replace(/^(.{2})[^@]*(@.+)$/, '$1***$2');

app.get('/health', (req, res) => ok(res, { service: 'payment-service', status: 'up' }));

app.post('/payments', requireAuth, asyncRoute(async (req, res) => {
  const input = z.object({
    studentCode: z.string().trim().min(4).max(20),
    termsAccepted: z.literal(true),
    idempotencyKey: z.string().uuid(),
  }).parse(req.body);
  const payerId = req.user.sub;
  let payment = await Payment.findOne({ payerId, idempotencyKey: input.idempotencyKey });
  if (payment && payment.status !== 'RESERVING') return ok(res, { payment: publicPayment(payment) }, 200);

  if (!payment) {
    const studentData = await request(`${TUITION}/tuition/${encodeURIComponent(input.studentCode.toUpperCase())}`, {
      headers: { authorization: req.headers.authorization },
    });
    if (!studentData.invoice || studentData.invoice.status !== 'UNPAID') {
      const status = studentData.invoice?.status;
      const message = status === 'PAID'
        ? 'Khoản học phí này đã được thanh toán.'
        : status === 'PROCESSING'
          ? 'Khoản học phí đang được giao dịch khác xử lý.'
          : 'Không tìm thấy khoản học phí cần thanh toán.';
      throw Object.assign(new Error(message), { status: status === 'UNPAID' || !studentData.invoice ? 404 : 409 });
    }
    const account = await request(`${AUTH}/internal/accounts/${payerId}`, { headers: internalHeaders });
    if (!emailSchema.safeParse(account.user.email).success) {
      throw Object.assign(new Error('Tài khoản người nộp chưa có email hợp lệ để nhận OTP.'), {
        status: 409, code: 'PAYER_EMAIL_REQUIRED',
      });
    }
    if (account.user.balance < studentData.invoice.amount) {
      throw Object.assign(new Error('Số dư khả dụng không đủ để thanh toán toàn bộ học phí.'), {
        status: 409, code: 'INSUFFICIENT_BALANCE',
      });
    }
    payment = new Payment({
      transactionCode: `IBK-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`,
      payerId,
      payerName: account.user.fullName,
      payerEmail: account.user.email,
      studentId: studentData.student.id,
      studentCode: studentData.student.studentCode,
      studentName: studentData.student.fullName,
      faculty: studentData.student.faculty,
      major: studentData.student.major,
      invoiceId: studentData.invoice.id,
      amount: studentData.invoice.amount,
      status: 'RESERVING',
      idempotencyKey: input.idempotencyKey,
    });
    await payment.save();
  }

  try {
    await request(`${TUITION}/internal/invoices/${payment.studentCode}/reserve`, {
      method: 'POST', headers: internalHeaders, body: JSON.stringify({ paymentId: payment.id }),
    });
    const account = await request(`${AUTH}/internal/accounts/${payerId}`, { headers: internalHeaders });
    if (account.user.balance < payment.amount) {
      throw Object.assign(new Error('Số dư khả dụng không đủ.'), { status: 409 });
    }
    payment.status = 'OTP_PENDING';
    await payment.save();
    const otpDelivery = await sendOtp(payment);
    ok(res, {
      payment: publicPayment(payment),
      emailMasked: maskEmail(payment.payerEmail),
      otpExpiresAt: otpDelivery.expiresAt,
      otpResendAvailableAt: otpDelivery.resendAvailableAt,
      emailSent: otpDelivery.emailSent,
      message: 'Giao dịch đã tạo. Gửi OTP qua email trước khi xác nhận thanh toán.',
    }, 201);
  } catch (error) {
    if (payment.status === 'RESERVING') {
      await request(`${TUITION}/internal/invoices/${payment.studentCode}/release`, {
        method: 'POST', headers: internalHeaders, body: JSON.stringify({ paymentId: payment.id }),
      }).catch(() => {});
      payment.status = 'FAILED';
      payment.failureReason = error.code || 'SAGA_RESERVATION_FAILED';
      payment.completedAt = new Date();
      await payment.save();
    }
    throw error;
  }
}));

async function sendOtp(payment) {
  if (payment.status !== 'OTP_PENDING') {
    throw Object.assign(new Error('Giao dịch không còn chờ OTP.'), { status: 409, code: 'PAYMENT_NOT_OTP_PENDING' });
  }
  if (payment.otpExpiresAt && payment.otpExpiresAt <= new Date()) {
    await cancelPayment(payment, 'OTP_EXPIRED');
    throw Object.assign(new Error('OTP đã hết hạn. Giao dịch bị hủy.'), { status: 410, code: 'OTP_EXPIRED' });
  }
  const normalizedEmail = emailSchema.parse(payment.payerEmail).toLowerCase();
  let otp;
  try {
    otp = await request(`${NOTICE}/internal/otp/send`, {
      method: 'POST',
      headers: internalHeaders,
      body: JSON.stringify({
        transactionId: payment.id,
        email: normalizedEmail,
        fullName: payment.payerName,
        transactionCode: payment.transactionCode,
        studentCode: payment.studentCode,
        studentName: payment.studentName,
        amount: payment.amount,
      }),
    });
  } catch (error) {
    if (['OTP_EXPIRED', 'OTP_LOCKED', 'EMAIL_UNAVAILABLE'].includes(error.code)) {
      await cancelPayment(payment, error.code);
    }
    throw error;
  }
  payment.otpExpiresAt = otp.expiresAt;
  payment.otpResendAvailableAt = otp.resendAvailableAt;
  await payment.save();
  return otp;
}

app.post('/otp/send', requireAuth, asyncRoute(async (req, res) => {
  const input = z.object({ transactionId: transactionIdSchema }).parse(req.body);
  const payment = await Payment.findOne({ _id: input.transactionId, payerId: req.user.sub });
  if (!payment) throw Object.assign(new Error('Không tìm thấy giao dịch.'), { status: 404 });
  const result = await sendOtp(payment);
  ok(res, result);
}));

app.post('/payments/:id/send-otp', requireAuth, asyncRoute(async (req, res) => {
  const payment = await Payment.findOne({ _id: req.params.id, payerId: req.user.sub });
  if (!payment) throw Object.assign(new Error('Không tìm thấy giao dịch.'), { status: 404 });
  const result = await sendOtp(payment);
  ok(res, result);
}));

async function verifyOtp(payment, email, otp) {
  if (payment.status !== 'OTP_PENDING') {
    throw Object.assign(new Error('Giao dịch không ở trạng thái chờ xác thực OTP.'), { status: 409, code: 'PAYMENT_NOT_OTP_PENDING' });
  }
  const result = await request(`${NOTICE}/internal/otp/verify`, {
    method: 'POST', headers: internalHeaders,
    body: JSON.stringify({ transactionId: payment.id, email: emailSchema.parse(email).toLowerCase(), otp }),
  });
  const verifiedPayment = await Payment.findOneAndUpdate({ _id: payment.id, status: 'OTP_PENDING' }, {
    $set: { status: 'OTP_VERIFIED' },
  }, { new: true });
  if (!verifiedPayment) {
    throw Object.assign(new Error('Giao dịch đã hết hạn hoặc không còn chờ xác thực.'), { status: 409, code: 'PAYMENT_STATE_CONFLICT' });
  }
  Object.assign(payment, verifiedPayment.toObject());
  return result;
}

async function cancelPayment(payment, reason) {
  const cancelling = payment.status === 'CANCELLING'
    ? payment
    : await Payment.findOneAndUpdate({ _id: payment.id, status: 'OTP_PENDING' }, {
      $set: { status: 'CANCELLING', failureReason: reason },
    }, { new: true });
  if (!cancelling) return;
  try {
    await request(`${TUITION}/internal/invoices/${cancelling.studentCode}/release`, {
      method: 'POST', headers: internalHeaders, body: JSON.stringify({ paymentId: cancelling.id }),
    });
    await Payment.updateOne({ _id: cancelling.id, status: 'CANCELLING' }, {
      $set: { status: 'FAILED', completedAt: new Date(), failureReason: reason },
    });
  } catch (error) {
    console.error('OTP cancellation deferred:', cancelling.id, error.message);
  }
}

app.post('/otp/verify', requireAuth, asyncRoute(async (req, res) => {
  const input = z.object({
    email: emailSchema,
    transactionId: transactionIdSchema,
    otp: z.string().regex(/^\d{6}$/),
  }).parse(req.body);
  const payment = await Payment.findOne({ _id: input.transactionId, payerId: req.user.sub });
  if (!payment) throw Object.assign(new Error('Không tìm thấy giao dịch.'), { status: 404 });
  if (payment.payerEmail?.toLowerCase() !== input.email.toLowerCase()) {
    throw Object.assign(new Error('Email phải trùng với email của tài khoản đang đăng nhập.'), { status: 400, code: 'OTP_EMAIL_MISMATCH' });
  }
  try {
    await verifyOtp(payment, payment.payerEmail, input.otp);
  } catch (error) {
    if (['OTP_EXPIRED', 'OTP_LOCKED'].includes(error.code)) await cancelPayment(payment, error.code);
    throw error;
  }
  ok(res, { verified: true, payment: publicPayment(payment) });
}));

// Compatibility route for older demos; the canonical public flow is /otp/verify then /payments/confirm.
app.post('/payments/:id/verify-otp', requireAuth, asyncRoute(async (req, res) => {
  const input = z.object({ otp: z.string().regex(/^\d{6}$/) }).parse(req.body);
  const payment = await Payment.findOne({ _id: req.params.id, payerId: req.user.sub });
  if (!payment) throw Object.assign(new Error('Không tìm thấy giao dịch.'), { status: 404 });
  if (payment.status === 'SUCCEEDED') return ok(res, { payment: publicPayment(payment), replayed: true });
  if (payment.status === 'OTP_PENDING') {
    try {
      await verifyOtp(payment, payment.payerEmail, input.otp);
    } catch (error) {
      if (['OTP_EXPIRED', 'OTP_LOCKED'].includes(error.code)) await cancelPayment(payment, error.code);
      throw error;
    }
  }
  if (!['OTP_VERIFIED', 'DEBITED'].includes(payment.status)) {
    throw Object.assign(new Error('Giao dịch không ở trạng thái có thể xác nhận.'), { status: 409, code: 'PAYMENT_STATE_CONFLICT' });
  }
  ok(res, { payment: publicPayment(await continueSaga(payment)), replayed: false });
}));

async function continueSaga(payment) {
  const paymentId = payment.id;
  if (payment.status === 'OTP_VERIFIED') {
    try {
      const debitResult = await request(`${AUTH}/internal/accounts/${payment.payerId}/debit`, {
        method: 'POST', headers: internalHeaders,
        body: JSON.stringify({ operationId: `debit:${paymentId}`, amount: payment.amount }),
      });
      payment.balanceRemaining = Number(debitResult.balance);
      payment.status = 'DEBITED';
      await payment.save();
    } catch (error) {
      if (error.status === 409) {
        await request(`${TUITION}/internal/invoices/${payment.studentCode}/release`, {
          method: 'POST', headers: internalHeaders, body: JSON.stringify({ paymentId }),
        }).catch(() => {});
        payment.status = 'FAILED';
        payment.failureReason = error.code || 'DEBIT_FAILED';
        payment.completedAt = new Date();
        await payment.save();
        throw error;
      }
      throw Object.assign(new Error('Đang tiếp tục xử lý yêu cầu thanh toán. Hãy mở lại giao dịch sau ít phút.'), {
        status: 503, code: 'SAGA_RETRY_REQUIRED',
      });
    }
  }

  if (payment.status === 'DEBITED') {
    try {
      await request(`${TUITION}/internal/invoices/${payment.studentCode}/settle`, {
        method: 'POST', headers: internalHeaders, body: JSON.stringify({ paymentId }),
      });
    } catch (error) {
      if (error.status >= 500 || !error.status) {
        throw Object.assign(new Error('Đang chờ dịch vụ học phí xác nhận. Hãy tải lại giao dịch sau ít phút.'), {
          status: 503, code: 'SAGA_RETRY_REQUIRED',
        });
      }
      await request(`${AUTH}/internal/accounts/${payment.payerId}/credit`, {
        method: 'POST', headers: internalHeaders,
        body: JSON.stringify({ operationId: `compensate:${paymentId}`, amount: payment.amount }),
      });
      await request(`${TUITION}/internal/invoices/${payment.studentCode}/release`, {
        method: 'POST', headers: internalHeaders, body: JSON.stringify({ paymentId }),
      }).catch(() => {});
      payment.status = 'FAILED';
      payment.failureReason = 'TUITION_SETTLEMENT_REJECTED';
      payment.completedAt = new Date();
      await payment.save();
      throw error;
    }
    payment.status = 'SUCCEEDED';
    payment.completedAt = new Date();
    await payment.save();
    await Outbox.updateOne({ paymentId }, {
      $setOnInsert: { paymentId, status: 'PENDING', attempts: 0, nextAttemptAt: new Date() },
    }, { upsert: true });
  }
  return payment;
}

app.post('/payments/confirm', requireAuth, asyncRoute(async (req, res) => {
  const input = z.object({ email: emailSchema, transactionId: transactionIdSchema }).parse(req.body);
  const payment = await Payment.findOne({ _id: input.transactionId, payerId: req.user.sub });
  if (!payment) throw Object.assign(new Error('Không tìm thấy giao dịch.'), { status: 404 });
  if (payment.payerEmail?.toLowerCase() !== input.email.toLowerCase()) {
    throw Object.assign(new Error('Email không trùng với email OTP của giao dịch.'), { status: 400, code: 'OTP_EMAIL_MISMATCH' });
  }
  if (payment.status === 'SUCCEEDED') return ok(res, { payment: publicPayment(payment), replayed: true });
  if (!['OTP_VERIFIED', 'DEBITED'].includes(payment.status)) {
    throw Object.assign(new Error('Cần xác thực OTP hợp lệ trước khi xác nhận thanh toán.'), { status: 409, code: 'OTP_REQUIRED' });
  }
  const result = await continueSaga(payment);
  ok(res, { payment: publicPayment(result), replayed: false });
}));

app.get('/payments/history', requireAuth, asyncRoute(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const [items, total] = await Promise.all([
    Payment.find({ payerId: req.user.sub }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Payment.countDocuments({ payerId: req.user.sub }),
  ]);
  ok(res, { items: items.map(publicPayment), page, limit, total });
}));

app.get('/payments/:id', requireAuth, asyncRoute(async (req, res) => {
  const payment = await Payment.findOne({ _id: req.params.id, payerId: req.user.sub });
  if (!payment) throw Object.assign(new Error('Không tìm thấy giao dịch.'), { status: 404 });
  if (payment.status === 'DEBITED') await continueSaga(payment);
  ok(res, { payment: publicPayment(payment) });
}));

app.get('/internal/payments/:id', requireService, asyncRoute(async (req, res) => {
  const payment = await Payment.findById(req.params.id);
  if (!payment) throw Object.assign(new Error('Không tìm thấy giao dịch.'), { status: 404 });
  ok(res, { payment: publicPayment(payment) });
}));

async function recoverSagas() {
  const pending = await Payment.find({ status: { $in: ['OTP_VERIFIED', 'DEBITED'] } }).limit(20);
  for (const payment of pending) {
    try { await continueSaga(payment); } catch (error) { console.error('Saga recovery deferred:', payment.id, error.message); }
  }
}

async function expireOtpPayments() {
  const expired = await Payment.find({ status: 'OTP_PENDING', otpExpiresAt: { $lte: new Date() } }).limit(50);
  for (const payment of expired) await cancelPayment(payment, 'OTP_EXPIRED');
  const cancelling = await Payment.find({ status: 'CANCELLING' }).limit(50);
  for (const payment of cancelling) await cancelPayment(payment, payment.failureReason || 'OTP_CANCELLED');
}

async function ensureReceiptJobs() {
  const completed = await Payment.find({ status: 'SUCCEEDED' }).select('_id').sort({ completedAt: -1 }).limit(500);
  for (const payment of completed) {
    await Outbox.updateOne({ paymentId: String(payment._id) }, {
      $setOnInsert: { paymentId: String(payment._id), status: 'PENDING', attempts: 0, nextAttemptAt: new Date() },
    }, { upsert: true });
  }
}

async function processReceipts() {
  await Outbox.updateMany({ status: 'SENDING', updatedAt: { $lt: new Date(Date.now() - 60000) } }, { $set: { status: 'PENDING' } });
  const job = await Outbox.findOneAndUpdate({ status: 'PENDING', nextAttemptAt: { $lte: new Date() } }, {
    $set: { status: 'SENDING' },
  }, { new: true, sort: { createdAt: 1 } });
  if (!job) return;
  try {
    const payment = await Payment.findById(job.paymentId);
    if (!payment || payment.status !== 'SUCCEEDED') {
      await Outbox.updateOne({ _id: job._id }, { $set: { status: 'SKIPPED', sentAt: new Date(), lastError: 'No completed payment.' } });
      return;
    }
    const result = await request(`${NOTICE}/internal/receipt`, {
      method: 'POST', headers: internalHeaders,
      body: JSON.stringify({
        email: payment.payerEmail, payerName: payment.payerName, transactionCode: payment.transactionCode,
        studentCode: payment.studentCode, studentName: payment.studentName, amount: payment.amount,
        balanceRemaining: payment.balanceRemaining,
        completedAt: payment.completedAt?.toISOString(),
      }),
    });
    await Outbox.updateOne({ _id: job._id }, {
      $set: { status: result.sent ? 'SENT' : 'SKIPPED', sentAt: new Date(), lastError: result.sent ? null : 'Demo mode: receipt email was not sent.' },
    });
  } catch (error) {
    const attempts = job.attempts + 1;
    await Outbox.updateOne({ _id: job._id }, {
      $set: { status: 'PENDING', attempts, nextAttemptAt: new Date(Date.now() + Math.min(300000, 1000 * 2 ** attempts)), lastError: error.message },
    });
  }
}

function publicPayment(payment) {
  return {
    id: payment.id, transactionCode: payment.transactionCode, payerName: payment.payerName,
    payerEmail: payment.payerEmail, studentCode: payment.studentCode, studentName: payment.studentName,
    faculty: payment.faculty, major: payment.major, amount: payment.amount, status: payment.status,
    failureReason: payment.failureReason, createdAt: payment.createdAt, completedAt: payment.completedAt,
    otpExpiresAt: payment.otpExpiresAt, otpResendAvailableAt: payment.otpResendAvailableAt,
    balanceRemaining: payment.balanceRemaining,
  };
}

app.use(errorHandler);
const port = Number(process.env.PAYMENT_PORT || 4003);
connectDb(process.env.PAYMENT_DB || 'ibanking_payment').then(() => {
  app.listen(port, () => console.log(`Payment Service :${port}`));
  setInterval(() => {
    recoverSagas().catch((error) => console.error('Saga worker error', error));
    expireOtpPayments().catch((error) => console.error('OTP expiry worker error', error));
    ensureReceiptJobs().then(processReceipts).catch((error) => console.error('Outbox worker error', error));
  }, 3000);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

