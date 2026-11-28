const $ = (id) => document.getElementById(id);
const grid = $('grid'), emptyEl = $('empty'), resultsEl = $('results'), noneEl = $('none');
const connEl = $('conn'), countEl = $('count'), soundEl = $('sound');

const names = new Map();   // phoneId -> display name
const tiles = new Map();   // phoneId -> { pc, queue, el, video, overlay, state, resEl, last, hit }
const history = [];   // every scanned code, oldest first (used by Copy all)
let ws = null, myId = null, total = 0, audioCtx = null, serverClipboard = false;

/* ---------- Decoder: ZXing (zxing-wasm) for all formats, jsQR only as a QR fallback ---------- */
const fmtSel = $('fmt');
let zxReady = false, zxFailed = false, lastError = '';
if (window.ZXingWASM) {
  ZXingWASM.prepareZXingModule({
    overrides: { locateFile: (p, prefix) => (p.endsWith('.wasm') ? '/vendor/zxing/zxing_reader.wasm' : prefix + p) },
    fireImmediately: true,
  }).then(() => { zxReady = true; })
    .catch((e) => { zxFailed = true; lastError = 'ZXing failed to load, falling back to jsQR (QR codes only): ' + e.message; });
} else {
  zxFailed = true;
  lastError = 'ZXing script not loaded, falling back to jsQR (QR codes only)';
}

const FORMAT_SETS = {
  all: [],
  matrix: ['AllMatrix'],
  linear: ['AllLinear'],
  qr: ['QRCode', 'MicroQRCode', 'RMQRCode'],
};
const LABELS = {
  QRCode: 'QR Code', MicroQRCode: 'Micro QR', RMQRCode: 'rMQR', DataMatrix: 'Data Matrix', Aztec: 'Aztec',
  PDF417: 'PDF417', MaxiCode: 'MaxiCode', Code128: 'Code 128', Code39: 'Code 39', Code93: 'Code 93',
  Codabar: 'Codabar', ITF: 'ITF', EAN13: 'EAN-13', EAN8: 'EAN-8', UPCA: 'UPC-A', UPCE: 'UPC-E',
  DataBar: 'GS1 DataBar', DataBarExp: 'GS1 DataBar Expanded', DataBarLtd: 'GS1 DataBar Limited',
  DXFilmEdge: 'DX Film Edge', Telepen: 'Telepen',
};
function labelOf(format, text) {
  // ZXing reports UPC-A as an EAN-13 with a leading 0
  if (format === 'EAN13' && text.length === 13 && text[0] === '0') return 'UPC-A / EAN-13';
  return LABELS[format] || format;
}

const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
const SCALES = [1280, 1920];   // 1D barcodes need enough resolution; once a scale succeeds it is reused
let frameNo = 0, goodScale = null, missCount = 0;

async function decode(src, sw, sh) {
  const maxW = goodScale || SCALES[frameNo++ % SCALES.length];
  const scale = Math.min(1, maxW / sw);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
  wctx.drawImage(src, 0, 0, w, h);
  const img = wctx.getImageData(0, 0, w, h);

  const items = [];
  if (zxReady) {
    const res = await ZXingWASM.readBarcodes(img, {
      formats: FORMAT_SETS[fmtSel.value] || [],
      tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 8,
    });
    for (const r of res) {
      if (r.isValid === false || !r.text) continue;
      const p = r.position;
      items.push({
        text: r.text, format: r.format,
        pts: [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft].map((q) => [q.x / scale, q.y / scale]),
      });
    }
  } else if (zxFailed && typeof jsQR === 'function' && ['all', 'matrix', 'qr'].includes(fmtSel.value)) {
    const c = jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
    if (c && c.data) {
      const L = c.location;
      items.push({
        text: c.data, format: 'QRCode',
        pts: [L.topLeftCorner, L.topRightCorner, L.bottomRightCorner, L.bottomLeftCorner].map((q) => [q.x / scale, q.y / scale]),
      });
    }
  }
  if (items.length) { goodScale = maxW; missCount = 0; }
  else if (goodScale && ++missCount >= 3) { goodScale = null; missCount = 0; }
  return items;
}

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    for (const t of tiles.values()) {
      const now = performance.now();
      const v = t.video;
      const wsActive = t.wsAt && now - t.wsAt < 1500;   // compatibility mode (JPEG over WebSocket) is active
      t.frameEl.classList.toggle('ws', !!wsActive);
      let src, sw, sh;
      if (wsActive) {
        if (!t.fresh) continue;
        t.fresh = false;
        src = t.wsCanvas; sw = src.width; sh = src.height;
        if (!t.wsShown) { setState(t, 'Compatibility mode (WebSocket)', '1'); t.wsShown = true; }
      } else if (v.readyState >= 2 && v.videoWidth) {
        src = v; sw = v.videoWidth; sh = v.videoHeight;
        if (t.wsShown) { t.wsShown = false; setState(t, 'Connected', '1'); }
      } else {
        const pc = t.pc;
        t.dbg.textContent = `Waiting for video frames… readyState=${v.readyState} size=${v.videoWidth}×${v.videoHeight}` +
          (pc ? ` · WebRTC: ${pc.connectionState}/ICE ${pc.iceConnectionState}` : '');
        continue;
      }
      if (!zxReady && !zxFailed) { t.dbg.textContent = 'Loading decoder…'; continue; }
      t.resEl.textContent = `${sw}×${sh}`;
      const t0 = performance.now();
      let items = [];
      try { items = await decode(src, sw, sh); } catch (e) { lastError = 'Decode error: ' + e.message; }
      t.frames = (t.frames || 0) + 1;
      t.ms = (t.ms || 0) * 0.9 + (performance.now() - t0) * 0.1;
      drawOverlay(t, items, sw, sh);
      items.forEach((it) => onCode(t, it));
      if (t.frames % 6 === 0) {
        t.dbg.textContent = `${wsActive ? 'Compat mode' : 'WebRTC'} · ${zxReady ? 'ZXing' : 'jsQR'} · ${t.frames} frames analyzed · ${t.ms.toFixed(0)} ms/frame` + (lastError ? ' · ' + lastError : '');
      }
    }
  } finally { busy = false; }
}, 60);

function drawOverlay(t, items, sw, sh) {
  const cv = t.overlay;
  if (cv.width !== sw || cv.height !== sh) { cv.width = sw; cv.height = sh; }
  const ctx = cv.getContext('2d');
  const now = performance.now();
  if (items.length) t.hit = { items, at: now };
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!t.hit || now - t.hit.at > 900) return;
  const fs = Math.max(14, Math.round(cv.width / 36));
  ctx.lineWidth = Math.max(3, cv.width / 220);
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textBaseline = 'bottom';
  for (const it of t.hit.items) {
    ctx.strokeStyle = '#e8a200';
    ctx.fillStyle = 'rgba(232,162,0,.18)';
    ctx.beginPath();
    it.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    const label = labelOf(it.format, it.text);
    const [x0, y0] = it.pts[0];
    const tw = ctx.measureText(label).width + 10;
    const ly = Math.max(fs + 4, y0 - 4);
    ctx.fillStyle = '#e8a200';
    ctx.fillRect(x0, ly - fs - 2, tw, fs + 6);
    ctx.fillStyle = '#17212b';
    ctx.fillText(label, x0 + 5, ly + 2);
  }
}

/* ---------- Auto-copy ---------- */
// Preferred: the server writes to the OS clipboard (works even when this tab is in the
// background; only offered to a viewer opened on the server machine itself).
// Fallback: the browser clipboard API, which only works while this tab is focused.
const copyEl = $('autocopy'), copyStatus = $('copyStatus');
let copySeq = 0;
const pendingCopy = new Map();

function setCopyStatus(text, ok) {
  copyStatus.textContent = text;
  copyStatus.dataset.ok = ok === true ? '1' : ok === false ? '0' : '';
}
function showCopyMode() {
  if (!copyEl.checked) return setCopyStatus('Auto-copy is off', null);
  setCopyStatus(serverClipboard
    ? 'Auto-copy: system clipboard (works even when this tab is in the background)'
    : 'Auto-copy: browser clipboard (keep this tab focused)', null);
}
copyEl.onchange = showCopyMode;

async function writeBrowserClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {   // older / stricter browsers
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {}
  return false;
}

async function browserCopy(text) {
  if (await writeBrowserClipboard(text)) return setCopyStatus('Copied to clipboard', true);
  setCopyStatus('Copy blocked by the browser — click this page or keep the tab focused', false);
}

function autoCopy(text) {
  if (!copyEl.checked) return;
  if (serverClipboard && ws && ws.readyState === 1) {
    const id = ++copySeq;
    pendingCopy.set(id, text);
    send({ type: 'clipboard', id, text });
  } else {
    browserCopy(text);
  }
}

/* ---------- Copy all history ---------- */
// One code per line, oldest first, so it pastes straight into a single Excel column.
// A code that itself contains a line break, tab or quote is wrapped in quotes so it
// stays in one cell.
const copyAllBtn = $('copyAll');
function toColumn(list) {
  return list.map((t) => (/[\r\n\t"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t)).join('\n');
}
function flashCopyAll(label) {
  copyAllBtn.textContent = label;
  setTimeout(() => (copyAllBtn.textContent = 'Copy all'), 1800);
}
copyAllBtn.onclick = async () => {
  if (!history.length) return;
  const n = history.length;
  const text = toColumn(history);
  if (await writeBrowserClipboard(text)) {
    flashCopyAll(`Copied ${n}`);
    return setCopyStatus(`Copied ${n} code${n === 1 ? '' : 's'}, one per line`, true);
  }
  if (serverClipboard && ws && ws.readyState === 1) {   // browser refused: let the server do it
    const id = ++copySeq;
    pendingCopy.set(id, text);
    send({ type: 'clipboard', id, text });
    return flashCopyAll(`Copied ${n}`);
  }
  flashCopyAll('Copy failed');
  setCopyStatus('Copy blocked by the browser', false);
};

/* ---------- Results ---------- */
function onCode(t, item) {
  // A code that stays in view is logged once; it is logged again only after being out of view for 2.5 s
  const now = Date.now();
  t.seen = t.seen || new Map();
  const key = item.format + '|' + item.text;
  const prev = t.seen.get(key);
  t.seen.set(key, now);
  if (prev && now - prev < 2500) return;
  for (const [k, ts] of t.seen) if (now - ts > 10000) t.seen.delete(k);
  addResult(t.name(), item.text, labelOf(item.format, item.text));
}

function actionButtons(text) {
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; }
    catch { copy.textContent = 'Copy failed'; }
    setTimeout(() => (copy.textContent = 'Copy'), 1200);
  };
  const out = [copy];
  if (/^https?:\/\//i.test(text)) {
    const a = document.createElement('a');
    a.href = text; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = 'Open link';
    out.push(a);
  }
  return out;
}

// Large panel at the top: shows only the latest result
function setLatest(source, text, timeStr, fmt) {
  const box = $('latestText');
  box.textContent = text;
  box.classList.remove('idle');
  box.style.fontSize = text.length > 120 ? '15px' : text.length > 48 ? '20px' : '30px';
  $('latestMeta').textContent = `${timeStr} · ${fmt} · ${source}`;
  $('latestActs').replaceChildren(...actionButtons(text));
  const sec = $('latest');
  sec.classList.remove('fresh');
  void sec.offsetWidth;          // restart the flash animation
  sec.classList.add('fresh');
}

function addResult(source, text, fmt) {
  total++;
  countEl.textContent = total;
  noneEl.style.display = 'none';
  const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false });
  history.push(text);
  copyAllBtn.disabled = false;
  setLatest(source, text, timeStr, fmt);
  autoCopy(text);
  const li = document.createElement('li');
  li.className = 'fresh';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = document.createElement('span');
  time.textContent = timeStr;
  const f = document.createElement('span');
  f.className = 'fmt';
  f.textContent = fmt;
  const src = document.createElement('span');
  src.textContent = source;
  meta.append(time, f, src);
  const body = document.createElement('div');
  body.className = 'text';
  body.textContent = text;
  const acts = document.createElement('div');
  acts.className = 'acts';
  acts.append(...actionButtons(text));
  li.append(meta, body, acts);
  resultsEl.prepend(li);
  beep();
}

function resetLatest() {
  const box = $('latestText');
  box.textContent = 'Waiting for a barcode…';
  box.classList.add('idle');
  box.style.fontSize = '';
  $('latestMeta').textContent = '';
  $('latestActs').replaceChildren();
  $('latest').classList.remove('fresh');
  showCopyMode();
}
$('clear').onclick = () => {
  resultsEl.textContent = '';
  total = 0;
  countEl.textContent = 0;
  noneEl.style.display = '';
  history.length = 0;
  copyAllBtn.disabled = true;
  copyAllBtn.textContent = 'Copy all';
  resetLatest();   // clearing the history also clears the latest result
};
// Sound is on by default. Browsers only allow audio after a user gesture, so the
// AudioContext is unlocked on the first click / tap / key press anywhere on the page.
function updateSoundHint() {
  $('soundHint').hidden = !(soundEl.checked && (!audioCtx || audioCtx.state !== 'running'));
}
function ensureAudio() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.onstatechange = updateSoundHint;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch {}
  updateSoundHint();
  if (audioCtx && audioCtx.state === 'running') {
    ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.removeEventListener(ev, ensureAudio));
  }
}
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, ensureAudio, { passive: true }));
soundEl.onchange = () => { if (soundEl.checked) ensureAudio(); updateSoundHint(); };
ensureAudio();   // works straight away if the browser already allows autoplay audio

function beep() {
  if (!soundEl.checked || !audioCtx || audioCtx.state !== 'running') return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.frequency.value = 1200; g.gain.value = 0.12;
  o.connect(g); g.connect(audioCtx.destination);
  o.start(); o.stop(audioCtx.currentTime + 0.09);
}

/* ---------- Video tiles ---------- */
function ensureTile(id) {
  let t = tiles.get(id);
  if (t) return t;
  const el = document.createElement('figure');
  el.className = 'tile';
  el.innerHTML =
    '<div class="frame"><video autoplay muted playsinline></video><canvas class="wsview"></canvas><canvas class="overlay"></canvas>' +
    '<i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i></div>' +
    '<figcaption><span class="name"></span><span class="state">Connecting</span><span class="res"></span></figcaption><p class="dbg"></p>';
  grid.append(el);
  t = {
    el, pc: null, queue: [], last: null, hit: null,
    video: el.querySelector('video'),
    frameEl: el.querySelector('.frame'),
    wsCanvas: el.querySelector('.wsview'),
    overlay: el.querySelector('canvas'),
    stateEl: el.querySelector('.state'),
    resEl: el.querySelector('.res'),
    dbg: el.querySelector('.dbg'),
    name: () => names.get(id) || `Phone ${id}`,
  };
  el.querySelector('.name').textContent = t.name();
  tiles.set(id, t);
  emptyEl.style.display = 'none';
  return t;
}

function setState(t, text, ok) {
  t.stateEl.textContent = text;
  t.stateEl.dataset.ok = ok;
}

function removeTile(id) {
  const t = tiles.get(id);
  if (!t) return;
  if (t.pc) t.pc.close();
  t.el.remove();
  tiles.delete(id);
  if (!tiles.size) emptyEl.style.display = '';
}

async function onOffer(from, sdp) {
  const t = ensureTile(from);
  if (t.pc) t.pc.close();
  t.queue = [];
  const pc = new RTCPeerConnection({ iceServers: [] });   // LAN only, no STUN needed
  t.pc = pc;
  pc.ontrack = (e) => {
    t.video.srcObject = e.streams[0] || new MediaStream([e.track]);
    t.video.play().catch(() => {});
  };
  pc.onicecandidate = (e) => e.candidate && send({ type: 'candidate', to: from, candidate: e.candidate });
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') setState(t, 'Connected', '1');
    else if (s === 'failed') setState(t, 'Connection failed (check that both devices are on the same network and the router has no client isolation)', '0');
    else if (s === 'disconnected') setState(t, 'Disconnected', '0');
    else setState(t, 'Connecting', '');
  };
  await pc.setRemoteDescription(sdp);
  for (const c of t.queue) await pc.addIceCandidate(c).catch(() => {});
  t.queue = [];
  await pc.setLocalDescription(await pc.createAnswer());
  send({ type: 'answer', to: from, sdp: pc.localDescription });
}

/* ---------- Compatibility mode: JPEG frames over WebSocket ---------- */
const frameSlot = new Map();   // phoneId -> { buf, busy }
function onFrame(buf) {
  if (buf.byteLength < 8) return;
  const id = String(new DataView(buf).getUint32(0));
  if (!names.has(id)) return;   // phone already left: drop late frames
  let slot = frameSlot.get(id);
  if (!slot) { slot = { buf: null, busy: false }; frameSlot.set(id, slot); }
  slot.buf = buf;               // a new frame simply replaces the old one
  if (!slot.busy) pump(id, slot);
}
async function pump(id, slot) {
  slot.busy = true;
  while (slot.buf) {
    const buf = slot.buf;
    slot.buf = null;
    try {
      const bmp = await createImageBitmap(new Blob([buf.slice(4)], { type: 'image/jpeg' }));
      const t = ensureTile(id);
      const cv = t.wsCanvas;
      if (cv.width !== bmp.width || cv.height !== bmp.height) { cv.width = bmp.width; cv.height = bmp.height; }
      cv.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      t.wsAt = performance.now();
      t.fresh = true;
    } catch {}
  }
  slot.busy = false;
}

/* ---------- Signaling ---------- */
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

function connect() {
  const sock = new WebSocket(`wss://${location.host}`);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => {
    connEl.textContent = 'Server connected';
    connEl.dataset.ok = '1';
    send({ type: 'join', role: 'viewer', name: 'viewer' });
  };
  sock.onmessage = async (e) => {
    if (ws !== sock) return;
    if (typeof e.data !== 'string') return onFrame(e.data);
    const m = JSON.parse(e.data);
    if (m.type === 'welcome') {
      myId = m.id;
      serverClipboard = !!m.serverClipboard;
      showCopyMode();
      m.peers.forEach((p) => names.set(p.id, p.name || `Phone ${p.id}`));
    } else if (m.type === 'clipboard-result') {
      const text = pendingCopy.get(m.id);
      pendingCopy.delete(m.id);
      if (m.ok) setCopyStatus('Copied to the system clipboard', true);
      else if (text !== undefined) {
        setCopyStatus(`System copy failed (${m.error}); trying the browser clipboard…`, false);
        browserCopy(text);
      }
    } else if (m.type === 'peer-joined') {
      names.set(m.id, m.name || `Phone ${m.id}`);
    } else if (m.type === 'peer-left') {
      names.delete(m.id);
      frameSlot.delete(m.id);
      removeTile(m.id);
    } else if (m.type === 'offer') {
      await onOffer(m.from, m.sdp);
    } else if (m.type === 'candidate') {
      const t = tiles.get(m.from);
      if (!t || !t.pc) return;
      if (t.pc.remoteDescription) t.pc.addIceCandidate(m.candidate).catch(() => {});
      else t.queue.push(m.candidate);
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    connEl.textContent = 'Server disconnected, reconnecting…';
    connEl.dataset.ok = '';
    serverClipboard = false;
    pendingCopy.clear();
    [...tiles.keys()].forEach(removeTile);
    setTimeout(connect, 1500);
  };
}

/* ---------- Phone connect card (URL + QR code) ---------- */
let phoneUrls = [];
let selectedUrl = 0;

function renderConnect(box) {
  box.replaceChildren();
  if (!phoneUrls.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No LAN address detected. Connect this computer to the same Wi-Fi / network as your phone, then restart the server.';
    box.append(p);
    return;
  }
  const url = phoneUrls[selectedUrl];
  const img = document.createElement('img');
  img.className = 'qr-img';
  img.alt = `QR code for ${url}`;
  img.src = `/api/qr/${selectedUrl}.svg`;

  const code = document.createElement('code');
  code.className = 'qr-url';
  code.textContent = url;

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'ghost';
  copy.textContent = 'Copy link';
  copy.onclick = async () => {
    copy.textContent = (await writeBrowserClipboard(url)) ? 'Copied' : 'Copy failed';
    setTimeout(() => (copy.textContent = 'Copy link'), 1500);
  };
  box.append(img, code, copy);

  if (phoneUrls.length > 1) {   // several network adapters: let the user pick the right one
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'Several network addresses found. If the phone can’t connect, try another:';
    const chips = document.createElement('div');
    chips.className = 'chips';
    phoneUrls.forEach((u, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = new URL(u).hostname;
      b.setAttribute('aria-pressed', String(i === selectedUrl));
      b.onclick = () => { selectedUrl = i; renderAllConnect(); };
      chips.append(b);
    });
    box.append(note, chips);
  }
}
function renderAllConnect() {
  renderConnect($('connectInline'));
  renderConnect($('connectDialog'));
}

const qrDialog = $('qrDialog');
$('qrBtn').onclick = () => (typeof qrDialog.showModal === 'function' ? qrDialog.showModal() : qrDialog.setAttribute('open', ''));
$('qrClose').onclick = () => (typeof qrDialog.close === 'function' ? qrDialog.close() : qrDialog.removeAttribute('open'));
qrDialog.addEventListener('click', (e) => { if (e.target === qrDialog) $('qrClose').onclick(); });   // click outside closes

fetch('/api/info').then((r) => r.json()).then((info) => {
  phoneUrls = info.phoneUrls || [];
  renderAllConnect();
}).catch(() => {});
connect();
showCopyMode();
