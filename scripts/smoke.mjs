import assert from 'node:assert/strict';
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:4000';
async function request(path,{method='GET',cookie,body}={}){const response=await fetch(`${base}/api${path}`,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return{response,body:await response.json()};}
const login=await request('/auth/login',{method:'POST',body:{username:'demo2',password:'Midterm2026!'}});assert.equal(login.response.status,200);const cookie=login.response.headers.getSetCookie()[0].split(';')[0];assert.match(login.response.headers.get('set-cookie'),/HttpOnly/);assert.equal(login.body.data.token,undefined);
const profile=await request('/users/profile',{cookie});assert.equal(profile.response.status,200);assert.equal(profile.body.data.user.username,'demo2');
const balance=await request('/users/balance',{cookie});assert.equal(balance.response.status,200);assert.ok(balance.body.data.balance>=0);
const student=await request('/students/521H0004',{cookie});assert.equal(student.response.status,200);assert.equal(student.body.data.student.studentCode,'521H0004');
const tuition=await request('/tuition/521H0004',{cookie});assert.equal(tuition.response.status,200);assert.equal(tuition.body.data.invoice.amount,2000000);
const missing=await request('/students/999X9999',{cookie});assert.equal(missing.response.status,404);
const badLogin=await request('/auth/login',{method:'POST',body:{username:'demo2',password:'wrong'}});assert.equal(badLogin.response.status,401);
const paid=await request('/payments',{method:'POST',cookie,body:{studentCode:'521H0005',termsAccepted:true,idempotencyKey:crypto.randomUUID()}});assert.equal(paid.response.status,409);
const noTerms=await request('/payments',{method:'POST',cookie,body:{studentCode:'521H0004',termsAccepted:false,idempotencyKey:crypto.randomUUID()}});assert.equal(noTerms.response.status,400);
console.log('Smoke check passed: login/cookie, profile, balance, student lookup, missing MSSV, paid invoice and validation.');
