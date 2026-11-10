import nodemailer from 'nodemailer';
import { otpEmail, receiptEmail } from './emailTemplates.js';

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value || '');
const senderAddress = (value) => value.match(/<([^>]+)>/)?.[1]?.trim() || value.trim();

export function resolveEmailConfig(env = process.env) {
  const host = (env.SMTP_HOST || '').trim();
  const username = (env.SMTP_USER || '').trim();
  const password = (env.SMTP_PASS || '').replace(/\s/g, '');
  const from = (env.MAIL_FROM || '').trim();
  const port = Number(env.SMTP_PORT || 465);
  const secureText = String(env.SMTP_SECURE ?? (port === 465)).toLowerCase();
  const supplied = [host, username, password, from].filter(Boolean).length;

  if (!supplied) return { mode: 'DISABLED' };
  if (supplied !== 4 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Cấu hình SMTP chưa đầy đủ hoặc SMTP_PORT không hợp lệ.');
  }
  if (host !== 'smtp.gmail.com') throw new Error('SMTP_HOST phải là smtp.gmail.com cho cấu hình Gmail này.');
  if (!isEmail(username) || !isEmail(senderAddress(from))) {
    throw new Error('SMTP_USER và MAIL_FROM phải là địa chỉ email hợp lệ.');
  }
  if (senderAddress(from).toLowerCase() !== username.toLowerCase()) {
    throw new Error('Địa chỉ trong MAIL_FROM phải trùng với SMTP_USER.');
  }
  if (!['true', 'false'].includes(secureText)) throw new Error('SMTP_SECURE phải là true hoặc false.');
  const secure = secureText === 'true';
  if (port === 465 && !secure) throw new Error('Gmail port 465 yêu cầu SMTP_SECURE=true.');
  if (port === 587 && secure) throw new Error('Gmail port 587 yêu cầu SMTP_SECURE=false (STARTTLS).');
  return { mode: 'SMTP', host, port, secure, username, password, from };
}

export async function createEmailService(env = process.env, logger = console) {
  const config = resolveEmailConfig(env);
  if (config.mode === 'DISABLED') {
    logger.warn('[notification] Gmail SMTP chưa cấu hình; gửi OTP và biên nhận sẽ trả 503.');
    const unavailable = async () => {
      throw Object.assign(new Error('Gmail SMTP chưa được cấu hình. Hãy cấu hình .env để gửi email thật.'), {
        status: 503,
        code: 'EMAIL_UNAVAILABLE',
      });
    };
    return { mode: 'DISABLED', sendOtp: unavailable, sendReceipt: unavailable, close: () => {} };
  }

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: config.password },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    tls: { minVersion: 'TLSv1.2' },
  });
  try {
    await transport.verify();
  } catch (error) {
    logger.error(`[notification] Gmail SMTP verify thất bại (${error.code || 'SMTP_ERROR'}). Kiểm tra .env.`);
    transport.close();
    throw new Error('Không xác thực được Gmail SMTP. Kiểm tra SMTP_USER và Google App Password trong .env.');
  }
  logger.info(`[notification] Gmail SMTP đã xác thực: ${config.host}:${config.port}.`);

  async function deliver(to, message) {
    try {
      const result = await transport.sendMail({ from: config.from, to, ...message });
      return { delivery: 'SMTP', sent: true, messageId: result.messageId };
    } catch {
      throw Object.assign(new Error('Không gửi được email qua Gmail. Hãy kiểm tra kết nối hoặc thử lại.'), {
        status: 503,
        code: 'EMAIL_UNAVAILABLE',
      });
    }
  }

  return {
    mode: 'SMTP',
    sendOtp: (data) => deliver(data.to, otpEmail(data)),
    sendReceipt: (data) => deliver(data.to, receiptEmail(data)),
    close: () => transport.close(),
  };
}
