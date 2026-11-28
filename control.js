#!/usr/bin/env node
'use strict';
// One-command manager for QR Bridge:  node control.js <start|stop|restart|status>
//   start    installs dependencies if needed, launches the server in the background, waits until it
//            answers, prints the addresses and opens the viewer in your browser
//   stop     shuts the background server down
//   restart  stop + start
//   status   shows whether it is running and where
// Options: --no-open (don't open the browser), --force (stop: kill the PID even if it doesn't look like us)
// Environment: PORT (default 8443)

const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const PID_FILE = path.join(ROOT, '.qr-bridge.pid');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
const PORT = Number(process.env.PORT) || 8443;
const IS_WIN = process.platform === 'win32';
const REQUIRED_DEPS = ['express', 'ws', 'selfsigned', 'jsqr', 'zxing-wasm', 'qrcode-generator'];

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('--')) || 'help';
const noOpen = args.includes('--no-open') || !!process.env.NO_OPEN;
const force = args.includes('--force');

const say = (m = '') => console.log(m);
const fail = (m) => { console.error(`\nERROR: ${m}\n`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- helpers ---------- */
function readPidFile() {
  try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch { return null; }
}
function removePidFile() { try { fs.rmSync(PID_FILE, { force: true }); } catch {} }

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function portOpen(port, timeout = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(!(e.code === 'EADDRINUSE' || e.code === 'EACCES')));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '0.0.0.0');
  });
}

// Is the thing answering on this port really QR Bridge?
function isOurServer(port) {
  return new Promise((resolve) => {
    const req = https.get({ host: '127.0.0.1', port, path: '/api/info', rejectUnauthorized: false, timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
      res.on('end', () => { try { resolve(Array.isArray(JSON.parse(body).phoneUrls)); } catch { resolve(false); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function ipRank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && m[1] >= 16 && m[1] <= 31) return 2;
  return 3;
}
function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) out.push(i.address);
  }
  return out.sort((a, b) => ipRank(a) - ipRank(b));
}

function printUrls(port) {
  say('  Viewer (open on this computer):');
  say(`    https://localhost:${port}/`);
  say('  Phone (same Wi-Fi):');
  const ips = lanIPs();
  if (!ips.length) say('    (no LAN IP detected)');
  ips.forEach((ip) => say(`    https://${ip}:${port}/phone.html`));
  say('  The first visit shows a certificate warning (self-signed): choose "Advanced -> Proceed".');
}

function openBrowser(port) {
  const url = `https://localhost:${port}/`;
  try {
    let child;
    if (IS_WIN) child = spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    else if (process.platform === 'darwin') child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    else child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

function logTail(n = 25) {
  try { return fs.readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return '(no log)'; }
}

/* ---------- dependencies ---------- */
function depsMissing() {
  const nm = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(nm)) return true;
  if (REQUIRED_DEPS.some((d) => !fs.existsSync(path.join(nm, d)))) return true;
  try {   // package.json changed since the last install
    const lock = path.join(nm, '.package-lock.json');
    if (fs.existsSync(lock) && fs.statSync(path.join(ROOT, 'package.json')).mtimeMs > fs.statSync(lock).mtimeMs) return true;
  } catch {}
  return false;
}

function ensureDeps() {
  if (!depsMissing()) return;
  say('Installing dependencies (first run only)…');
  const r = spawnSync(IS_WIN ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: IS_WIN });
  if (r.error) fail('npm was not found. Install Node.js (it includes npm) from https://nodejs.org/ and try again.');
  if (r.status !== 0) fail('npm install failed. Check your internet connection and the messages above, then try again.');
}

/* ---------- commands ---------- */
async function start() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) fail(`Node.js 18 or newer is required (found ${process.versions.node}). Get it from https://nodejs.org/`);

  const info = readPidFile();
  if (info && alive(info.pid) && (await isOurServer(info.port))) {
    say(`QR Bridge is already running (pid ${info.pid}).\n`);
    printUrls(info.port);
    if (!noOpen) openBrowser(info.port);
    return;
  }
  if (info) removePidFile();   // stale

  ensureDeps();

  if (!(await portFree(PORT))) {
    fail(`Port ${PORT} is already in use by another program.\nStop that program, or pick another port:\n  macOS/Linux:  PORT=9443 ./start.sh\n  Windows:      set PORT=9443 && start.bat`);
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  try { if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch {}
  const out = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(out, `\n--- ${new Date().toISOString()} starting on port ${PORT} ---\n`);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: { ...process.env, PORT: String(PORT) },
  });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', (e) => { exited = { code: -1, signal: e.message }; });
  child.unref();
  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, port: PORT, startedAt: new Date().toISOString() }));

  process.stdout.write('Starting QR Bridge');
  const deadline = Date.now() + 30000;   // first start generates the TLS certificate, which can take a few seconds
  let ready = false;
  while (Date.now() < deadline) {
    if (exited) break;
    if ((await portOpen(PORT)) && (await isOurServer(PORT))) { ready = true; break; }
    process.stdout.write('.');
    await sleep(400);
  }
  say('');

  if (!ready) {
    removePidFile();
    if (!exited) { try { process.kill(child.pid); } catch {} }
    fail(`The server did not start (${exited ? `exited: ${exited.code ?? exited.signal}` : 'timed out'}).\nLast log lines:\n${logTail()}`);
  }

  say(`\nQR Bridge is running (pid ${child.pid}).\n`);
  printUrls(PORT);
  say(`\n  Log file:  ${LOG_FILE}`);
  say('  Stop with: stop.bat (Windows) / ./stop.sh (macOS, Linux) / npm run down');
  if (!noOpen) openBrowser(PORT);
}

async function stop() {
  const info = readPidFile();
  if (!info) { say('QR Bridge is not running (no PID file).'); return false; }
  if (!alive(info.pid)) { removePidFile(); say('QR Bridge is not running (stale PID file removed).'); return false; }
  if (!force && !(await isOurServer(info.port))) {
    removePidFile();
    say(`Process ${info.pid} is alive but is not answering as QR Bridge on port ${info.port}.\nLeaving it alone and removing the stale PID file. (Use "stop --force" to kill it anyway.)`);
    return false;
  }

  if (IS_WIN) spawnSync('taskkill', ['/PID', String(info.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(info.pid, 'SIGTERM'); } catch {} }

  for (let i = 0; i < 20 && alive(info.pid); i++) await sleep(300);
  if (alive(info.pid) && !IS_WIN) { try { process.kill(info.pid, 'SIGKILL'); } catch {} await sleep(300); }

  if (alive(info.pid)) fail(`Could not stop process ${info.pid}. Close it manually.`);
  removePidFile();
  say('QR Bridge stopped.');
  return true;
}

async function status() {
  const info = readPidFile();
  if (info && alive(info.pid) && (await isOurServer(info.port))) {
    say(`QR Bridge is running (pid ${info.pid}, since ${info.startedAt}).\n`);
    printUrls(info.port);
    say(`\n  Log file:  ${LOG_FILE}`);
  } else {
    say('QR Bridge is not running.');
    process.exitCode = 1;
  }
}

function help() {
  say(`QR Bridge manager

  node control.js start      install dependencies if needed, start in the background, open the viewer
  node control.js stop       stop the background server
  node control.js restart    stop, then start
  node control.js status     show whether it is running

  Options:  --no-open   don't open the browser     --force   (stop) kill the PID even if it doesn't look like QR Bridge
  Env:      PORT=9443   use another port`);
}

(async () => {
  switch (command) {
    case 'start': await start(); break;
    case 'stop': await stop(); break;
    case 'restart': await stop(); await start(); break;
    case 'status': await status(); break;
    default: help();
  }
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
