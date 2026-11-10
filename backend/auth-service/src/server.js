import express from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { z } from 'zod';
import { asyncRoute, connectDb, errorHandler, ok, requireAuth, requireService, signToken } from '@ibanking/shared';
import { User, AccountOperation } from './models/User.js';
const app = express(); app.use(express.json());
app.get('/health', (req,res)=>ok(res,{service:'auth-service',status:'up'}));
app.post('/auth/login', asyncRoute(async (req,res)=>{
  const input=z.object({username:z.string().min(1),password:z.string().min(1)}).parse(req.body);
  const user=await User.findOne({username:input.username.toLowerCase()});
  if(!user || !(await bcrypt.compare(input.password,user.passwordHash))) { const e=new Error('Tên đăng nhập hoặc mật khẩu không chính xác.');e.status=401;e.code='INVALID_CREDENTIALS';throw e; }
  ok(res,{token:signToken(user),user:{id:user.id,username:user.username,fullName:user.fullName,email:user.email,phone:user.phone,balance:user.balance}});
}));
app.get('/auth/me',requireAuth,asyncRoute(async(req,res)=>{const user=await User.findById(req.user.sub).select('-passwordHash');if(!user)return res.status(404).json({success:false,error:{code:'USER_NOT_FOUND',message:'Không tìm thấy tài khoản.'}});ok(res,{user});}));
app.get('/users/profile',requireAuth,asyncRoute(async(req,res)=>{const u=await User.findById(req.user.sub).select('username fullName phone email balance');ok(res,{user:u});}));
app.get('/users/balance',requireAuth,asyncRoute(async(req,res)=>{const u=await User.findById(req.user.sub).select('balance');ok(res,{balance:u?.balance??0,currency:'VND'});}));
app.get('/internal/accounts/:userId',requireService,asyncRoute(async(req,res)=>{const user=await User.findById(req.params.userId).select('username fullName phone email balance');if(!user){const e=new Error('Không tìm thấy tài khoản.');e.status=404;throw e;}ok(res,{user});}));
app.post('/internal/accounts/:userId/debit',requireService,asyncRoute(async(req,res)=>{
  const {operationId,amount}=z.object({operationId:z.string().min(1),amount:z.number().int().positive()}).parse(req.body);
  const old=await AccountOperation.findOne({operationId});if(old){const current=await User.findById(req.params.userId);return ok(res,{operationId,balance:old.balanceAfter??current.balance,replayed:true});}
  const session=await mongoose.startSession();
  try { let balance; await session.withTransaction(async()=>{const duplicate=await AccountOperation.findOne({operationId}).session(session);if(duplicate){balance=duplicate.balanceAfter??(await User.findById(req.params.userId).session(session)).balance;return;}const user=await User.findOneAndUpdate({_id:req.params.userId,balance:{$gte:amount}},{$inc:{balance:-amount}},{new:true,session});if(!user){const e=new Error('Số dư khả dụng không đủ.');e.status=409;e.code='INSUFFICIENT_BALANCE';throw e;}await AccountOperation.create([{operationId,userId:user._id,type:'DEBIT',amount,balanceAfter:user.balance}],{session});balance=user.balance;});ok(res,{operationId,balance,replayed:false}); } finally {await session.endSession();}
}));
app.post('/internal/accounts/:userId/credit',requireService,asyncRoute(async(req,res)=>{
  const {operationId,amount}=z.object({operationId:z.string().min(1),amount:z.number().int().positive()}).parse(req.body);
  const session=await mongoose.startSession();let balance;
  try {await session.withTransaction(async()=>{if(await AccountOperation.findOne({operationId}).session(session)){balance=(await User.findById(req.params.userId).session(session)).balance;return;}const user=await User.findByIdAndUpdate(req.params.userId,{$inc:{balance:amount}},{new:true,session});if(!user){const e=new Error('Không tìm thấy tài khoản để hoàn tiền.');e.status=404;throw e;}await AccountOperation.create([{operationId,userId:user._id,type:'CREDIT',amount}],{session});balance=user.balance;});ok(res,{operationId,balance});}finally{await session.endSession();}
}));
app.use(errorHandler);
const port=Number(process.env.AUTH_PORT||4001);connectDb(process.env.AUTH_DB||'ibanking_auth').then(()=>app.listen(port,()=>console.log(`Auth Service :${port}`))).catch(e=>{console.error(e);process.exit(1)});
