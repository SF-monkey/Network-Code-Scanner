const $ = (id) => document.getElementById(id);
const video = $('preview'), startBtn = $('start'), camSel = $('cam'), resSel = $('res');
const torchBtn = $('torch'), stat = $('status'), dot = $('dot'), ph = $('ph'), modeSel = $('mode');
const zoomEl = $('zoom'), zoomVal = $('zoomVal'), zoomNote = $('zoomNote');
let hwZoom = false, digitalZoom = 1;

let stream = null, ws = null, wantRun = false, wakeLock = null, torchOn = false, retryTimer = null;
const pcs = new Map();   // viewerId -> { pc, queue }
let viewers = new Set(), startedAt = 0, frameTimer = null, tick = 0;
const grab = document.createElement('canvas');
const gctx = grab.getContext('2d');

function connectedCount() { return [...pcs.values()].filter((p) => p.pc.connectionState === 'connected').length; }
// Compatibility mode: when WebRTC isn't connected (or is disabled), send JPEG frames over WebSocket
function wantFrames() {
  if (!wantRun || !stream || !ws || ws.readyState !== 1 || !viewers.size) return false;
  const m = modeSel.value;
  if (m === 'ws') return true;
  if (m === 'rtc') return false;
  return digitalZoom > 1 || (connectedCount() === 0 && Date.now() - startedAt > 4000);
}
async function frameLoop() {
  frameTimer = null;
  if (!wantRun) return;
  const t0 = performance.now();
  try {
    if (wantFrames() && video.videoWidth && ws.bufferedAmount < 1_000_000) {
      const vw = video.videoWidth, vh = video.videoHeight;
      const z = digitalZoom;                       // crop the centre of the frame when > 1
      const sw = vw / z, sh = vh / z;
      const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
      const cap = Number(resSel.value.split('x')[0]) || 1280;
      const w = Math.round(Math.min(sw, cap));
      const h = Math.round(sh * (w / sw));
      if (grab.width !== w || grab.height !== h) { grab.width = w; grab.height = h; }
      gctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
      const blob = await new Promise((r) => grab.toBlob(r, 'image/jpeg', 0.8));
      if (blob && ws && ws.readyState === 1) ws.send(blob);
    }
  } catch {}
  if (++tick % 15 === 0) refresh();
  frameTimer = setTimeout(frameLoop, Math.max(0, 50 - (performance.now() - t0)));   // target ~20 frames per second
}

const label = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Device';

function setStatus(text, state) { stat.textContent = text; dot.dataset.state = state || 'idle'; }

function refresh() {
  if (!wantRun || !stream) return setStatus('Not started', 'idle');
  const n = connectedCount();
  if (!ws || ws.readyState !== 1) setStatus('Connecting to server…', 'wait');
  else if (!viewers.size) setStatus('Connected to server, waiting for a viewer page to open', 'wait');
  else if (wantFrames()) setStatus(`Sending in compatibility mode (WebSocket) · ${viewers.size} viewer(s)`, 'live');
  else if (n) setStatus(`Sending via WebRTC · ${n} viewer(s)`, 'live');
  else setStatus('Establishing WebRTC connection…', 'wait');
}

/* ---------- Camera ---------- */
async function openCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('This page is not served over HTTPS, so the browser blocks camera access');
  }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  const [w, h] = resSel.value.split('x').map(Number);
  const video_ = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } };
  if (camSel.value) video_.deviceId = { exact: camSel.value };
  else video_.facingMode = { ideal: 'environment' };
  stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: video_ });

  const track = stream.getVideoTracks()[0];
  if ('contentHint' in track) track.contentHint = 'detail';   // tell the encoder to preserve detail, which helps barcode decoding
  video.srcObject = stream;
  ph.style.display = 'none';
  await video.play().catch(() => {});

  // with an existing connection, just swap the track; no renegotiation
  for (const { pc } of pcs.values()) {
    const s = pc.getSenders().find((x) => x.track && x.track.kind === 'video');
    if (s) s.replaceTrack(track).catch(() => {});
  }

  await listCameras(track);
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  setupZoom(track, caps);
  torchOn = false;
  torchBtn.textContent = 'Turn torch on';
  torchBtn.style.display = caps.torch ? 'block' : 'none';
}

async function listCameras(track) {
  const cur = track.getSettings().deviceId;
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  camSel.textContent = '';
  cams.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Camera ${i + 1}`;
    if (d.deviceId === cur) o.selected = true;
    camSel.append(o);
  });
}

function fmtZoom(v) { return Number(v).toFixed(1) + '×'; }
function setupZoom(track, caps) {
  digitalZoom = 1;
  video.style.transform = '';
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    hwZoom = true;
    zoomEl.min = caps.zoom.min;
    zoomEl.max = caps.zoom.max;
    zoomEl.step = caps.zoom.step || 0.1;
    zoomEl.value = (track.getSettings().zoom) || caps.zoom.min;
    zoomNote.textContent = caps.zoom.min < 1
      ? 'Hardware zoom: below 1× means ultra-wide, giving a wider view'
      : 'Hardware zoom: lower values give a wider view (already at the widest end; for more, switch lens or use 4:3)';
  } else {
    hwZoom = false;
    zoomEl.min = 1; zoomEl.max = 4; zoomEl.step = 0.1; zoomEl.value = 1;
    zoomNote.textContent = 'Hardware zoom is not supported on this device: using digital zoom (crops the centre, compatibility mode only). For a wider view, switch lens or use 4:3';
  }
  zoomVal.textContent = fmtZoom(zoomEl.value);
}
zoomEl.oninput = async () => {
  const v = Number(zoomEl.value);
  zoomVal.textContent = fmtZoom(v);
  if (hwZoom) {
    const track = stream && stream.getVideoTracks()[0];
    if (track) track.applyConstraints({ advanced: [{ zoom: v }] }).catch(() => {});
  } else {
    digitalZoom = v;
    video.style.transform = v > 1 ? `scale(${v})` : '';   // keep the preview in sync with the crop
    refresh();
  }
};

torchBtn.onclick = async () => {
  const track = stream && stream.getVideoTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
    torchOn = !torchOn;
    torchBtn.textContent = torchOn ? 'Turn torch off' : 'Turn torch on';
  } catch { setStatus('This camera does not support a torch', 'error'); }
};

camSel.onchange = resSel.onchange = () => { if (wantRun) openCamera().catch((e) => setStatus('Switch failed: ' + e.message, 'error')); };

/* ---------- Signaling + WebRTC ---------- */
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

function closePc(id) {
  const p = pcs.get(id);
  if (p) { p.pc.close(); pcs.delete(id); }
}

async function call(viewerId) {
  if (!stream) return;
  closePc(viewerId);
  const pc = new RTCPeerConnection({ iceServers: [] });   // direct LAN connection
  const entry = { pc, queue: [] };
  pcs.set(viewerId, entry);
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  pc.onicecandidate = (e) => e.candidate && send({ type: 'candidate', to: viewerId, candidate: e.candidate });
  pc.onconnectionstatechange = refresh;
  await pc.setLocalDescription(await pc.createOffer());
  send({ type: 'offer', to: viewerId, sdp: pc.localDescription });
}

async function onAnswer(from, sdp) {
  const e = pcs.get(from);
  if (!e) return;
  await e.pc.setRemoteDescription(sdp);
  for (const c of e.queue) await e.pc.addIceCandidate(c).catch(() => {});
  e.queue = [];
  // raise the bitrate cap and prefer keeping resolution
  try {
    const s = e.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
    const p = s.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = 6_000_000;
    p.degradationPreference = 'maintain-resolution';
    await s.setParameters(p);
  } catch {}
}

function connect() {
  const sock = new WebSocket(`wss://${location.host}`);
  ws = sock;
  sock.onopen = () => { send({ type: 'join', role: 'phone', name: label }); refresh(); };
  sock.onmessage = async (e) => {
    if (ws !== sock) return;
    const m = JSON.parse(e.data);
    if (m.type === 'welcome') {
      viewers = new Set(m.peers.filter((p) => p.role === 'viewer').map((p) => p.id));
      if (modeSel.value !== 'ws') for (const id of viewers) await call(id);
      refresh();
    } else if (m.type === 'peer-joined' && m.role === 'viewer') {
      viewers.add(m.id);
      if (modeSel.value !== 'ws') await call(m.id);
      refresh();
    } else if (m.type === 'peer-left') {
      viewers.delete(m.id);
      closePc(m.id); refresh();
    } else if (m.type === 'answer') {
      await onAnswer(m.from, m.sdp);
    } else if (m.type === 'candidate') {
      const p = pcs.get(m.from);
      if (!p) return;
      if (p.pc.remoteDescription) p.pc.addIceCandidate(m.candidate).catch(() => {});
      else p.queue.push(m.candidate);
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    [...pcs.keys()].forEach(closePc);
    viewers.clear();
    refresh();
    if (wantRun) retryTimer = setTimeout(connect, 1500);
  };
}

/* ---------- Start / stop ---------- */
async function start() {
  wantRun = true;
  setStatus('Opening camera…', 'wait');
  try {
    await openCamera();
  } catch (e) {
    wantRun = false;
    return setStatus('Cannot open camera: ' + e.message, 'error');
  }
  startBtn.textContent = 'Stop sending';
  startBtn.dataset.on = '1';
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}   // keep the screen awake
  startedAt = Date.now();
  connect();
  frameLoop();
  refresh();
}

function stop() {
  wantRun = false;
  clearTimeout(retryTimer);
  clearTimeout(frameTimer);
  viewers.clear();
  [...pcs.keys()].forEach(closePc);
  if (ws) { const s = ws; ws = null; s.close(); }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  ph.style.display = '';
  torchBtn.style.display = 'none';
  digitalZoom = 1;
  video.style.transform = '';
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  startBtn.textContent = 'Start sending';
  startBtn.dataset.on = '0';
  setStatus('Not started', 'idle');
}

startBtn.onclick = () => (wantRun ? stop() : start());
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && wantRun && !wakeLock) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
});
