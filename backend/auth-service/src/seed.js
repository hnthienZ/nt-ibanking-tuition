import mongoose from 'mongoose';import bcrypt from 'bcryptjs';import {connectDb} from '@ibanking/shared';import {User,AccountOperation} from './models/User.js';
await connectDb(process.env.AUTH_DB||'ibanking_auth');
const rows=[['demo','Nguyễn Minh Anh','0901234567',process.env.DEMO_EMAIL||'demo@example.com',30000000],['demo2','Lê Thanh Bình','0912345678',process.env.DEMO2_EMAIL||'demo2@example.com',30000000],['demo3','Trần Gia Huy','0987654321',process.env.DEMO3_EMAIL||'demo3@example.com',5000000]];const passwordHash=await bcrypt.hash('Midterm2026!',12);
for(const [username,fullName,phone,email,balance]of rows)await User.findOneAndUpdate({username},{username,passwordHash,fullName,phone,email,balance},{upsert:true,new:true,setDefaultsOnInsert:true});
await AccountOperation.deleteMany({});console.log(`Seeded ${rows.length} demo users (password: Midterm2026!).`);await mongoose.disconnect();
