import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  transactionId: { type: String, unique: true, required: true, index: true },
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  fullName: { type: String, required: true },
  transactionCode: { type: String, required: true },
  studentCode: { type: String, required: true },
  studentName: { type: String, required: true },
  amount: { type: Number, required: true },
  otpHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  purgeAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
  verified: { type: Boolean, default: false },
  used: { type: Boolean, default: false },
  usedAt: Date,
  resendCount: { type: Number, default: 0 },
  lastSentAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0, name: 'otp_purge_ttl' });
schema.index({ transactionId: 1, email: 1, used: 1 });
export const Otp = mongoose.model('Otp', schema);
