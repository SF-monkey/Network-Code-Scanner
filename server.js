// Local HTTPS server + WebSocket signaling.
// The phone grabs its camera with getUserMedia (browsers require HTTPS) and streams it over WebRTC straight to the viewer page,
// where the video frames are decoded in the browser. The server itself never touches the video.
const express = require('express');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const selfsigned = require('selfsigned');
const qrcode = require('qrcode-generator');

const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 8443;

// ---- System clipboard (works even when the browser tab is in the background) ----
// Only a viewer page opened on THIS machine (loopback connection) may use it, so other
// devices on the Wi-Fi can never overwrite your clipboard.
const isLoopback = (a = '') => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

function clipboardTools() {
  if (process.platform === 'win32') {
    return [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::InputEncoding=[System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())']]];
  }
  if (process.platform === 'darwin') return [['pbcopy', []]];
  return [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
}

function runClipboardTool(cmd, args, text) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      env: { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' },
    });
    let done = false;
    const finish = (err) => { if (!done) { done = true; err ? reject(err) : resolve(cmd); } };
    child.on('error', finish);
    // 'exit', not 'close': xclip / wl-copy keep serving the selection from a background process
    child.on('exit', (code) => finish(code === 0 ? null : new Error(`${cmd} exited with code ${code}`)));
    child.stdin.on('error', () => {});
    child.stdin.end(text, 'utf8');
  });
}

async function copyToClipboard(text) {
  let lastErr = null;
  for (const [cmd, args] of clipboardTools()) {
    try { return await runClipboardTool(cmd, args, text); }
    catch (e) { lastErr = e; if (e.code !== 'ENOENT') break; }
  }
  if (lastErr && lastErr.code === 'ENOENT' && process.platform !== 'win32' && process.platform !== 'darwin') {
    throw new Error('no clipboard tool found (install xclip, xsel or wl-clipboard)');
  }
  throw lastErr || new Error('clipboard unavailable');
}

// Most likely phone-reachable address first (home/office LAN ranges), link-local ones dropped
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
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) out.push(i.address);
    }
  }
  return out.sort((a, b) => ipRank(a) - ipRank(b));
}

// Crisp scalable QR code (always black on white so phone cameras read it reliably)
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const size = n + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

async function loadCert(ips) {
  const dir = path.join(__dirname, 'cert');
  const keyF = path.join(dir, 'key.pem');
  const certF = path.join(dir, 'cert.pem');
  const ipF = path.join(dir, 'ips.json');
  const tag = JSON.stringify(ips);
  if ([keyF, certF, ipF].every(fs.existsSync) && fs.readFileSync(ipF, 'utf8') === tag) {
    return { key: fs.readFileSync(keyF), cert: fs.readFileSync(certF) };
  }
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = await Promise.resolve(
    selfsigned.generate([{ name: 'commonName', value: 'qr-bridge.local' }], {
      days: 825,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames }],
    })
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyF, pems.private);
  fs.writeFileSync(certF, pems.cert);
  fs.writeFileSync(ipF, tag);
  return { key: pems.private, cert: pems.cert };
}

(async () => {
  const ips = lanIPs();
  const creds = await loadCert(ips);

  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/vendor/jsQR.js', (_req, res) => res.sendFile(require.resolve('jsqr')));
  // ZXing (zxing-wasm): multi-format barcode decoding, served locally so it works offline on the LAN
  const zx = path.join(__dirname, 'node_modules', 'zxing-wasm', 'dist');
  app.get('/vendor/zxing/reader.js', (_req, res) => res.sendFile(path.join(zx, 'iife', 'reader', 'index.js')));
  app.get('/vendor/zxing/zxing_reader.wasm', (_req, res) => {
    res.type('application/wasm');
    res.sendFile(path.join(zx, 'reader', 'zxing_reader.wasm'));
  });
  const phoneUrls = ips.map((ip) => `https://${ip}:${PORT}/phone.html`);
  app.get('/api/info', (_req, res) => res.json({ phoneUrls }));
  // QR code for the i-th phone URL (index only, so it can't be used to encode arbitrary text)
  app.get('/api/qr/:i.svg', (req, res) => {
    const i = Number(req.params.i);
    if (!Number.isInteger(i) || i < 0 || i >= phoneUrls.length) return res.sendStatus(404);
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(qrSvg(phoneUrls[i]));
  });

  const server = https.createServer(creds, app);
  const wss = new WebSocketServer({ server });

  // ---- Signaling: phones and viewers discover each other; offer / answer / candidate are relayed ----
  const clients = new Map();
  let nextId = 1;
  const RELAY = new Set(['offer', 'answer', 'candidate']);
  const send = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));

  wss.on('connection', (ws, req) => {
    ws.isLocal = isLoopback(req.socket.remoteAddress);
    ws.id = String(nextId++);
    ws.role = null;
    ws.isAlive = true;
    clients.set(ws.id, ws);
    ws.on('pong', () => (ws.isAlive = true));

    ws.on('message', (raw, isBinary) => {
      // Compatibility mode: phones send JPEG frames over WebSocket; prepend a 4-byte phone id and forward to all viewers
      if (isBinary) {
        if (ws.role !== 'phone') return;
        const head = Buffer.alloc(4);
        head.writeUInt32BE(Number(ws.id));
        const out = Buffer.concat([head, raw]);
        for (const c of clients.values()) {
          if (c.role === 'viewer' && c.readyState === 1 && c.bufferedAmount < 2e6) c.send(out, { binary: true });
        }
        return;
      }
      let m;
      try { m = JSON.parse(raw); } catch { return; }

      if (m.type === 'clipboard') {
        const ok = ws.role === 'viewer' && ws.isLocal && typeof m.text === 'string' && m.text.length > 0 && m.text.length <= 500000;
        if (!ok) return send(ws, { type: 'clipboard-result', id: m.id, ok: false, error: 'not allowed from this connection' });
        copyToClipboard(m.text)
          .then((tool) => send(ws, { type: 'clipboard-result', id: m.id, ok: true, tool }))
          .catch((e) => send(ws, { type: 'clipboard-result', id: m.id, ok: false, error: e.message }));
        return;
      }

      if (m.type === 'join') {
        ws.role = m.role === 'viewer' ? 'viewer' : 'phone';
        ws.name = String(m.name || '').slice(0, 40);
        const peers = [...clients.values()]
          .filter((c) => c !== ws && c.role && c.role !== ws.role)
          .map((c) => ({ id: c.id, role: c.role, name: c.name }));
        send(ws, { type: 'welcome', id: ws.id, peers, serverClipboard: ws.role === 'viewer' && ws.isLocal });
        for (const c of clients.values()) {
          if (c !== ws && c.role && c.role !== ws.role) {
            send(c, { type: 'peer-joined', id: ws.id, role: ws.role, name: ws.name });
          }
        }
      } else if (RELAY.has(m.type) && ws.role) {
        const t = clients.get(String(m.to));
        if (t && t.role && t.role !== ws.role) {
          send(t, { type: m.type, from: ws.id, sdp: m.sdp, candidate: m.candidate });
        }
      }
    });

    ws.on('close', () => {
      clients.delete(ws.id);
      if (!ws.role) return;
      for (const c of clients.values()) {
        if (c.role && c.role !== ws.role) send(c, { type: 'peer-left', id: ws.id });
      }
    });
  });

  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 20000);

  server.listen(PORT, '0.0.0.0', () => {
    console.log('\nQR Bridge is running\n');
    console.log('  Viewer (browser on this computer):');
    console.log(`    https://localhost:${PORT}/`);
    console.log('  Phone (same Wi-Fi, open in the phone browser):');
    if (!ips.length) console.log('    (no LAN IP detected)');
    ips.forEach((ip) => console.log(`    https://${ip}:${PORT}/phone.html`));
    console.log('\n  The first visit shows a certificate warning (self-signed): choose "Advanced -> Proceed".\n');
  });
})();
