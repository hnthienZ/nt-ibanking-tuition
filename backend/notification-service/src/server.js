import express from 'express';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { asyncRoute, connectDb, errorHandler, ok, requireService } from '@ibanking/shared';
import { Otp } from './models/Otp.js';
import { createEmailService } from './emailService.js';

const app = express();
app.use(express.json());
const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_RESENDS = 3;
const pepper = process.env.OTP_PEPPER || process.env.JWT_SECRET;
const transactionIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Mã giao dịch không hợp lệ.');
const createOtpSchema = z.object({
  transactionId: transactionIdSchema,
  email: z.string().trim().email(),
  fullName: z.string().min(1),
  transactionCode: z.string().min(1),
  studentCode: z.string().min(1),
  studentName: z.string().min(1),
  amount: z.number().int().positive(),
});
let emailService;

if (!pepper) throw new Error('OTP_PEPPER hoặc JWT_SECRET phải được cấu hình.');
const hashOtp = (otp) => createHmac('sha256', pepper).update(otp).digest('hex');
const maskEmail = (email) => email.replace(/^(.{2})[^@]*(@.+)$/, '$1***$2');

function serviceError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function otpStatusError(otp, now = new Date()) {
  if (!otp) return serviceError('Không tìm thấy OTP còn hiệu lực cho giao dịch.', 404, 'OTP_NOT_FOUND');
  if (otp.verified || otp.used) return serviceError('OTP đã được xác thực và không thể sử dụng lại.', 409, 'OTP_ALREADY_USED');
  if (otp.expiresAt <= now) return serviceError('OTP đã hết hạn. Hãy yêu cầu gửi lại mã.', 410, 'OTP_EXPIRED');
  if (otp.attempts >= MAX_ATTEMPTS) return serviceError('OTP đã vượt quá số lần nhập sai cho phép.', 429, 'OTP_LOCKED');
  return null;
}

async function sendChallenge(input) {
  let challenge = await Otp.findOne({ transactionId: input.transactionId }).select('+otpHash');
  const now = new Date();
  if (challenge) {
    const stateError = otpStatusError(challenge, now);
    if (stateError) throw stateError;
    if (input.email && input.email.toLowerCase() !== challenge.email) {
      throw serviceError('Email phải trùng với email đã đăng ký cho giao dịch này.', 409, 'OTP_EMAIL_MISMATCH');
    }
    if (challenge.resendCount >= MAX_RESENDS) {
      throw serviceError('Giao dịch đã đạt giới hạn gửi lại OTP.', 429, 'OTP_RESEND_LIMIT');
    }
    const availableAt = new Date(challenge.lastSentAt.getTime() + RESEND_COOLDOWN_MS);
    if (now < availableAt) {
      const waitSeconds = Math.ceil((availableAt.getTime() - now.getTime()) / 1000);
      throw Object.assign(serviceError(`Vui lòng đợi ${waitSeconds} giây trước khi gửi lại OTP.`, 429, 'OTP_RESEND_COOLDOWN'), { retryAfter: waitSeconds });
    }
  } else if (!input.email || !input.fullName || !input.transactionCode || !input.studentCode || !input.studentName || !input.amount) {
    throw serviceError('Thiếu thông tin giao dịch để tạo OTP.', 400, 'OTP_CONTEXT_REQUIRED');
  }

  const code = String(randomInt(100000, 1000000));
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  const data = {
    transactionId: input.transactionId,
    email: input.email?.toLowerCase(),
    fullName: input.fullName,
    transactionCode: input.transactionCode,
    studentCode: input.studentCode,
    studentName: input.studentName,
    amount: input.amount,
    otpHash: hashOtp(code),
    expiresAt,
    purgeAt: expiresAt,
    attempts: 0,
    verified: false,
    used: false,
    usedAt: undefined,
    lastSentAt: now,
  };

  if (challenge) {
    const updated = await Otp.findOneAndUpdate({
      _id: challenge._id,
      otpHash: challenge.otpHash,
      verified: false,
      used: false,
      lastSentAt: { $lte: new Date(now.getTime() - RESEND_COOLDOWN_MS) },
      resendCount: { $lt: MAX_RESENDS },
    }, { $set: data, $inc: { resendCount: 1 } }, { new: true });
    if (!updated) throw serviceError('OTP acaba de cambiar o la solicitud se repitió. Inténtalo de nuevo.', 409, 'OTP_SEND_CONFLICT');
    challenge = updated;
  } else {
    try {
      challenge = await Otp.create({ ...data, resendCount: 0 });
    } catch (error) {
      if (error.code === 11000) throw serviceError('Ya existe un OTP para esta transacción. Espera antes de reenviar.', 409, 'OTP_SEND_CONFLICT');
      throw error;
    }
  }

  let delivery;
  try {
    delivery = await emailService.sendOtp({
      to: challenge.email,
      fullName: challenge.fullName,
      otp: code,
      transactionCode: challenge.transactionCode,
      studentCode: challenge.studentCode,
      studentName: challenge.studentName,
      amount: challenge.amount,
    });
  } catch (error) {
    await Otp.deleteOne({ _id: challenge._id, used: false });
    throw error;
  }

  const response = {
    transactionId: challenge.transactionId,
    emailMasked: maskEmail(challenge.email),
    expiresAt,
    resendAvailableAt: new Date(now.getTime() + RESEND_COOLDOWN_MS),
    delivery: delivery.delivery,
    emailSent: delivery.sent,
    message: 'OTP đã được gửi qua email của tài khoản người nộp tiền.',
  };
  return response;
}

app.get('/health', (req, res) => ok(res, {
  service: 'notification-service',
  status: 'up',
  emailMode: emailService?.mode || 'starting',
}));

app.post('/internal/otp/send', requireService, asyncRoute(async (req, res) => {
  const input = createOtpSchema.parse(req.body);
  ok(res, await sendChallenge(input), 201);
}));

// Kept as an internal alias for older local scripts; both handlers use identical rate limits.
app.post('/internal/otp/create', requireService, asyncRoute(async (req, res) => {
  const input = createOtpSchema.parse(req.body);
  ok(res, await sendChallenge(input), 201);
}));

app.post('/internal/otp/resend', requireService, asyncRoute(async (req, res) => {
  const input = z.object({ transactionId: transactionIdSchema }).parse(req.body);
  ok(res, await sendChallenge(input));
}));

app.post('/internal/otp/verify', requireService, asyncRoute(async (req, res) => {
  const input = z.object({
    transactionId: transactionIdSchema,
    email: z.string().trim().email(),
    otp: z.string().regex(/^\d{6}$/, 'OTP phải gồm đúng 6 chữ số.'),
  }).parse(req.body);
  const challenge = await Otp.findOne({ transactionId: input.transactionId }).select('+otpHash');
  if (challenge?.verified && challenge.used) {
    if (challenge.email !== input.email.toLowerCase()) {
      throw serviceError('OTP không thuộc email của giao dịch này.', 400, 'OTP_EMAIL_MISMATCH');
    }
    const expected = Buffer.from(challenge.otpHash, 'hex');
    const supplied = Buffer.from(hashOtp(input.otp), 'hex');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw serviceError('OTP đã được xác thực và không thể sử dụng lại.', 409, 'OTP_ALREADY_USED');
    }
    ok(res, { transactionId: challenge.transactionId, verified: true, used: true, replayed: true });
    return;
  }
  const stateError = otpStatusError(challenge);
  if (stateError) throw stateError;
  if (challenge.email !== input.email.toLowerCase()) {
    throw serviceError('OTP không thuộc email của giao dịch này.', 400, 'OTP_EMAIL_MISMATCH');
  }

  const expected = Buffer.from(challenge.otpHash, 'hex');
  const supplied = Buffer.from(hashOtp(input.otp), 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    const result = await Otp.updateOne({
      _id: challenge._id,
      otpHash: challenge.otpHash,
      verified: false,
      used: false,
      expiresAt: { $gt: new Date() },
      attempts: { $lt: MAX_ATTEMPTS },
    }, { $inc: { attempts: 1 } });
    if (!result.modifiedCount) {
      const latest = await Otp.findById(challenge._id);
      throw otpStatusError(latest) || serviceError('OTP đã thay đổi. Hãy nhập mã mới nhất.', 409, 'OTP_SEND_CONFLICT');
    }
    const latest = await Otp.findById(challenge._id);
    if (latest?.attempts >= MAX_ATTEMPTS) {
      throw serviceError('OTP đã vượt quá số lần nhập sai cho phép. Giao dịch bị hủy.', 429, 'OTP_LOCKED');
    }
    throw serviceError('OTP không chính xác.', 400, 'OTP_INVALID');
  }

  const verified = await Otp.findOneAndUpdate({
    _id: challenge._id,
    otpHash: challenge.otpHash,
    email: input.email.toLowerCase(),
    verified: false,
    used: false,
    expiresAt: { $gt: new Date() },
    attempts: { $lt: MAX_ATTEMPTS },
  }, { $set: { verified: true, used: true, usedAt: new Date() } }, { new: true });
  if (!verified) {
    const latest = await Otp.findById(challenge._id);
    throw otpStatusError(latest) || serviceError('OTP đã được xác thực ở yêu cầu khác.', 409, 'OTP_ALREADY_USED');
  }
  ok(res, { transactionId: verified.transactionId, verified: true, used: true });
}));

app.post('/internal/receipt', requireService, asyncRoute(async (req, res) => {
  const input = z.object({
    email: z.string().email(), payerName: z.string().min(1), transactionCode: z.string().min(1),
    studentCode: z.string().min(1), studentName: z.string().min(1), amount: z.number().int().positive(),
    balanceRemaining: z.number().int().nonnegative().optional(), completedAt: z.string().optional(),
  }).parse(req.body);
  const delivery = await emailService.sendReceipt({ to: input.email, ...input });
  ok(res, { sent: delivery.sent, delivery: delivery.delivery });
}));

app.use(errorHandler);
const port = Number(process.env.NOTIFICATION_PORT || 4004);
async function start() {
  emailService = await createEmailService();
  await connectDb(process.env.NOTIFICATION_DB || 'ibanking_notification');
  app.listen(port, () => console.log(`Notification Service :${port} (${emailService.mode})`));
}
start().catch((error) => {
  console.error(`[notification] Startup failed: ${error.message}`);
  process.exit(1);
});
