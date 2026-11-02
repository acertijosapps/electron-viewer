// Cliente mínimo de Chrome DevTools Protocol sobre WebSocket. Sirve igual para un target del
// renderer (`--remote-debugging-port`) que para el inspector de Node del proceso main (`--inspect`).

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const CONNECT_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 30000;

export class CdpError extends Error {}

export class CdpClient extends EventEmitter {
  static connect(wsUrl, { timeout = CONNECT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      // Sin Origin: Chromium rechaza orígenes que no estén en --remote-allow-origins.
      const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new CdpError(`Timed out connecting to ${wsUrl}`));
      }, timeout);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(new CdpError(`Could not connect to ${wsUrl}: ${err.message}`));
      });
    });
  }

  constructor(ws) {
    super();
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    ws.on('message', (data) => this.onMessage(data));
    ws.on('close', () => this.onClose());
    ws.on('error', () => {}); // el cierre llega después por 'close'
  }

  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    } else if (msg.method) {
      this.emit(msg.method, msg.params);
      this.emit('event', msg.method, msg.params);
    }
  }

  onClose() {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CdpError(`${p.method}: connection closed`));
    }
    this.pending.clear();
    this.emit('close');
  }

  send(method, params = {}, { timeout = COMMAND_TIMEOUT_MS } = {}) {
    if (this.closed) return Promise.reject(new CdpError(`${method}: connection closed`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method}: no answer within ${timeout / 1000} s`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (!this.closed) this.ws.close();
  }
}

// GET a un endpoint HTTP del depurador (/json/list, /json/version).
export async function fetchJson(port, route, { timeout = 1500 } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new CdpError(`HTTP ${res.status} from port ${port}${route}`);
  return res.json();
}

// Evalúa una expresión y devuelve su valor, o lanza con el mensaje de la excepción.
export async function evaluate(client, expression, { awaitPromise = true, commandLineAPI = false, timeout } = {}) {
  const { result, exceptionDetails } = await client.send(
    'Runtime.evaluate',
    { expression, awaitPromise, returnByValue: true, includeCommandLineAPI: commandLineAPI, userGesture: true },
    { timeout },
  );
  if (exceptionDetails) {
    const ex = exceptionDetails.exception;
    // Un `throw 'texto'` o un rechazo con string no trae description, solo value.
    const message = ex?.description || (ex && 'value' in ex ? String(ex.value) : exceptionDetails.text) || 'Evaluation failed';
    throw Object.assign(new CdpError(message.split('\n')[0].replace(/^Error: /, '')), { status: 400, stack: message });
  }
  return result.type === 'undefined' ? undefined : result.value ?? result.description ?? null;
}
