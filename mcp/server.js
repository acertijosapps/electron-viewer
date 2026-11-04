// MCP del visor: herramientas para que Claude maneje apps Electron.
// Habla con la API HTTP del visor (server.js) para que cada acción se vea en vivo en el panel;
// si el visor no está corriendo, usa CDP directo con la misma lógica (lib/electron.js).
// stdout es del protocolo MCP: los logs van a stderr.

import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { KEY_NAMES, createActions } from '../lib/electron.js';

const VIEWER_URL = (process.env.ELECTRON_VIEWER_URL || 'http://localhost:8094').replace(/\/$/, '');
const SCREENSHOT_MAX = Number(process.env.SCREENSHOT_MAX) || 1024;
const VIEWER_TIMEOUT_MS = 60000;

const direct = createActions();

// Error de red (visor apagado) → modo directo. Un error HTTP del visor sí se propaga.
class ViewerDown extends Error {}

async function viewer(method, route, params = {}) {
  const url = new URL(VIEWER_URL + route);
  const init = { method, signal: AbortSignal.timeout(VIEWER_TIMEOUT_MS) };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  } else {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(params);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`The viewer did not answer within ${VIEWER_TIMEOUT_MS / 1000} s`);
    throw new ViewerDown(err.message);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) return res.json();
  const vw = res.headers.get('x-viewport-width');
  return {
    data: Buffer.from(await res.arrayBuffer()),
    mimeType: type,
    width: Number(res.headers.get('x-image-width')),
    height: Number(res.headers.get('x-image-height')),
    window: res.headers.get('x-window'),
    viewport: vw ? { width: Number(vw), height: Number(res.headers.get('x-viewport-height')) } : undefined,
  };
}

// Ejecuta una acción por el visor o, si no está corriendo, por CDP directo.
async function run(action, method, route, params = {}) {
  try {
    return { result: await viewer(method, route, params), via: 'viewer' };
  } catch (err) {
    if (!(err instanceof ViewerDown)) throw err;
    return { result: await direct[action](params), via: 'cdp' };
  }
}

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

const windowArg = z
  .string()
  .optional()
  .describe('Window: target id from list_windows or part of its title. Optional when only one window is open.');
const appArg = z.string().optional().describe('App: id (its CDP port) or name from list_windows. Optional with a single app.');
const coord = (what) => z.number().min(0).max(1).describe(`${what}, normalized 0–1 over the screenshot`);
const modifiersArg = z.array(z.enum(['alt', 'ctrl', 'meta', 'shift'])).optional().describe('Modifier keys held during the action (meta = ⌘ on macOS)');

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const server = new McpServer({ name: 'electron-viewer', version });

server.registerTool(
  'list_windows',
  {
    title: 'List windows',
    description:
      'Lists the running Electron apps (found on CDP ports 9222–9231, launched or attached) and their windows. ' +
      'main=true means the main process is reachable (evaluate_main, real window resizing). ' +
      'Includes the viewer URL to watch a window live in a browser pane.',
    annotations: { readOnlyHint: true },
  },
  async () => {
    const { result: apps, via } = await run('windows', 'GET', '/api/windows');
    return text({
      apps,
      viewer: via === 'viewer' ? VIEWER_URL : `not running (start it with \`npx @acertijosapps/electron-viewer@${version}\`)`,
    });
  },
);

server.registerTool(
  'launch_app',
  {
    title: 'Launch app',
    description:
      'Starts the Electron project on free debugging ports, so both the renderer (CDP) and the main process ' +
      '(Node inspector) are reachable, and waits for the first window. It runs `electron .` with the project\'s own ' +
      'Electron, or the launch command configured with --launch-cmd (e.g. a dev server).',
    inputSchema: {
      project: z.string().optional().describe('Project folder (default: the folder the viewer or MCP was started in)'),
    },
  },
  async ({ project }) => text((await run('launch', 'POST', '/api/launch', { project })).result),
);

server.registerTool(
  'attach',
  {
    title: 'Attach to app',
    description:
      'Attaches to an Electron app already running with --remote-debugging-port=<port> (and optionally ' +
      '--inspect=<inspect_port> for the main process). Apps on ports 9222–9231 are found without attaching.',
    inputSchema: {
      port: z.number().int().min(1).max(65535).describe('CDP port (--remote-debugging-port)'),
      inspect_port: z.number().int().min(1).max(65535).optional().describe('Main process inspector port (--inspect)'),
    },
  },
  async ({ port, inspect_port }) => text((await run('attach', 'POST', '/api/attach', { port, inspectPort: inspect_port })).result),
);

server.registerTool(
  'screenshot',
  {
    title: 'Screenshot',
    description:
      'Captures the window content (PNG). For click, drag, hover and scroll use normalized coordinates: ' +
      'x = pixel_x / image width, y = pixel_y / image height. Native UI (title bar, menus, dialogs) is not included.',
    inputSchema: {
      window: windowArg,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ window }) => {
    const { result: shot } = await run('screenshot', 'GET', '/api/screenshot', { window, max: SCREENSHOT_MAX });
    const note = `Viewport is ${shot.viewport?.width}×${shot.viewport?.height} CSS px (image ${shot.width}×${shot.height}, longest side ≤ ${SCREENSHOT_MAX}).`;
    return {
      content: [
        { type: 'image', data: shot.data.toString('base64'), mimeType: shot.mimeType },
        { type: 'text', text: `${note} Window ${shot.window}.` },
      ],
    };
  },
);

server.registerTool(
  'click',
  {
    title: 'Click',
    description: 'Clicks a point of the window content (Input.dispatchMouseEvent). count=2 is a double click.',
    inputSchema: {
      x: coord('x coordinate'),
      y: coord('y coordinate'),
      button: z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button'),
      count: z.number().int().min(1).max(3).default(1).describe('Click count (2 = double click)'),
      modifiers: modifiersArg,
      window: windowArg,
    },
  },
  async ({ x, y, button, count, modifiers, window }) => {
    await run('click', 'POST', '/api/click', { window, x, y, button, count, modifiers });
    return text(`${count === 2 ? 'double-' : ''}clicked ${button} at (${x.toFixed(3)}, ${y.toFixed(3)})`);
  },
);

server.registerTool(
  'drag',
  {
    title: 'Drag',
    description: 'Presses the left button at one point, moves to another with intermediate steps and releases (a real drag).',
    inputSchema: {
      x1: coord('Start x'),
      y1: coord('Start y'),
      x2: coord('End x'),
      y2: coord('End y'),
      duration_ms: z.number().int().min(0).max(10000).default(300).describe('Drag duration in ms'),
      modifiers: modifiersArg,
      window: windowArg,
    },
  },
  async ({ x1, y1, x2, y2, duration_ms, modifiers, window }) => {
    await run('drag', 'POST', '/api/drag', { window, x1, y1, x2, y2, ms: duration_ms, modifiers });
    return text(`dragged (${x1.toFixed(3)}, ${y1.toFixed(3)}) → (${x2.toFixed(3)}, ${y2.toFixed(3)}) in ${duration_ms} ms`);
  },
);

server.registerTool(
  'hover',
  {
    title: 'Hover',
    description: 'Moves the mouse to a point without clicking (hover effects, tooltips).',
    inputSchema: { x: coord('x coordinate'), y: coord('y coordinate'), window: windowArg },
  },
  async ({ x, y, window }) => {
    await run('hover', 'POST', '/api/hover', { window, x, y });
    return text(`hovering at (${x.toFixed(3)}, ${y.toFixed(3)})`);
  },
);

server.registerTool(
  'tap',
  {
    title: 'Tap',
    description:
      'Taps a point with one finger (Input.dispatchTouchEvent): the page gets touch and pointer events with ' +
      'pointerType "touch". The first touch action turns on touch emulation for the window (maxTouchPoints, pointer: coarse).',
    inputSchema: { x: coord('x coordinate'), y: coord('y coordinate'), window: windowArg },
  },
  async ({ x, y, window }) => {
    await run('tap', 'POST', '/api/tap', { window, x, y });
    return text(`tapped (${x.toFixed(3)}, ${y.toFixed(3)})`);
  },
);

server.registerTool(
  'swipe',
  {
    title: 'Swipe',
    description: 'Swipes one finger from one point to another (touch events; use drag for the mouse). Scrolls touch lists and drives swipe gestures.',
    inputSchema: {
      x1: coord('Start x'),
      y1: coord('Start y'),
      x2: coord('End x'),
      y2: coord('End y'),
      duration_ms: z.number().int().min(50).max(10000).default(300).describe('Gesture duration in ms'),
      window: windowArg,
    },
  },
  async ({ x1, y1, x2, y2, duration_ms, window }) => {
    await run('swipe', 'POST', '/api/swipe', { window, x1, y1, x2, y2, ms: duration_ms });
    return text(`swiped (${x1.toFixed(3)}, ${y1.toFixed(3)}) → (${x2.toFixed(3)}, ${y2.toFixed(3)}) in ${duration_ms} ms`);
  },
);

server.registerTool(
  'long_press',
  {
    title: 'Long press',
    description:
      'Holds one finger on a point and releases it. Apps that time touchstart themselves see a long press; ' +
      "Chromium on desktop doesn't turn it into a context menu.",
    inputSchema: {
      x: coord('x coordinate'),
      y: coord('y coordinate'),
      duration_ms: z.number().int().min(100).max(10000).default(800).describe('How long the finger stays down, in ms'),
      window: windowArg,
    },
  },
  async ({ x, y, duration_ms, window }) => {
    await run('longPress', 'POST', '/api/long-press', { window, x, y, ms: duration_ms });
    return text(`long-pressed (${x.toFixed(3)}, ${y.toFixed(3)}) for ${duration_ms} ms`);
  },
);

server.registerTool(
  'pinch',
  {
    title: 'Pinch',
    description: 'Two-finger pinch centered on a point: scale > 1 spreads the fingers (zoom in), scale < 1 brings them together.',
    inputSchema: {
      x: coord('Center x').default(0.5),
      y: coord('Center y').default(0.5),
      scale: z.number().min(0.1).max(10).describe('Final finger distance ÷ initial distance, e.g. 2 or 0.5'),
      duration_ms: z.number().int().min(100).max(10000).default(400).describe('Gesture duration in ms'),
      window: windowArg,
    },
  },
  async ({ x, y, scale, duration_ms, window }) => {
    const { result } = await run('pinch', 'POST', '/api/pinch', { window, x, y, scale, ms: duration_ms });
    return text(`pinched ×${result.scale} at (${x.toFixed(3)}, ${y.toFixed(3)})`);
  },
);

server.registerTool(
  'scroll',
  {
    title: 'Scroll',
    description: 'Scrolls with the mouse wheel at a point. Positive delta_y scrolls down; deltas are in CSS pixels.',
    inputSchema: {
      x: coord('x coordinate').default(0.5),
      y: coord('y coordinate').default(0.5),
      delta_x: z.number().default(0).describe('Horizontal delta in CSS px'),
      delta_y: z.number().default(400).describe('Vertical delta in CSS px'),
      window: windowArg,
    },
  },
  async ({ x, y, delta_x, delta_y, window }) => {
    await run('scroll', 'POST', '/api/scroll', { window, x, y, dx: delta_x, dy: delta_y });
    return text(`scrolled (${delta_x}, ${delta_y}) at (${x.toFixed(3)}, ${y.toFixed(3)})`);
  },
);

server.registerTool(
  'type_text',
  {
    title: 'Type text',
    description: 'Types text into the focused element (Input.insertText; any Unicode). Click the field first; for Enter or shortcuts use press_key.',
    inputSchema: { text: z.string().min(1).max(10000).describe('Text to type'), window: windowArg },
  },
  async ({ text: value, window }) => {
    await run('text', 'POST', '/api/text', { window, text: value });
    return text(`typed ${JSON.stringify(value)}`);
  },
);

server.registerTool(
  'press_key',
  {
    title: 'Press key',
    description:
      `Presses a key, optionally with modifiers (e.g. key "a" + ["meta"] selects all on macOS). Named keys: ${KEY_NAMES.join(', ')}; ` +
      'or any single character.',
    inputSchema: { key: z.string().min(1).describe('Key name or single character'), modifiers: modifiersArg, window: windowArg },
  },
  async ({ key, modifiers, window }) => {
    await run('key', 'POST', '/api/key', { window, key, modifiers });
    return text(`pressed ${[...(modifiers || []), key].join('+')}`);
  },
);

server.registerTool(
  'resize_window',
  {
    title: 'Resize window',
    description:
      'Sets the size of the window content area in CSS px. With the main process it resizes the real window; ' +
      'if the window cannot reach that size (smaller screen, kiosk, full screen), without the main process or with ' +
      'emulate=true, the page viewport is emulated at the exact size instead. Width and height 0 restore the window size.',
    inputSchema: {
      width: z.number().int().min(0).max(8000).describe('Content width in CSS px'),
      height: z.number().int().min(0).max(8000).describe('Content height in CSS px'),
      emulate: z.boolean().optional().describe('Emulate the viewport without touching the real window'),
      window: windowArg,
    },
  },
  async ({ width, height, emulate, window }) =>
    text((await run('resize', 'POST', '/api/resize', { window, width, height, emulate })).result),
);

server.registerTool(
  'reload',
  {
    title: 'Reload',
    description: 'Reloads the page of the window (renderer only; the main process keeps running).',
    inputSchema: { ignore_cache: z.boolean().optional().describe('Bypass the cache'), window: windowArg },
  },
  async ({ ignore_cache, window }) => {
    await run('reload', 'POST', '/api/reload', { window, ignoreCache: ignore_cache });
    return text('reloaded');
  },
);

server.registerTool(
  'evaluate',
  {
    title: 'Evaluate in renderer',
    description:
      'Evaluates a JavaScript expression in the window page (main world) and returns its JSON value. Promises are awaited.',
    inputSchema: { expression: z.string().min(1).describe('JavaScript expression'), window: windowArg },
  },
  async ({ expression, window }) => text((await run('evaluate', 'POST', '/api/evaluate', { window, expression })).result),
);

server.registerTool(
  'evaluate_main',
  {
    title: 'Evaluate in main process',
    description:
      "Evaluates a JavaScript expression in the app's main process (Node inspector) and returns its JSON value. " +
      "`require` is available, e.g. require('electron').BrowserWindow.getAllWindows().map(w => w.getTitle()). " +
      'Promises are awaited. Needs main=true in list_windows.',
    inputSchema: { expression: z.string().min(1).describe('JavaScript expression'), app: appArg },
  },
  async ({ expression, app }) => text((await run('evaluateMain', 'POST', '/api/evaluate-main', { app, expression })).result),
);

server.registerTool(
  'get_accessibility_tree',
  {
    title: 'Accessibility tree',
    description:
      'Returns the accessibility tree of the window as indented text (role "name" value [state]). Interactive ' +
      'elements carry @(x, y): their center, normalized like click coordinates.',
    inputSchema: {
      interactive_only: z.boolean().default(false).describe('Only interactive elements, as a flat list'),
      window: windowArg,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ interactive_only, window }) =>
    text((await run('axTree', 'GET', '/api/ax-tree', { window, interactiveOnly: interactive_only })).result.tree),
);

server.registerTool(
  'get_console_logs',
  {
    title: 'Console logs',
    description:
      'Console messages and uncaught exceptions of the app: renderer windows and main process (up to the last 1000). ' +
      'source "stdout" returns the raw output of an app started with launch_app.',
    inputSchema: {
      level: z.string().optional().describe('Comma-separated levels to keep: log, info, warn, error, debug'),
      source: z.enum(['all', 'renderer', 'main', 'stdout']).default('all').describe('Where the messages come from'),
      limit: z.number().int().min(1).max(1000).default(100).describe('Most recent entries to return'),
      window: windowArg.describe('Only this window (plus the main process)'),
      app: appArg,
    },
    annotations: { readOnlyHint: true },
  },
  async ({ level, source, limit, window, app }) => text((await run('logs', 'GET', '/api/logs', { level, source, limit, window, app })).result),
);

await server.connect(new StdioServerTransport());
console.error(`electron-viewer MCP ready (viewer: ${VIEWER_URL})`);
