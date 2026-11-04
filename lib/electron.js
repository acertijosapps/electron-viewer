// Acceso a apps Electron por CDP, compartido por el visor (server.js) y el MCP (mcp/server.js).
// Renderer: `--remote-debugging-port` (un target "page" por ventana). Main: inspector de Node
// (`--inspect`), donde `require('electron')` está disponible gracias al command line API.

import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { CdpClient, evaluate, fetchJson } from './cdp.js';

export const CDP_PORT = Number(process.env.CDP_PORT) || 9222;
export const INSPECT_PORT = Number(process.env.INSPECT_PORT) || 9229;
const SCAN_PORTS = 10; // se buscan apps en CDP_PORT … CDP_PORT + 9
const RESERVED_PORTS = new Set([8081, 8082, 8093, 8094]);
// No en os.tmpdir(): los clientes MCP lanzan el servidor con un entorno mínimo (sin TMPDIR en macOS)
// y el visor y el MCP verían carpetas distintas.
const STATE_DIR = process.env.ELECTRON_VIEWER_STATE_DIR || path.join(os.homedir(), '.cache', 'electron-viewer');
const STATE_FILE = path.join(STATE_DIR, 'apps.json');
const LAUNCH_TIMEOUT_MS = 30000;
const FIRST_WINDOW_TIMEOUT_MS = 10000;
const MAX_LOGS = 1000;
const IS_MAC = process.platform === 'darwin';

// Error del que pide (dato inválido o recurso inexistente), para responder 4xx en la API.
export function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Registro de apps ----------
// Las apps lanzadas o adjuntadas se guardan en un archivo temporal: así el visor ve las que
// arrancó el MCP sin visor, y viceversa. Las demás se descubren escaneando los puertos CDP.

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function updateState(fn) {
  const state = readState();
  fn(state);
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

// «Mozilla/5.0 (…) AppleWebKit/537.36 (KHTML, like Gecko) mi-app/1.2.0 Chrome/… Electron/…»
function nameFromUserAgent(ua) {
  return ua.match(/\)\s([^\s/]+)\/[\w.-]+\sChrome\//)?.[1] || 'Electron app';
}

async function probe(port) {
  const version = await fetchJson(port, '/json/version', { timeout: 800 }).catch(() => null);
  // webSocketDebuggerUrl cambia en cada arranque: distingue una app nueva en el mismo puerto.
  return version && { userAgent: version['User-Agent'] || '', instance: version.webSocketDebuggerUrl || '' };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export async function listApps() {
  const state = readState();
  const ports = new Set([...Array.from({ length: SCAN_PORTS }, (_, i) => CDP_PORT + i), ...Object.keys(state).map(Number)]);
  const stale = [];
  const apps = await Promise.all(
    [...ports].map(async (port) => {
      const known = state[port];
      const info = await probe(port);
      if (!info) {
        // Una app lanzada que sigue viva solo tardó en responder: no se olvida.
        if (known && !(known.pid && isAlive(known.pid))) stale.push(port);
        return null;
      }
      // Un Chrome con depuración remota en el mismo rango no es una app Electron.
      if (!known && !/Electron\//.test(info.userAgent)) return null;
      const app = {
        id: String(port),
        name: known?.name || nameFromUserAgent(info.userAgent),
        cdpPort: port,
        inspectPort: known?.inspectPort ?? null,
        pid: known?.pid ?? null,
        project: known?.project ?? null,
        log: known?.log ?? null,
        electron: info.userAgent.match(/Electron\/([\w.-]+)/)?.[1] ?? null,
      };
      // Interno (runtimeOf); no enumerable para que no salga en la API.
      return Object.defineProperty(app, 'instance', { value: info.instance });
    }),
  );
  if (stale.length) updateState((s) => stale.forEach((p) => delete s[p]));
  const found = apps.filter(Boolean).sort((a, b) => a.cdpPort - b.cdpPort);
  await discoverInspectors(found);
  return found;
}

// Inspectores del main de apps arrancadas a mano (`--inspect`): se buscan en INSPECT_PORT … +9 y
// se emparejan preguntándole a cada uno, solo leyendo, en qué puerto CDP escucha su app. El
// resultado se guarda por proceso (id del target): a cada inspector se le conecta una sola vez.
const inspectorPairs = new Map(); // id del target del inspector → Promise<puerto CDP | null>

async function discoverInspectors(apps) {
  const missing = apps.filter((a) => !a.inspectPort);
  if (!missing.length) return;
  const used = new Set(apps.map((a) => a.inspectPort).filter(Boolean));
  const ports = Array.from({ length: SCAN_PORTS }, (_, i) => INSPECT_PORT + i).filter((p) => !used.has(p));
  await Promise.all(
    ports.map(async (port) => {
      const target = await inspectorTarget(port);
      if (!target) return;
      if (!inspectorPairs.has(target.id)) inspectorPairs.set(target.id, pairInspector(target).catch(() => null));
      const cdpPort = await inspectorPairs.get(target.id);
      const app = missing.find((a) => a.cdpPort === cdpPort);
      if (!app) return;
      app.inspectPort = port;
      updateState((s) => {
        s[app.cdpPort] = { ...s[app.cdpPort], cdpPort: app.cdpPort, inspectPort: port, name: s[app.cdpPort]?.name || app.name };
      });
    }),
  );
}

async function pairInspector(target) {
  const client = await CdpClient.connect(target.webSocketDebuggerUrl, { timeout: 1500 });
  try {
    // Cualquier proceso Node con --inspect puede estar en el rango: solo se lee, y nada si no es Electron.
    return await evaluate(
      client,
      "process.versions.electron ? Number(require('electron').app.commandLine.getSwitchValue('remote-debugging-port')) || null : null",
      { commandLineAPI: true, timeout: 1500 },
    );
  } finally {
    client.close();
  }
}

const isWindowTarget = (t) => t.type === 'page' && !t.url.startsWith('devtools://');

export async function listWindows() {
  const apps = await listApps();
  await Promise.all(
    apps.map(async (app) => {
      const targets = await fetchJson(app.cdpPort, '/json/list').catch(() => []);
      app.windows = targets.filter(isWindowTarget).map((t) => ({ id: t.id, title: t.title, url: t.url }));
      app.main = app.inspectPort ? Boolean(await inspectorTarget(app.inspectPort)) : false;
      // Abre la conexión de cada ventana para empezar a juntar sus logs de consola.
      for (const w of app.windows) pageClient(app, w.id).catch(() => {});
      if (app.main) mainClient(app).catch(() => {});
    }),
  );
  return apps;
}

export async function resolveApp(appArg) {
  const apps = await listWindows();
  if (appArg !== undefined && appArg !== null && appArg !== '') {
    const key = String(appArg).toLowerCase();
    const hit = apps.find((a) => a.id === key) || apps.find((a) => a.name.toLowerCase() === key);
    if (!hit) throw invalid(`No app "${appArg}". Running: ${apps.map((a) => `${a.id} (${a.name})`).join(', ') || 'none'}`, 404);
    return hit;
  }
  if (apps.length === 1) return apps[0];
  if (!apps.length) throw invalid('No Electron app is running. Start one with launch_app or attach to its debugging port.', 404);
  throw invalid(`Several apps are running; pass app: ${apps.map((a) => `${a.id} (${a.name})`).join(', ')}`);
}

// Ventana por id de target, por parte del título o, si solo hay una, esa.
export async function resolveWindow(windowArg) {
  const apps = await listWindows();
  const all = apps.flatMap((app) => app.windows.map((w) => ({ ...w, app })));
  if (windowArg) {
    const exact = all.find((w) => w.id === windowArg);
    if (exact) return exact;
    const key = String(windowArg).toLowerCase();
    const matches = all.filter((w) => w.title.toLowerCase().includes(key));
    if (matches.length === 1) return matches[0];
    if (!matches.length) throw invalid(`No window "${windowArg}". Open: ${describeWindows(all)}`, 404);
    throw invalid(`"${windowArg}" matches several windows: ${describeWindows(matches)}`);
  }
  if (all.length === 1) return all[0];
  if (!all.length) {
    throw invalid(
      apps.length
        ? 'The app has no windows open.'
        : 'No Electron app is running. Start one with launch_app or attach to its debugging port.',
      404,
    );
  }
  throw invalid(`Several windows are open; pass window (id or part of the title): ${describeWindows(all)}`);
}

const describeWindows = (list) => list.map((w) => `${w.id} "${w.title}"`).join(', ') || 'none';

// ---------- Lanzar y adjuntar ----------

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function freePort(start, taken = []) {
  for (let port = start; port < start + 100; port++) {
    if (RESERVED_PORTS.has(port) || taken.includes(port)) continue;
    // Responde a /json/version: es una app que aún no se registra, no un puerto libre.
    if ((await isPortFree(port)) && !(await probe(port))) return port;
  }
  throw new Error(`No free port from ${start}`);
}

export function projectDir(project) {
  return path.resolve(project || process.env.ELECTRON_VIEWER_PROJECT || process.cwd());
}

// Carpeta del paquete `electron` del proyecto. Se resuelve sin ejecutarlo: desde Electron 4x su
// index.js descarga el binario la primera vez, bloqueando y escribiendo en stdout (que en el MCP
// es del protocolo).
function electronPackageDir(dir) {
  try {
    return path.dirname(createRequire(path.join(path.resolve(dir), 'package.json')).resolve('electron'));
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') throw invalid(`Electron is not installed in ${dir} (npm install --save-dev electron)`, 404);
    throw invalid(err.message.split('\n')[0]);
  }
}

// Ruta del ejecutable, como la calcula el index.js del paquete; null si aún no se descargó.
function electronBinary(pkgDir) {
  let rel = '';
  try {
    rel = readFileSync(path.join(pkgDir, 'path.txt'), 'utf8').trim();
  } catch {
    // sin path.txt: falta descargar el binario
  }
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) return path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, rel || 'electron');
  const full = rel && path.join(pkgDir, 'dist', rel);
  return full && existsSync(full) ? full : null;
}

export async function resolveElectron(dir) {
  const pkgDir = electronPackageDir(dir);
  const binary = electronBinary(pkgDir);
  if (binary) return binary;
  // Misma descarga que haría `require('electron')`, pero sin bloquear ni escribir en stdout.
  await new Promise((resolve, reject) => {
    let output = '';
    const proc = spawn(process.execPath, [path.join(pkgDir, 'install.js')], { cwd: pkgDir, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (d) => (output += d));
    proc.stderr.on('data', (d) => (output += d));
    proc.once('error', reject);
    proc.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Could not download the Electron binary: ${output.trim().split('\n').slice(-3).join(' ')}`)),
    );
  });
  const downloaded = electronBinary(pkgDir);
  if (!downloaded) throw new Error(`Electron is installed in ${pkgDir} but its binary is missing`);
  return downloaded;
}

export function projectInfo(project) {
  const dir = projectDir(project);
  let name = path.basename(dir);
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    name = pkg.productName || pkg.name || name;
  } catch {
    // sin package.json: el nombre de la carpeta
  }
  try {
    electronPackageDir(dir);
    return { dir, name, launchable: true };
  } catch (err) {
    return { dir, name, launchable: false, reason: err.message };
  }
}

function tail(file, lines = 20) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

export async function launchApp({ project, args = [] } = {}) {
  const info = projectInfo(project);
  const electron = await resolveElectron(info.dir);
  const cdpPort = await freePort(CDP_PORT);
  const inspectPort = await freePort(INSPECT_PORT, [cdpPort]);
  mkdirSync(STATE_DIR, { recursive: true });
  // La salida va a un archivo, no a un pipe: la app sigue viva aunque se cierre quien la lanzó.
  const log = path.join(STATE_DIR, `app-${cdpPort}.log`);
  const fd = openSync(log, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [`--inspect=${inspectPort}`, `--remote-debugging-port=${cdpPort}`, '.', ...args], {
    cwd: info.dir,
    env,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  let exited = null;
  child.once('exit', (code, signal) => (exited = `exited (code ${code}${signal ? `, ${signal}` : ''})`));
  child.once('error', (err) => (exited = err.message));
  child.unref();

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (!(await probe(cdpPort))) {
    if (exited || Date.now() > deadline) {
      if (!exited) child.kill();
      const output = tail(log);
      throw new Error(`${info.name} ${exited || 'did not open its debugging port in time'}${output ? `:\n${output}` : ''}`);
    }
    await sleep(200);
  }
  updateState((s) => {
    s[cdpPort] = { cdpPort, inspectPort, pid: child.pid, project: info.dir, name: info.name, log, startedAt: new Date().toISOString() };
  });
  const until = Date.now() + FIRST_WINDOW_TIMEOUT_MS;
  let app;
  do {
    app = (await listWindows()).find((a) => a.cdpPort === cdpPort);
    if (app?.windows.length) break;
    await sleep(250);
  } while (Date.now() < until);
  return app;
}

export async function attachApp({ port, inspectPort } = {}) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid('port must be a TCP port');
  const info = await probe(port);
  if (!info) throw invalid(`Nothing answers CDP on port ${port}. Start the app with --remote-debugging-port=${port}.`, 404);
  if (inspectPort !== undefined && inspectPort !== null && inspectPort !== '') {
    inspectPort = Number(inspectPort);
    if (!(await inspectorTarget(inspectPort))) {
      throw invalid(`No Node inspector on port ${inspectPort}. Start the app with --inspect=${inspectPort}.`, 404);
    }
  } else {
    inspectPort = readState()[port]?.inspectPort ?? null;
  }
  updateState((s) => {
    s[port] = { ...s[port], cdpPort: port, inspectPort, name: s[port]?.name || nameFromUserAgent(info.userAgent) };
  });
  return (await listWindows()).find((a) => a.cdpPort === port);
}

// ---------- Conexiones CDP ----------
// Una conexión por ventana y otra por proceso main, compartidas por todo el proceso (sesiones del
// visor y acciones). Cada una junta los logs de consola en el buffer de su app.

const runtimes = new Map(); // cdpPort → { pages, mains, logs, seen }

function runtimeOf(app) {
  let rt = runtimes.get(app.cdpPort);
  // Otra app (o la misma reiniciada) en el puerto: logs y conexiones empiezan de cero.
  if (!rt || (app.instance && rt.instance !== app.instance)) {
    rt = { instance: app.instance, pages: new Map(), mains: new Map(), logs: [], seen: new Set() };
    runtimes.set(app.cdpPort, rt);
  }
  return rt;
}

function formatArg(arg) {
  if (arg.type === 'string') return arg.value;
  if ('value' in arg) return JSON.stringify(arg.value);
  if (arg.unserializableValue) return arg.unserializableValue;
  if (arg.preview?.properties) {
    const props = arg.preview.properties.map((p) => `${p.name}: ${p.value ?? p.type}`).join(', ');
    return arg.preview.subtype === 'array' ? `[${props}]` : `{${props}${arg.preview.overflow ? ', …' : ''}}`;
  }
  return arg.description ?? arg.type;
}

const LEVELS = { warning: 'warn', verbose: 'debug', assert: 'error', trace: 'log', dir: 'log', table: 'log' };

function pushLog(rt, entry) {
  // Runtime.enable repite los mensajes anteriores al reconectar: se descartan los ya vistos.
  const key = `${entry.source}|${entry.window || ''}|${entry.time}|${entry.text}`;
  if (rt.seen.has(key)) return;
  rt.seen.add(key);
  rt.logs.push(entry);
  if (rt.logs.length > MAX_LOGS) {
    const old = rt.logs.splice(0, rt.logs.length - MAX_LOGS);
    for (const e of old) rt.seen.delete(`${e.source}|${e.window || ''}|${e.time}|${e.text}`);
  }
}

function collectLogs(rt, client, source, window) {
  client.on('Runtime.consoleAPICalled', ({ type, args, timestamp }) =>
    pushLog(rt, { time: timestamp, source, window, level: LEVELS[type] || type, text: args.map(formatArg).join(' ') }),
  );
  client.on('Runtime.exceptionThrown', ({ timestamp, exceptionDetails: d }) =>
    pushLog(rt, { time: timestamp, source, window, level: 'error', text: d.exception?.description || d.text }),
  );
  client.on('Log.entryAdded', ({ entry }) =>
    pushLog(rt, { time: entry.timestamp, source, window, level: LEVELS[entry.level] || entry.level, text: entry.url ? `${entry.text} (${entry.url})` : entry.text }),
  );
}

function cached(map, key, connect) {
  let p = map.get(key);
  if (p) return p;
  p = connect().then((client) => {
    client.on('close', () => map.get(key) === p && map.delete(key));
    return client;
  });
  p.catch(() => map.get(key) === p && map.delete(key));
  map.set(key, p);
  return p;
}

export function pageClient(app, targetId) {
  const rt = runtimeOf(app);
  return cached(rt.pages, targetId, async () => {
    const client = await CdpClient.connect(`ws://127.0.0.1:${app.cdpPort}/devtools/page/${targetId}`);
    collectLogs(rt, client, 'renderer', targetId);
    await Promise.all([client.send('Runtime.enable'), client.send('Log.enable'), client.send('Page.enable')]);
    return client;
  });
}

async function inspectorTarget(port) {
  const targets = await fetchJson(port, '/json/list', { timeout: 800 }).catch(() => null);
  return targets?.find((t) => t.type === 'node') || null;
}

function mainClient(app) {
  if (!app.inspectPort) {
    return Promise.reject(
      invalid(
        `The main process of ${app.name} is not reachable. Launch the app with launch_app, or start it with ` +
          '--inspect=<port> and attach with that inspect port.',
      ),
    );
  }
  const rt = runtimeOf(app);
  return cached(rt.mains, app.inspectPort, async () => {
    const target = await inspectorTarget(app.inspectPort);
    if (!target) throw invalid(`No Node inspector on port ${app.inspectPort}`, 404);
    const client = await CdpClient.connect(target.webSocketDebuggerUrl);
    collectLogs(rt, client, 'main');
    await client.send('Runtime.enable');
    return client;
  });
}

export async function evaluateMain(app, expression, { timeout } = {}) {
  return evaluate(await mainClient(app), expression, { commandLineAPI: true, timeout });
}

// Expresión del main que obtiene el BrowserWindow de un target CDP (o lanza).
const winExpr = (targetId) => `(() => {
  const { webContents, BrowserWindow } = require('electron');
  const wc = webContents.fromDevToolsTargetId(${JSON.stringify(targetId)});
  const win = wc && BrowserWindow.fromWebContents(wc);
  if (!win) throw new Error('This target is not the page of a BrowserWindow');
  return win;
})()`;

// ---------- Input ----------

const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

export function modifierMask(modifiers = []) {
  if (typeof modifiers === 'number') return modifiers;
  return modifiers.reduce((mask, m) => {
    const bit = MODIFIER_BITS[String(m).toLowerCase()];
    if (!bit) throw invalid(`Unknown modifier "${m}" (alt, ctrl, meta, shift)`);
    return mask | bit;
  }, 0);
}

const NAMED_KEYS = {
  Enter: [13, '\r'],
  Tab: [9],
  Backspace: [8],
  Delete: [46],
  Escape: [27],
  Space: [32, ' '],
  ArrowUp: [38],
  ArrowDown: [40],
  ArrowLeft: [37],
  ArrowRight: [39],
  Home: [36],
  End: [35],
  PageUp: [33],
  PageDown: [34],
  Insert: [45],
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, [112 + i]])),
};

const KEY_ALIASES = { esc: 'Escape', return: 'Enter', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ' ': 'Space' };

export const KEY_NAMES = Object.keys(NAMED_KEYS);

export function keyDefinition(key) {
  const name = KEY_ALIASES[String(key).toLowerCase()] || Object.keys(NAMED_KEYS).find((k) => k.toLowerCase() === String(key).toLowerCase());
  if (name) {
    const [keyCode, text] = NAMED_KEYS[name];
    return { key: name === 'Space' ? ' ' : name, code: name, keyCode, text };
  }
  if (/^[a-z]$/i.test(key)) return { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key };
  if (/^\d$/.test(key)) return { key, code: `Digit${key}`, keyCode: 48 + Number(key), text: key };
  if ([...key].length === 1) return { key, code: '', keyCode: 0, text: key };
  throw invalid(`Unknown key "${key}". Use a single character or one of: ${KEY_NAMES.join(', ')}`);
}

// En macOS los atajos de edición (⌘A, ⌘C…) los resuelve el menú nativo, que no ve los eventos de
// CDP: se mandan como comandos de edición del renderer.
const MAC_COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' };

function editCommands(key, mask) {
  if (!IS_MAC || !(mask & 4) || mask & 3) return undefined;
  const k = String(key).toLowerCase();
  if (k === 'z' && mask & 8) return ['redo'];
  return MAC_COMMANDS[k] ? [MAC_COMMANDS[k]] : undefined;
}

// type: 'down', 'up' o 'press' (down + up). def: { key, code, keyCode, text }.
export async function dispatchKey(page, type, def, mask = 0) {
  // Con Ctrl o Meta la tecla no escribe texto (con Alt sí: ⌥E, ⌥N… en macOS).
  const text = mask & 6 ? undefined : def.text;
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers: mask };
  if (type !== 'up') {
    await page.send('Input.dispatchKeyEvent', {
      ...base,
      type: text ? 'keyDown' : 'rawKeyDown',
      text,
      unmodifiedText: text,
      autoRepeat: Boolean(def.repeat),
      commands: editCommands(def.key, mask),
    });
  }
  if (type !== 'down') await page.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

export async function viewport(page) {
  const { cssVisualViewport: vp } = await page.send('Page.getLayoutMetrics');
  return { width: vp.clientWidth, height: vp.clientHeight, pageX: vp.pageX, pageY: vp.pageY };
}

const BUTTONS = { left: 1, right: 2, middle: 4 };

function mouse(page, type, x, y, extra = {}) {
  return page.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
}

// ---------- Árbol de accesibilidad ----------

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'listitem', 'row', 'cell',
]);
const SKIP_ROLES = new Set(['generic', 'none', 'InlineTextBox', 'LineBreak']);
const MAX_AX_LINES = 1500;

async function accessibilityTree(page, { interactiveOnly = false } = {}) {
  const { nodes } = await page.send('Accessibility.getFullAXTree');
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const vp = await viewport(page);
  await page.send('DOM.getDocument', { depth: 0 }); // getBoxModel necesita el documento cargado
  const lines = [];
  let offScreen = 0;
  // Centro normalizado del elemento, o null si está fuera de la vista.
  const center = async (n) => {
    if (!n.backendDOMNodeId) return '';
    try {
      const { model } = await page.send('DOM.getBoxModel', { backendNodeId: n.backendDOMNodeId });
      const q = model.border;
      const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
      const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
      if (cx < 0 || cy < 0 || cx > vp.width || cy > vp.height) return null;
      return ` @(${(cx / vp.width).toFixed(3)}, ${(cy / vp.height).toFixed(3)})`;
    } catch {
      return '';
    }
  };
  // Sin nombre accesible (p. ej. un <li>), se toma el primer texto de sus hijos.
  const textOf = (n, depth = 0) => {
    if (n.role?.value === 'StaticText') return n.name?.value || '';
    if (depth > 4) return '';
    for (const id of n.childIds || []) {
      const child = byId.get(id);
      const text = child && textOf(child, depth + 1);
      if (text) return text;
    }
    return '';
  };
  const walk = async (n, depth, parentName) => {
    if (lines.length >= MAX_AX_LINES) return;
    const role = n.role?.value || '';
    const interactive = INTERACTIVE.has(role);
    const name = n.name?.value || (interactive ? textOf(n).slice(0, 80) : '');
    const value = n.value?.value;
    const show =
      !n.ignored &&
      !SKIP_ROLES.has(role) &&
      !(role === 'StaticText' && (name === parentName || interactiveOnly)) &&
      (!interactiveOnly || interactive) &&
      (name || value !== undefined || interactive || !['StaticText', 'paragraph', 'group', 'section'].includes(role));
    let nextDepth = depth;
    if (show) {
      const where = interactive ? await center(n) : '';
      if (where === null && interactiveOnly) {
        offScreen++;
      } else {
        const flags = (n.properties || [])
          .filter((p) => ['focused', 'checked', 'disabled', 'expanded', 'selected', 'pressed'].includes(p.name) && p.value?.value)
          .map((p) => (p.value.value === true ? p.name : `${p.name}=${p.value.value}`));
        lines.push(
          `${'  '.repeat(interactiveOnly ? 0 : depth)}- ${role === 'StaticText' ? 'text' : role}` +
            `${name ? ` ${JSON.stringify(name)}` : ''}${value !== undefined && value !== '' ? ` value=${JSON.stringify(value)}` : ''}` +
            `${flags.length ? ` [${flags.join(', ')}]` : ''}${where === null ? ' (off screen)' : where}`,
        );
      }
      nextDepth = depth + 1;
    }
    for (const id of n.childIds || []) {
      const child = byId.get(id);
      if (child) await walk(child, nextDepth, name || parentName);
    }
  };
  const root = nodes.find((n) => !n.parentId) || nodes[0];
  if (root) await walk(root, 0, '');
  if (offScreen) lines.push(`(${offScreen} more off screen; scroll to reach them)`);
  if (lines.length >= MAX_AX_LINES) lines.push(`… truncated at ${MAX_AX_LINES} lines; use interactive_only`);
  return lines.join('\n');
}

// ---------- Acciones de alto nivel ----------
// Las usan la API HTTP del visor y el MCP cuando el visor no está corriendo.

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v)));

export function createActions() {
  const target = async (windowArg) => {
    const w = await resolveWindow(windowArg);
    return { w, page: await pageClient(w.app, w.id) };
  };
  const at = async (page, x, y) => {
    const vp = await viewport(page);
    return { x: clamp01(x) * vp.width, y: clamp01(y) * vp.height };
  };

  return {
    windows: () => listWindows(),
    project: ({ project } = {}) => projectInfo(project),
    launch: ({ project } = {}) => launchApp({ project }),
    attach: ({ port, inspectPort }) => attachApp({ port, inspectPort }),

    screenshot: async ({ window, max }) => {
      const { w, page } = await target(window);
      const vp = await viewport(page);
      const dpr = await evaluate(page, 'devicePixelRatio');
      const scale = Number(max) ? Math.min(1, Number(max) / (Math.max(vp.width, vp.height) * dpr)) : 1;
      const { data } = await page.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: vp.pageX, y: vp.pageY, width: vp.width, height: vp.height, scale },
      });
      const png = Buffer.from(data, 'base64');
      return { data: png, mimeType: 'image/png', width: png.readUInt32BE(16), height: png.readUInt32BE(20), viewport: { width: vp.width, height: vp.height }, window: w.id };
    },

    click: async ({ window, x, y, button = 'left', count = 1, modifiers }) => {
      const { page } = await target(window);
      if (!BUTTONS[button]) throw invalid('button must be left, right or middle');
      const p = await at(page, x, y);
      const mask = modifierMask(modifiers);
      await mouse(page, 'mouseMoved', p.x, p.y, { modifiers: mask });
      for (let i = 1; i <= Math.max(1, Math.min(3, Number(count) || 1)); i++) {
        await mouse(page, 'mousePressed', p.x, p.y, { button, buttons: BUTTONS[button], clickCount: i, modifiers: mask });
        await mouse(page, 'mouseReleased', p.x, p.y, { button, buttons: 0, clickCount: i, modifiers: mask });
      }
      return { ok: true, x: p.x, y: p.y };
    },

    drag: async ({ window, x1, y1, x2, y2, ms = 300, modifiers }) => {
      const { page } = await target(window);
      const a = await at(page, x1, y1);
      const b = await at(page, x2, y2);
      const mask = modifierMask(modifiers);
      const duration = Math.max(0, Math.min(10000, Number(ms) || 0));
      const steps = Math.max(5, Math.round(duration / 16));
      await mouse(page, 'mouseMoved', a.x, a.y, { modifiers: mask });
      await mouse(page, 'mousePressed', a.x, a.y, { button: 'left', buttons: 1, clickCount: 1, modifiers: mask });
      for (let i = 1; i <= steps; i++) {
        await sleep(duration / steps);
        const t = i / steps;
        await mouse(page, 'mouseMoved', a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, { button: 'left', buttons: 1, modifiers: mask });
      }
      await mouse(page, 'mouseReleased', b.x, b.y, { button: 'left', buttons: 0, clickCount: 1, modifiers: mask });
      return { ok: true };
    },

    hover: async ({ window, x, y }) => {
      const { page } = await target(window);
      const p = await at(page, x, y);
      await mouse(page, 'mouseMoved', p.x, p.y);
      return { ok: true };
    },

    scroll: async ({ window, x = 0.5, y = 0.5, dx = 0, dy = 0 }) => {
      const { page } = await target(window);
      const p = await at(page, x, y);
      await mouse(page, 'mouseMoved', p.x, p.y);
      await mouse(page, 'mouseWheel', p.x, p.y, { deltaX: Number(dx) || 0, deltaY: Number(dy) || 0 });
      return { ok: true };
    },

    text: async ({ window, text }) => {
      if (typeof text !== 'string' || !text) throw invalid('text is required');
      const { page } = await target(window);
      await page.send('Input.insertText', { text });
      return { ok: true };
    },

    key: async ({ window, key, modifiers }) => {
      if (!key) throw invalid('key is required');
      const { page } = await target(window);
      await dispatchKey(page, 'press', keyDefinition(String(key)), modifierMask(modifiers));
      return { ok: true };
    },

    // Con el main se cambia la ventana real; si no llega al tamaño pedido (pantalla más chica, kiosk,
    // pantalla completa) o con emulate, se emula el viewport exacto. 0 × 0 vuelve al tamaño de la ventana.
    resize: async ({ window, width, height, emulate }) => {
      const { w, page } = await target(window);
      const fit = !Number(width) || !Number(height);
      if (!fit && (Number(width) < 100 || Number(height) < 100 || Number(width) > 8000 || Number(height) > 8000)) {
        throw invalid('width and height must be between 100 and 8000');
      }
      await page.send('Emulation.clearDeviceMetricsOverride');
      if (fit) return { ...(await viewport(page)), via: 'window' };
      const W = Math.round(width);
      const H = Math.round(height);
      const force = emulate === true || emulate === 'true';
      let reached = null;
      if (w.app.main && !force) {
        await evaluateMain(w.app, `(${winExpr(w.id)}).setContentSize(${W}, ${H}), 0`);
        await sleep(150);
        reached = await viewport(page);
        if (reached.width === W && reached.height === H) return { ...reached, via: 'window' };
      }
      await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 0, mobile: false });
      const result = { ...(await viewport(page)), via: 'viewport emulation' };
      if (reached) result.note = `The window only reached ${reached.width}×${reached.height} (screen size, kiosk or full screen), so the page is emulated at ${W}×${H}.`;
      return result;
    },

    reload: async ({ window, ignoreCache }) => {
      const { page } = await target(window);
      await page.send('Page.reload', { ignoreCache: Boolean(ignoreCache) });
      return { ok: true };
    },

    evaluate: async ({ window, expression }) => {
      if (!expression) throw invalid('expression is required');
      const { page } = await target(window);
      return { value: await evaluate(page, String(expression)) };
    },

    evaluateMain: async ({ app, window, expression }) => {
      if (!expression) throw invalid('expression is required');
      const owner = window ? (await resolveWindow(window)).app : await resolveApp(app);
      return { value: await evaluateMain(owner, String(expression)) };
    },

    axTree: async ({ window, interactiveOnly }) => {
      const { page } = await target(window);
      return { tree: await accessibilityTree(page, { interactiveOnly: interactiveOnly === true || interactiveOnly === 'true' }) };
    },

    logs: async ({ app, window, level, source = 'all', limit = 100 }) => {
      const w = window ? await resolveWindow(window) : null;
      const owner = w ? w.app : await resolveApp(app);
      if (source === 'stdout') {
        if (!owner.log) throw invalid('stdout is only available for apps started with launch_app');
        return { app: owner.id, stdout: tail(owner.log, Math.min(1000, Number(limit) || 100)) };
      }
      // Asegura las conexiones (y el replay de mensajes previos) antes de leer el buffer.
      await Promise.all([...owner.windows.map((x) => pageClient(owner, x.id)), owner.main ? mainClient(owner) : null].map((p) => p?.catch(() => {})));
      await sleep(100);
      const levels = level ? String(level).split(',') : null;
      const logs = runtimeOf(owner)
        .logs.filter((e) => (source === 'all' || e.source === source) && (!w || e.window === w.id || e.source === 'main') && (!levels || levels.includes(e.level)))
        .slice(-Math.min(MAX_LOGS, Number(limit) || 100))
        .map((e) => ({ ...e, time: new Date(e.time).toISOString() }));
      return { app: owner.id, logs };
    },

    devtools: async ({ window }) => {
      const { w } = await target(window);
      if (w.app.main) {
        const open = await evaluateMain(
          w.app,
          `(w => { const wc = w.webContents; if (wc.isDevToolsOpened()) { wc.closeDevTools(); return false; } wc.openDevTools({ mode: 'detach' }); return true; })(${winExpr(w.id)})`,
        );
        return { open };
      }
      const port = w.app.cdpPort;
      return { url: `http://127.0.0.1:${port}/devtools/inspector.html?ws=127.0.0.1:${port}/devtools/page/${w.id}` };
    },
  };
}
