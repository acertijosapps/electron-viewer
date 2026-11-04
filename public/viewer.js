const $ = (s) => document.querySelector(s);
const canvas = $('#screen');
const keys = $('#keys');
const ctx = canvas.getContext('2d');
const windowSelect = $('#window');
const statusEl = $('#status');
const placeholder = $('#placeholder');
const placeholderText = $('#placeholder-text');
const launchButton = $('#launch');
const launchTop = $('#launch-top');
const attachForm = $('#attach');
const sizeSelect = $('#size');
const controls = $('.controls');

const TARGETS_REFRESH_MS = 3000;
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP_PX = 5;
const BUTTONS = ['left', 'middle', 'right'];

let ws = null;
let windowId = null;
let apps = [];
let project = null;
let meta = null;
let launching = false;
let framesThisSecond = 0;
let fps = 0;

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function api(method, route, body) {
  const init = { method };
  if (body) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`api/${route}`, init);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res;
}

// ---------- Video ----------

// Solo se decodifica el frame más reciente: si llegan más rápido de lo que se pintan, se saltan.
let pendingFrame = null;
let decoding = false;

async function drawLoop() {
  decoding = true;
  while (pendingFrame) {
    const data = pendingFrame;
    pendingFrame = null;
    try {
      const bitmap = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      framesThisSecond++;
      placeholder.hidden = true;
    } catch (err) {
      console.warn('frame:', err);
    }
  }
  decoding = false;
}

function onFrame(buf) {
  pendingFrame = buf.subarray(1);
  if (!decoding) drawLoop();
}

setInterval(() => {
  fps = framesThisSecond;
  framesThisSecond = 0;
  renderStatus();
}, 1000);

// ---------- Estado ----------

// Un aviso (error, «guardando…») se queda unos segundos antes de volver a tamaño y fps.
const NOTE_MS = 6000;
let noteUntil = 0;

function renderStatus(text) {
  if (typeof text === 'string') {
    statusEl.textContent = text;
    statusEl.title = text;
    noteUntil = text ? performance.now() + NOTE_MS : 0;
    return;
  }
  if (!meta || performance.now() < noteUntil) return;
  statusEl.title = '';
  statusEl.textContent = `${meta.width}×${meta.height} · ${fps} fps`;
}

function onJson(msg) {
  if (msg.type === 'meta') {
    meta = msg;
    sizeSelect.options[0].textContent = `Window size (${msg.width} × ${msg.height})`;
    renderStatus();
  } else if (msg.type === 'error') {
    renderStatus(`Error: ${msg.message}`);
  } else if (msg.type === 'closed') {
    disconnect();
    refreshTargets();
  }
}

// ---------- Ventanas ----------

const allWindows = () => apps.flatMap((app) => app.windows.map((w) => ({ ...w, app })));
const selected = () => allWindows().find((w) => w.id === windowId);

function showMessage(text, { launch = false } = {}) {
  placeholder.hidden = false;
  placeholderText.textContent = text;
  launchButton.hidden = !launch;
  launchButton.disabled = launching;
  attachForm.hidden = !launch && !!apps.length;
}

function setControlsEnabled(enabled) {
  controls.querySelectorAll('button, select').forEach((b) => (b.disabled = !enabled));
}

function disconnect() {
  const socket = ws;
  ws = null;
  socket?.close();
  meta = null;
  canvas.width = canvas.height = 0;
  setControlsEnabled(false);
}

function connect(id) {
  disconnect();
  windowId = id;
  showMessage('Connecting…');
  setControlsEnabled(true);
  const socket = new WebSocket(`ws://${location.host}/ws?window=${encodeURIComponent(id)}`);
  socket.binaryType = 'arraybuffer';
  socket.onmessage = (e) => (typeof e.data === 'string' ? onJson(JSON.parse(e.data)) : onFrame(new Uint8Array(e.data)));
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    renderStatus('Disconnected; retrying…');
    setTimeout(() => refreshTargets(true), 1500);
  };
  ws = socket;
}

function renderLaunch() {
  const can = project?.launchable && !launching;
  launchTop.hidden = !project?.launchable;
  launchTop.disabled = !can;
  launchTop.textContent = launching ? 'Launching…' : `Launch ${project?.name ?? 'app'}`;
  launchTop.dataset.tip = project ? `Run ${project.command} in ${project.dir}` : '';
  launchButton.textContent = launchTop.textContent;
}

async function refreshTargets(reconnect = false) {
  try {
    apps = await (await api('GET', 'windows')).json();
  } catch {
    renderStatus('The viewer is not responding');
    return;
  }
  const windows = allWindows();
  windowSelect.replaceChildren(
    ...apps.map((app) => {
      const group = document.createElement('optgroup');
      group.label = `${app.name} · :${app.cdpPort}${app.main ? '' : ' · no main'}`;
      group.append(...app.windows.map((w) => new Option(w.title || w.url || w.id, w.id)));
      return group;
    }),
  );
  windowSelect.hidden = !windows.length;
  renderLaunch();
  if (!windows.length) {
    launchTop.hidden = true; // el placeholder ya tiene su botón
    disconnect();
    windowId = null;
    renderStatus('');
    if (launching) showMessage('Starting the app…');
    else if (apps.length) showMessage(`${apps[0].name} has no windows open.`);
    else showMessage('No Electron app found.', { launch: project?.launchable });
    if (!project?.launchable && !apps.length) {
      placeholderText.textContent = 'No Electron app found. Start your app with --remote-debugging-port=9222, or run the viewer from your project folder.';
    }
    return;
  }
  if (!selected()) {
    const wanted = new URLSearchParams(location.search).get('window');
    windowId = (windows.find((w) => w.id === wanted) || windows[0]).id;
  }
  windowSelect.value = windowId;
  if (reconnect || !ws) connect(windowId);
}

windowSelect.onchange = () => {
  history.replaceState(null, '', `?window=${encodeURIComponent(windowSelect.value)}`);
  connect(windowSelect.value);
};

async function launch() {
  launching = true;
  renderLaunch();
  showMessage(`Starting ${project.name}…`);
  try {
    const app = await (await api('POST', 'launch', {})).json();
    launching = false;
    windowId = app?.windows?.[0]?.id ?? null;
    if (windowId) history.replaceState(null, '', `?window=${encodeURIComponent(windowId)}`);
    await refreshTargets(true);
  } catch (err) {
    launching = false;
    renderLaunch();
    showMessage(`Could not start ${project.name}: ${err.message}`, { launch: true });
  }
}

launchButton.onclick = launch;
launchTop.onclick = launch;

attachForm.onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('POST', 'attach', { port: Number($('#attach-port').value) });
    await refreshTargets(true);
  } catch (err) {
    placeholderText.textContent = err.message;
  }
};

async function loadProject() {
  try {
    project = await (await api('GET', 'project')).json();
  } catch {
    project = null;
  }
}

setInterval(() => refreshTargets(), TARGETS_REFRESH_MS);

// ---------- Controles ----------

async function control(route, body = {}) {
  try {
    return await (await api('POST', route, { window: windowId, ...body })).json();
  } catch (err) {
    renderStatus(`${route} failed: ${err.message}`);
    return null;
  }
}

$('#reload').onclick = () => control('reload');

$('#devtools').onclick = async () => {
  const result = await control('devtools');
  // Sin proceso main: se abre el frontend de DevTools que sirve el propio puerto CDP.
  if (result?.url) window.open(result.url, '_blank');
};

sizeSelect.onchange = async () => {
  const [width, height] = sizeSelect.value ? sizeSelect.value.split('x').map(Number) : [0, 0];
  sizeSelect.value = '';
  const result = await control('resize', { width, height });
  if (result?.note) renderStatus(result.note);
};

$('#screenshot').onclick = async () => {
  if (!windowId) return;
  renderStatus('Saving screenshot…');
  try {
    const res = await api('GET', `screenshot?window=${encodeURIComponent(windowId)}`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    const name = (selected()?.app.name || 'electron').replace(/[^\w.-]+/g, '-');
    a.download = `${name}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    renderStatus('');
    renderStatus();
  } catch (err) {
    renderStatus(`Screenshot failed: ${err.message}`);
  }
};

// ---------- Input ----------

// Posición normalizada (0–1) dentro del contenido de la ventana, descontando el letterbox de object-fit.
function toNorm(e) {
  const r = canvas.getBoundingClientRect();
  const ar = canvas.width / canvas.height;
  let w = r.width;
  let h = r.height;
  let ox = 0;
  let oy = 0;
  if (r.width / r.height > ar) {
    w = h * ar;
    ox = (r.width - w) / 2;
  } else {
    h = w / ar;
    oy = (r.height - h) / 2;
  }
  const x = (e.clientX - r.left - ox) / w;
  const y = (e.clientY - r.top - oy) / h;
  return { x, y };
}

const inside = (p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;

function modifiersOf(e) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

let lastDown = null;
let pressed = false;

canvas.addEventListener('pointerdown', (e) => {
  if (!meta || !canvas.width) return;
  keys.focus({ preventScroll: true });
  const p = toNorm(e);
  if (!inside(p)) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  pressed = true;
  const button = BUTTONS[e.button] || 'left';
  const now = performance.now();
  const near = lastDown && Math.hypot(e.clientX - lastDown.cx, e.clientY - lastDown.cy) < DOUBLE_CLICK_SLOP_PX;
  const clickCount = near && lastDown.button === button && now - lastDown.t < DOUBLE_CLICK_MS ? Math.min(3, lastDown.count + 1) : 1;
  lastDown = { t: now, cx: e.clientX, cy: e.clientY, button, count: clickCount };
  send({ type: 'mouse', action: 'down', ...p, button, buttons: e.buttons, clickCount, modifiers: modifiersOf(e) });
});

canvas.addEventListener('pointerup', (e) => {
  if (!pressed) return;
  pressed = false;
  const p = toNorm(e);
  send({ type: 'mouse', action: 'up', x: p.x, y: p.y, button: BUTTONS[e.button] || 'left', buttons: e.buttons, clickCount: lastDown?.count || 1, modifiers: modifiersOf(e) });
});

// Movimiento (hover y arrastre) a lo sumo una vez por frame de pantalla.
let moveEvent = null;
canvas.addEventListener('pointermove', (e) => {
  if (!meta || !canvas.width) return;
  if (!moveEvent) requestAnimationFrame(flushMove);
  moveEvent = e;
});

function flushMove() {
  const e = moveEvent;
  moveEvent = null;
  if (!e) return;
  const p = toNorm(e);
  if (!pressed && !inside(p)) return;
  send({ type: 'mouse', action: 'move', ...p, buttons: e.buttons, modifiers: modifiersOf(e) });
}

canvas.addEventListener('pointercancel', () => (pressed = false));
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

let wheel = null;
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (!meta) return;
    const p = toNorm(e);
    if (!inside(p)) return;
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
    if (!wheel) {
      wheel = { ...p, dx: 0, dy: 0, modifiers: modifiersOf(e) };
      requestAnimationFrame(() => {
        send({ type: 'wheel', ...wheel });
        wheel = null;
      });
    }
    wheel.dx += e.deltaX * k;
    wheel.dy += e.deltaY * k;
  },
  { passive: false },
);

// Teclado: un textarea invisible tiene el foco mientras se usa la app. Cada tecla va a la app
// (también ⌘C/⌘V, que en macOS se convierten en comandos de edición, y Tab). El texto que entra sin
// keydown (IME, dictado, herramientas que insertan texto) se manda entero.
function onKey(e, action) {
  if (!meta || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  const printable = [...e.key].length === 1 && !e.ctrlKey && !e.metaKey;
  send({
    type: 'key',
    action,
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    text: action === 'down' && printable ? e.key : undefined,
    repeat: e.repeat,
    modifiers: modifiersOf(e),
  });
}

keys.addEventListener('keydown', (e) => onKey(e, 'down'));
keys.addEventListener('keyup', (e) => onKey(e, 'up'));
keys.addEventListener('input', (e) => {
  if (e.isComposing) return;
  if (keys.value) send({ type: 'text', text: keys.value });
  keys.value = '';
});
keys.addEventListener('compositionend', () => {
  if (keys.value) send({ type: 'text', text: keys.value });
  keys.value = '';
});

// ---------- Tooltips ----------
// Uno solo, colocado junto al control bajo el puntero o con el foco del teclado. Se usa
// pointerover en el documento porque los botones deshabilitados no reciben eventos propios.

const tip = $('#tip');
let tipFor = null;

function showTip(el) {
  const text = el?.dataset.tip;
  if (!text) return hideTip();
  tipFor = el;
  tip.textContent = text;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const gap = 6;
  // Debajo si cabe (barra de arriba), si no encima (controles de abajo).
  const top = r.bottom + gap + t.height <= innerHeight ? r.bottom + gap : r.top - gap - t.height;
  const left = Math.min(innerWidth - t.width - 8, Math.max(8, r.left + r.width / 2 - t.width / 2));
  tip.style.top = `${Math.max(8, top)}px`;
  tip.style.left = `${left}px`;
}

function hideTip() {
  tipFor = null;
  tip.hidden = true;
}

document.addEventListener('pointerover', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (el !== tipFor) el ? showTip(el) : hideTip();
});
document.addEventListener('pointerdown', hideTip);
document.addEventListener('focusin', (e) => (e.target.matches?.(':focus-visible') ? showTip(e.target.closest('[data-tip]')) : hideTip()));
document.addEventListener('focusout', hideTip);
addEventListener('blur', hideTip);

setControlsEnabled(false);
await loadProject();
refreshTargets();
