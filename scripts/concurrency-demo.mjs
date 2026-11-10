import assert from 'node:assert/strict';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const base=process.env.TEST_BASE_URL||'http://127.0.0.1:4000';
const password=process.env.DEMO_PASSWORD||'Midterm2026!';
const rl=createInterface({input:stdin,output:stdout});
async function request(path,{method='GET',cookie,body}={}){const response=await fetch(`${base}/api${path}`,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const payload=await response.json().catch(()=>({}));return{status:response.status,payload};}
// The gateway intentionally does not expose its HttpOnly JWT to JSON. Use a cookie jar for this CLI.
async function session(username){const response=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});assert.equal(response.status,200,`Login failed for ${username}`);return response.headers.getSetCookie()[0].split(';')[0];}
async function create(cookie,studentCode){const r=await request('/payments',{method:'POST',cookie,body:{studentCode,termsAccepted:true,idempotencyKey:crypto.randomUUID()}});return r;}
async function askOtp(label){const otp=(await rl.question(`Mở email cho ${label}, nhập OTP: `)).trim();assert.match(otp,/^\d{6}$/,'OTP phải gồm đúng 6 chữ số');return otp;}
async function verify(cookie,payment,otp){return request(`/payments/${payment.id}/verify-otp`,{method:'POST',cookie,body:{otp}});}
async function terminal(cookie,id){for(let i=0;i<30;i++){const r=await request(`/payments/${id}`,{cookie});const p=r.payload.data?.payment;if(['SUCCEEDED','FAILED'].includes(p?.status))return p;await new Promise(resolve=>setTimeout(resolve,500));}throw new Error(`Giao dịch ${id} chưa kết thúc.`);}

try{
  const payer=await session('demo2');
  const a=await create(payer,'521H0001'),b=await create(payer,'521H0002');assert.equal(a.status,201);assert.equal(b.status,201);
  console.log(`Cùng ví: ${a.payload.data.payment.studentCode} và ${b.payload.data.payment.studentCode} đang chờ OTP.`);
  console.log('Kiểm tra hộp thư người nộp; nhập lần lượt hai mã OTP. Hai giao dịch sẽ được xác nhận gần đồng thời.');
  const otpA=await askOtp('521H0001');const otpB=await askOtp('521H0002');
  await Promise.all([verify(payer,a.payload.data.payment,otpA),verify(payer,b.payload.data.payment,otpB)]);
  const [stateA,stateB]=await Promise.all([terminal(payer,a.payload.data.payment.id),terminal(payer,b.payload.data.payment.id)]);
  assert.equal([stateA,stateB].filter(x=>x.status==='SUCCEEDED').length,1,'Cùng ví chỉ cho phép một giao dịch vượt tổng số dư.');
  const balance=await request('/users/balance',{cookie:payer});assert.ok(balance.payload.data.balance>=0,'Số dư không được âm.');
  console.log(`Kết quả cùng ví: ${stateA.status} / ${stateB.status}; số dư=${balance.payload.data.balance} VND.`);

  const [demo,demo3]=await Promise.all([session('demo'),session('demo3')]);
  const [invoiceA,invoiceB]=await Promise.all([create(demo,'521H0003'),create(demo3,'521H0003')]);
  assert.equal([invoiceA,invoiceB].filter(x=>x.status===201).length,1,'Cùng hóa đơn chỉ được có một reservation.');
  const winnerIndex=invoiceA.status===201?0:1,winner=winnerIndex===0?invoiceA:invoiceB,winnerCookie=winnerIndex===0?demo:demo3;
  console.log('Cùng MSSV: chỉ một tài khoản giữ được hóa đơn 521H0003. Lấy OTP của tài khoản thắng trong email.');
  const otp=await askOtp('521H0003');const confirmed=await verify(winnerCookie,winner.payload.data.payment,otp);assert.equal(confirmed.status,200);
  const invoice=await request('/tuition/521H0003',{cookie:payer});assert.equal(invoice.payload.data.invoice.status,'PAID');
  console.log('Concurrency demo passed: chỉ một debit cho cùng ví, chỉ một payment cho cùng MSSV, balance không âm.');
}finally{rl.close();}
