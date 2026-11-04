#!/usr/bin/env node
// CLI del paquete: `electron-viewer` arranca el visor; `electron-viewer mcp`, el MCP por stdio.

import path from 'node:path';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `electron-viewer ${version}

Live viewer for Electron apps in the browser, plus an MCP server to drive them.

Usage:
  electron-viewer [options]        Start the viewer (http://localhost:8094)
  electron-viewer mcp [options]    Start the MCP server on stdio

Common options:
      --project <dir>      Electron project to launch with "electron ." (default:
                           current folder, env ELECTRON_VIEWER_PROJECT)
      --launch-cmd <cmd>   Launch with this shell command instead (env
                           ELECTRON_VIEWER_LAUNCH_CMD); {cdpPort} and {inspectPort}
                           are replaced with the debugging ports, e.g.
                           "yarn dev --remoteDebuggingPort {cdpPort} --inspect {inspectPort}"

Viewer options:
  -p, --port <port>        Port to listen on (default: 8094, env PORT)
      --host <host>        Interface to bind (default: 127.0.0.1, env HOST)
      --attach <port>      Attach at startup to an app already running with
                           --remote-debugging-port=<port>
      --inspect <port>     With --attach: the app's main process inspector
                           (--inspect=<port>), for evaluate_main, DevTools and
                           real window resizing

MCP options:
      --viewer-url <url>   Viewer to talk to (default: http://localhost:8094,
                           env ELECTRON_VIEWER_URL). Without a running viewer the
                           MCP drives the app over CDP directly.

  -h, --help               Show this help
  -v, --version            Show the version

Apps are found on CDP ports 9222-9231. Launched apps get the first free CDP port
from 9222 and inspector port from 9229.
`;

function fail(message) {
  console.error(`electron-viewer: ${message}\nRun "electron-viewer --help" for usage.`);
  process.exit(2);
}

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'viewer';
if (!['viewer', 'mcp'].includes(command)) fail(`unknown command "${command}"`);

const portValue = (flag, v) => {
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535) fail(`invalid port "${v}" for ${flag}`);
  return v;
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const [flag, inline] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg];
  const value = () => {
    const v = inline ?? args[++i];
    if (v === undefined || v.startsWith('-')) fail(`${flag} needs a value`);
    return v;
  };
  switch (flag) {
    case '-h':
    case '--help':
      process.stdout.write(HELP);
      process.exit(0);
      break;
    case '-v':
    case '--version':
      console.log(version);
      process.exit(0);
      break;
    case '-p':
    case '--port':
      process.env.PORT = portValue(flag, value());
      break;
    case '--host':
      process.env.HOST = value();
      break;
    case '--project':
      process.env.ELECTRON_VIEWER_PROJECT = path.resolve(value());
      break;
    case '--launch-cmd': {
      const cmd = value();
      if (!cmd.includes('{cdpPort}')) fail('--launch-cmd must include {cdpPort}');
      process.env.ELECTRON_VIEWER_LAUNCH_CMD = cmd;
      break;
    }
    case '--attach':
      process.env.ELECTRON_VIEWER_ATTACH = portValue(flag, value());
      break;
    case '--inspect':
      process.env.ELECTRON_VIEWER_INSPECT = portValue(flag, value());
      break;
    case '--viewer-url':
      process.env.ELECTRON_VIEWER_URL = value();
      break;
    default:
      fail(`unknown option "${arg}"`);
  }
}

if (process.env.ELECTRON_VIEWER_INSPECT && !process.env.ELECTRON_VIEWER_ATTACH) fail('--inspect needs --attach');

// Los módulos arrancan al importarse; las opciones ya quedaron en process.env.
await import(command === 'mcp' ? '../mcp/server.js' : '../server.js');
