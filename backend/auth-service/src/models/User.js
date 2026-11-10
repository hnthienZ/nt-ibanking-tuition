import mongoose from 'mongoose';
const userSchema = new mongoose.Schema({ username: { type: String, unique: true, required: true, lowercase: true }, passwordHash: { type: String, required: true }, fullName: { type: String, required: true }, phone: { type: String, required: true }, email: { type: String, required: true }, balance: { type: Number, required: true, min: 0, default: 0 } }, { timestamps: true });
export const User = mongoose.model('User', userSchema);
const accountOperationSchema = new mongoose.Schema({ operationId: { type: String, unique: true }, userId: { type: mongoose.Schema.Types.ObjectId, required: true }, type: { type: String, enum: ['DEBIT', 'CREDIT'], required: true }, amount: { type: Number, required: true }, balanceAfter: { type: Number, min: 0 }, createdAt: { type: Date, default: Date.now } });
export const AccountOperation = mongoose.model('AccountOperation', accountOperationSchema);
