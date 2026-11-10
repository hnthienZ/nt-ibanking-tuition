import mongoose from 'mongoose';import {connectDb} from '@ibanking/shared';import {Payment} from './models/Payment.js';
await connectDb(process.env.PAYMENT_DB||'ibanking_payment');await Payment.deleteMany({});console.log('Cleared demo payment history and idempotency keys.');await mongoose.disconnect();
