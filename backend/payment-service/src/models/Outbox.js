import mongoose from 'mongoose';
export const Outbox=mongoose.model('Outbox',new mongoose.Schema({paymentId:{type:String,unique:true,required:true,index:true},status:{type:String,enum:['PENDING','SENDING','SENT','SKIPPED'],default:'PENDING',index:true},attempts:{type:Number,default:0},nextAttemptAt:{type:Date,default:Date.now},lastError:String,sentAt:Date},{timestamps:true}));

