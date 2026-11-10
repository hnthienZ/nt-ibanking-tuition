import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env') });

export async function connectDb(name) {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not configured');
  await mongoose.connect(uri, { dbName: name, serverSelectionTimeoutMS: 5000 });
  console.log(`[${name}] MongoDB connected`);
}

export const signToken = (user) => jwt.sign({ sub: String(user._id), username: user.username }, process.env.JWT_SECRET, { expiresIn: '8h', issuer: 'ibanking-auth' });
export function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Vui lòng đăng nhập.' } });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'ibanking-auth' }); next(); }
  catch { return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' } }); }
}
export function errorHandler(err, req, res, next) {
  const code = err.status || (err.name === 'ZodError' ? 400 : err.code === 11000 ? 409 : 500);
  const errorCode = err.code === 11000 ? 'DUPLICATE_RESOURCE' : err.name === 'ZodError' ? 'VALIDATION_ERROR' : err.code || 'INTERNAL_ERROR';
  if (code >= 500) console.error(`[${req.method} ${req.originalUrl}]`, err);
  else console.info(`[${req.method} ${req.originalUrl}] ${errorCode}: ${err.message}`);
  res.status(code).json({ success: false, error: { code: errorCode, message: code === 500 ? 'Hệ thống đang gặp sự cố. Vui lòng thử lại.' : err.message } });
}
export function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
export async function internalRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', 'x-service-token': process.env.JWT_SECRET, ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const e = new Error(body.error?.message || 'Internal service error'); e.status = response.status; e.code = body.error?.code; throw e; }
  return body.data;
}
export function requireService(req, res, next) {
  if (req.headers['x-service-token'] !== process.env.JWT_SECRET) return res.status(403).json({ success: false, error: { code: 'SERVICE_FORBIDDEN', message: 'Internal service access only.' } });
  next();
}
export const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
export const money = (amount) => new Intl.NumberFormat('vi-VN').format(amount) + ' ₫';
