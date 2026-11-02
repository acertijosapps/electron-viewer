// Visor web de apps Electron.
// Video: `Page.startScreencast` (JPEG) de la ventana elegida, reenviado por WebSocket a un canvas.
// Modo marco: capturas de pantalla del área de la ventana desde el proceso main (desktopCapturer),
// con barra de título, menús y diálogos nativos. Input: `Input.dispatchMouseEvent` y `Input.dispatchKeyEvent`.

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  attachApp,
  captureNative,
  createActions,
  dispatchKey,
  pageClient,
  projectInfo,
  resolveWindow,
  viewport,
} from './lib/electron.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8094;
const HOST = process.env.HOST || '127.0.0.1';
const PROJECT = process.env.ELECTRON_VIEWER_PROJECT || process.cwd();
const MAX_DIM = Number(process.env.MAX_DIM) || 1920; // lado mayor de los frames del screencast
const QUALITY = Number(process.env.QUALITY) || 80; // calidad JPEG
const NATIVE_INTERVAL_MS = 250; // modo marco: una captura cada 250 ms como mucho
const MAX_CLIENT_BUFFER = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const FLAG_SCREENCAST = 0;
const FLAG_NATIVE = 1;

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log(new Date().toISOString().slice(11, 23), ...args);
}

const BUTTON_BITS = { left: 1, right: 2, middle: 4 };

class WindowSession {
  constructor(app, targetId) {
    this.app = app;
    this.id = targetId;
    this.clients = new Set();
    this.page = null;
    this.ready = null;
    this.viewport = null;
    this.lastFrame = null;
    this.frameMode = false;
    this.content = null; // área del contenido dentro de la captura nativa
    this.queue = Promise.resolve();
    this.pendingMove = null;
    this.onScreencast = (e) => this.handleScreencast(e);
    this.onClose = () => {
      log(this.app.name, this.id.slice(0, 8), 'window closed');
      this.broadcastJson({ type: 'closed' });
      for (const ws of this.clients) ws.close(1000, 'window closed');
      this.dispose();
    };
  }

  async add(ws) {
    this.clients.add(ws);
    if (!this.ready) this.ready = this.start();
    await this.ready;
    if (this.disposed || ws.readyState !== ws.OPEN) return;
    this.send(ws, this.meta());
    if (this.lastFrame) ws.send(this.lastFrame);
  }

  remove(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0) this.dispose();
  }

  async start() {
    const page = await pageClient(this.app, this.id);
    this.page = page;
    page.on('Page.screencastFrame', this.onScreencast);
    page.on('close', this.onClose);
    // Una ventana minimizada o tapada deja de pintar y el screencast se congela; con el foco y el
    // ciclo de vida emulados sigue activa mientras alguien la mira.
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await page.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    this.viewport = await viewport(page);
    await this.startScreencast();
    log(this.app.name, this.id.slice(0, 8), `session ${this.viewport.width}×${this.viewport.height}`);
  }

  startScreencast() {
    return this.page.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: MAX_DIM, maxHeight: MAX_DIM });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.frameMode = false;
    sessions.delete(this.key);
    const page = this.page;
    if (!page) return;
    page.off('Page.screencastFrame', this.onScreencast);
    page.off('close', this.onClose);
    page.send('Page.stopScreencast').catch(() => {});
    page.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    log(this.app.name, this.id.slice(0, 8), 'no viewers left; stopping');
  }

  meta() {
    return {
      type: 'meta',
      window: this.id,
      app: { id: this.app.id, name: this.app.name, main: this.app.main },
      width: this.viewport?.width,
      height: this.viewport?.height,
      frame: this.frameMode,
      content: this.frameMode ? this.content : null,
    };
  }

  handleScreencast({ data, metadata, sessionId }) {
    this.page.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (this.frameMode) return;
    const { deviceWidth: width, deviceHeight: height } = metadata;
    if (width && height && (width !== this.viewport?.width || height !== this.viewport?.height)) {
      this.viewport = { ...this.viewport, width, height };
      this.broadcastJson(this.meta());
    }
    this.broadcastFrame(FLAG_SCREENCAST, Buffer.from(data, 'base64'));
  }

  broadcastFrame(flag, jpeg) {
    const msg = Buffer.concat([Buffer.from([flag]), jpeg]);
    this.lastFrame = msg;
    for (const ws of this.clients) {
      // Un cliente lento se salta frames: el siguiente lo pone al día.
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < MAX_CLIENT_BUFFER) ws.send(msg);
    }
  }

  async setFrameMode(on) {
    if (on === this.frameMode) return;
    if (on && !this.app.main) throw new Error('Frame capture needs the main process: launch the app from the viewer or attach with an inspect port');
    this.frameMode = on;
    if (on) {
      await this.page.send('Page.stopScreencast').catch(() => {});
      this.nativeLoop();
    } else {
      this.content = null;
      await this.startScreencast();
    }
    this.broadcastJson(this.meta());
  }

  async nativeLoop() {
    while (this.frameMode && !this.disposed) {
      const started = Date.now();
      try {
        const shot = await captureNative(this.app, this.id, { format: 'jpeg', quality: QUALITY, maxDim: MAX_DIM });
        if (!this.frameMode) break;
        if (JSON.stringify(shot.content) !== JSON.stringify(this.content)) {
          this.content = shot.content;
          this.broadcastJson(this.meta());
        }
        this.broadcastFrame(FLAG_NATIVE, shot.data);
      } catch (err) {
        log(this.app.name, 'frame capture failed:', err.message);
        this.broadcastJson({ type: 'error', message: err.message });
        await this.setFrameMode(false).catch(() => {});
        break;
      }
      await sleep(Math.max(0, NATIVE_INTERVAL_MS - (Date.now() - started)));
    }
  }

  send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  broadcastJson(obj) {
    for (const ws of this.clients) this.send(ws, obj);
  }

  // El input va en orden por una cola; los movimientos pendientes se fusionan en el último.
  enqueue(fn) {
    this.queue = this.queue.then(fn).catch((err) => log(this.app.name, 'input failed:', err.message));
  }

  point(msg) {
    const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    return { x: clamp(msg.x) * this.viewport.width, y: clamp(msg.y) * this.viewport.height };
  }

  async handle(msg, ws) {
    if (!this.page || !this.viewport) return;
    switch (msg.type) {
      case 'mouse': {
        const { x, y } = this.point(msg);
        const modifiers = Number(msg.modifiers) || 0;
        const button = BUTTON_BITS[msg.button] ? msg.button : 'none';
        if (msg.action === 'move') {
          const queued = this.pendingMove;
          this.pendingMove = { x, y, modifiers, buttons: Number(msg.buttons) || 0 };
          if (queued) return;
          this.enqueue(() => {
            const m = this.pendingMove;
            this.pendingMove = null;
            const pressed = Object.keys(BUTTON_BITS).find((b) => m.buttons & BUTTON_BITS[b]) || 'none';
            return this.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: m.x, y: m.y, modifiers: m.modifiers, buttons: m.buttons, button: pressed });
          });
        } else if (msg.action === 'down' || msg.action === 'up') {
          this.enqueue(() =>
            this.page.send('Input.dispatchMouseEvent', {
              type: msg.action === 'down' ? 'mousePressed' : 'mouseReleased',
              x,
              y,
              button,
              buttons: Number(msg.buttons) || 0,
              clickCount: Math.max(1, Math.min(3, Number(msg.clickCount) || 1)),
              modifiers,
            }),
          );
        }
        break;
      }
      case 'wheel': {
        const { x, y } = this.point(msg);
        this.enqueue(() =>
          this.page.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x,
            y,
            deltaX: Number(msg.dx) || 0,
            deltaY: Number(msg.dy) || 0,
            modifiers: Number(msg.modifiers) || 0,
          }),
        );
        break;
      }
      case 'key': {
        if (typeof msg.key !== 'string') return;
        const def = { key: msg.key, code: String(msg.code || ''), keyCode: Number(msg.keyCode) || 0, repeat: Boolean(msg.repeat) };
        if (typeof msg.text === 'string' && [...msg.text].length === 1) def.text = msg.text;
        else if (msg.key === 'Enter') def.text = '\r';
        this.enqueue(() => dispatchKey(this.page, msg.action === 'up' ? 'up' : 'down', def, Number(msg.modifiers) || 0));
        break;
      }
      case 'text':
        if (typeof msg.text === 'string' && msg.text) this.enqueue(() => this.page.send('Input.insertText', { text: msg.text.slice(0, 10000) }));
        break;
      case 'frame':
        try {
          await this.setFrameMode(Boolean(msg.on));
        } catch (err) {
          this.send(ws, { type: 'error', message: err.message });
          this.send(ws, this.meta());
        }
        break;
    }
  }
}

const sessions = new Map();

// ---------- API HTTP (la usa el MCP) ----------

const actions = createActions();

const API = {
  'GET /api/windows': actions.windows,
  'GET /api/project': () => projectInfo(PROJECT),
  'GET /api/ax-tree': actions.axTree,
  'GET /api/logs': actions.logs,
  'POST /api/launch': ({ project }) => actions.launch({ project: project || PROJECT }),
  'POST /api/attach': actions.attach,
  'POST /api/click': actions.click,
  'POST /api/drag': actions.drag,
  'POST /api/hover': actions.hover,
  'POST /api/scroll': actions.scroll,
  'POST /api/text': actions.text,
  'POST /api/key': actions.key,
  'POST /api/resize': actions.resize,
  'POST /api/reload': actions.reload,
  'POST /api/evaluate': actions.evaluate,
  'POST /api/evaluate-main': actions.evaluateMain,
  'POST /api/devtools': actions.devtools,
};

const hostnameOf = (value) => {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
};

function isLocalOrigin(origin) {
  if (!origin) return true;
  return LOOPBACK.includes(hostnameOf(origin));
}

// Con el visor solo en loopback, un Host ajeno es DNS rebinding: una web que se hace pasar por localhost.
function isLocalHost(host) {
  if (!LOOPBACK.includes(HOST)) return true;
  return LOOPBACK.includes(hostnameOf(host || ''));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const params = Object.fromEntries(url.searchParams);
  if (route === 'GET /api/screenshot') {
    const shot = await actions.screenshot(params);
    const headers = {
      'content-type': shot.mimeType,
      'cache-control': 'no-store',
      'x-image-width': shot.width,
      'x-image-height': shot.height,
      'x-window': shot.window,
    };
    if (shot.viewport) Object.assign(headers, { 'x-viewport-width': shot.viewport.width, 'x-viewport-height': shot.viewport.height });
    if (shot.content) headers['x-content'] = JSON.stringify(shot.content);
    res.writeHead(200, headers);
    res.end(shot.data);
    return;
  }
  const handler = API[route];
  if (!handler) throw Object.assign(new Error('Not found'), { status: 404 });
  let input = params;
  if (req.method === 'POST') {
    // JSON obligatorio: una página ajena no puede mandarlo sin preflight CORS, que aquí no se concede.
    if (!/^application\/json\b/.test(req.headers['content-type'] || '') || !isLocalOrigin(req.headers.origin)) {
      throw Object.assign(new Error('application/json from a local origin is required'), { status: 403 });
    }
    input = { ...params, ...(await readJson(req)) };
  }
  const result = await handler(input);
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(result ?? null));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!isLocalHost(req.headers.host)) throw Object.assign(new Error('Forbidden host'), { status: 403 });
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC + path.sep)) throw Object.assign(new Error('forbidden'), { status: 403 });
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (err) {
    const status = err.status || (err.code === 'ENOENT' ? 404 : 500);
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(status === 500 ? err.message : String(status));
  }
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  // Cualquier página abierta en el navegador podría conectarse a localhost y manejar la app;
  // solo se aceptan orígenes locales.
  verifyClient: ({ origin, req }) => isLocalOrigin(origin) && isLocalHost(req.headers.host),
});

wss.on('connection', async (ws, req) => {
  const windowId = new URL(req.url, 'http://x').searchParams.get('window') || '';
  let w;
  try {
    w = await resolveWindow(windowId);
    if (w.id !== windowId) throw new Error(`Unknown window ${windowId}`);
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    ws.close(1008, 'unknown window');
    return;
  }
  const key = `${w.app.cdpPort}/${w.id}`;
  let session = sessions.get(key);
  if (!session) {
    session = new WindowSession(w.app, w.id);
    session.key = key;
    sessions.set(key, session);
  }
  ws.on('close', () => session.remove(ws));
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    session.handle(msg, ws).catch((err) => log(w.app.name, 'message failed:', err.message));
  });
  try {
    await session.add(ws);
  } catch (err) {
    log(w.app.name, 'could not start:', err.message);
    session.send(ws, { type: 'error', message: err.message });
    ws.close();
  }
});

if (process.env.ELECTRON_VIEWER_ATTACH) {
  attachApp({ port: process.env.ELECTRON_VIEWER_ATTACH, inspectPort: process.env.ELECTRON_VIEWER_INSPECT })
    .then((app) => log(`attached to ${app.name} on port ${app.cdpPort}`))
    .catch((err) => log('attach failed:', err.message));
}

server.listen(PORT, HOST, () => {
  const project = projectInfo(PROJECT);
  log(`Electron Viewer on http://${LOOPBACK.includes(HOST) ? 'localhost' : HOST}:${PORT}/ (project: ${project.dir}${project.launchable ? '' : ', not launchable'})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const s of [...sessions.values()]) s.dispose();
    setTimeout(() => process.exit(0), 200);
  });
}
