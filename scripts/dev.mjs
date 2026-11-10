import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
dotenv.config({ path: envPath, quiet: true });

const ports = [
  { name: 'web', key: 'FRONTEND_PORT', fallback: 5173 },
  { name: 'gateway', key: 'GATEWAY_PORT', fallback: 4000 },
  { name: 'auth', key: 'AUTH_PORT', fallback: 4001 },
  { name: 'tuition', key: 'TUITION_PORT', fallback: 4002 },
  { name: 'payment', key: 'PAYMENT_PORT', fallback: 4003 },
  { name: 'notification', key: 'NOTIFICATION_PORT', fallback: 4004 },
].map((entry) => ({ ...entry, port: Number(process.env[entry.key] || entry.fallback) }));

const upstreams = [
  ['AUTH_URL', 'AUTH_PORT', 4001],
  ['TUITION_URL', 'TUITION_PORT', 4002],
  ['PAYMENT_URL', 'PAYMENT_PORT', 4003],
  ['NOTIFICATION_URL', 'NOTIFICATION_PORT', 4004],
];

for (const { name, port } of ports) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[dev] Port không hợp lệ cho ${name}: ${port}`);
    process.exit(1);
  }
}

const duplicatePorts = ports.filter((entry, index) => ports.findIndex((item) => item.port === entry.port) !== index);
if (duplicatePorts.length) {
  console.error(`[dev] Có cấu hình trùng port: ${duplicatePorts.map(({ name, port }) => `${name}=${port}`).join(', ')}`);
  process.exit(1);
}

for (const [urlKey, portKey, fallback] of upstreams) {
  const configuredPort = Number(process.env[portKey] || fallback);
  const url = process.env[urlKey];
  if (!url) continue;
  let upstreamPort;
  try {
    upstreamPort = Number(new URL(url).port || (url.startsWith('https:') ? 443 : 80));
  } catch {
    console.error(`[dev] ${urlKey} không phải URL hợp lệ: ${url}`);
    process.exit(1);
  }
  if (upstreamPort !== configuredPort) {
    console.error(`[dev] ${urlKey} trỏ tới port ${upstreamPort}, nhưng ${portKey}=${configuredPort}. Hãy đồng bộ cấu hình trước khi chạy.`);
    process.exit(1);
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (error) => resolve({ free: false, error }));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve({ free: true })));
  });
}

for (const { name, port } of ports) {
  const result = await portIsFree(port);
  if (!result.free) {
    console.error(`[dev] Port ${port} (${name}) đang được tiến trình khác sử dụng (${result.error.code}).`);
    console.error(`[dev] Kiểm tra tiến trình bằng: netstat -ano | findstr :${port}`);
    console.error('[dev] Dừng phiên iBanking cũ bằng Ctrl+C trong đúng terminal của phiên đó, rồi chạy lại npm run dev.');
    process.exit(1);
  }
}

const viteCli = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const serviceDefinitions = [
  { name: 'web', cwd: path.join(root, 'frontend'), args: [viteCli, '--host', '127.0.0.1', '--port', String(ports[0].port), '--strictPort'] },
  { name: 'gateway', cwd: path.join(root, 'backend', 'api-gateway'), args: [path.join(root, 'backend', 'api-gateway', 'src', 'server.js')] },
  { name: 'auth', cwd: path.join(root, 'backend', 'auth-service'), args: [path.join(root, 'backend', 'auth-service', 'src', 'server.js')] },
  { name: 'tuition', cwd: path.join(root, 'backend', 'tuition-service'), args: [path.join(root, 'backend', 'tuition-service', 'src', 'server.js')] },
  { name: 'payment', cwd: path.join(root, 'backend', 'payment-service'), args: [path.join(root, 'backend', 'payment-service', 'src', 'server.js')] },
  { name: 'notification', cwd: path.join(root, 'backend', 'notification-service'), args: [path.join(root, 'backend', 'notification-service', 'src', 'server.js')] },
];

const children = new Set();
let stopping = false;
let shutdownTimer;

function pipeOutput(name, stream, target) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (pending + chunk).split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) target.write(`[${name}] ${line}\n`);
  });
  stream.on('end', () => { if (pending) target.write(`[${name}] ${pending}\n`); });
}

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  clearTimeout(shutdownTimer);
  for (const child of children) if (child.exitCode === null) child.kill('SIGINT');
  shutdownTimer = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  }, 4000);
  shutdownTimer.unref();
  if (children.size === 0) {
    clearTimeout(shutdownTimer);
  }
}

process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });

for (const definition of serviceDefinitions) {
  const child = spawn(process.execPath, definition.args, {
    cwd: definition.cwd,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  pipeOutput(definition.name, child.stdout, process.stdout);
  pipeOutput(definition.name, child.stderr, process.stderr);
  child.once('error', (error) => {
    console.error(`[${definition.name}] Không khởi chạy được: ${error.message}`);
    void shutdown(1);
  });
  child.once('close', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`[${definition.name}] Dừng ngoài dự kiến (code=${code}, signal=${signal}); đang dừng các service còn lại.`);
      void shutdown(code || 1);
    }
    if (stopping && children.size === 0) {
      clearTimeout(shutdownTimer);
    }
  });
}

console.log('[dev] Đã khởi chạy mỗi tiến trình đúng một lần. Nhấn Ctrl+C để dừng toàn bộ stack.');
console.log(`[dev] Giao diện: http://127.0.0.1:${ports[0].port} | Gateway: http://127.0.0.1:${ports[1].port}`);
