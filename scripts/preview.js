// Local UI preview: serves web/ on 127.0.0.1 without the relay or a login.
// Reads come from the real agent code (state, installed apps, icons); every change is only
// simulated in memory, so nothing on the Mac is touched.
//   npm run preview   ->   http://127.0.0.1:3099/app/
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatch } from '../agent/registry.js';
import { validateParams } from '../shared/actions.js';

const PORT = Number(process.env.PREVIEW_PORT || 3099);
const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

let state = null;

async function currentState() {
  state ??= await dispatch('state.get', {});
  state.ts = Date.now();
  return state;
}

function simulate(action, params, confirmed) {
  const s = state;
  switch (action) {
    case 'wifi.set':
      s.network.wifi.on = params.on;
      return { on: params.on, restoreAt: params.restoreAfterSec ? Date.now() + params.restoreAfterSec * 1000 : null };
    case 'bluetooth.set':
      s.network.bluetooth = { on: params.on };
      return { on: params.on };
    case 'proxy.set':
      s.network.proxy = { ...(s.network.proxy ?? {}), on: params.on };
      return { on: params.on };
    case 'display.brightness.set': {
      const screen = s.display.screens.find((item) => item.id === params.display);
      if (screen) screen.brightness = params.value;
      return params;
    }
    case 'display.dark.set':
      s.display.dark = params.on;
      return params;
    case 'display.nightShift.set':
      s.display.nightShift = { ...(s.display.nightShift ?? {}), enabled: params.on };
      return params;
    case 'display.stageManager.set':
      s.display.stageManager = params.on;
      return params;
    case 'sound.volume.set':
      s.sound.volume = params.value;
      return params;
    case 'sound.mute.set':
      s.sound.muted = params.on;
      return params;
    case 'sound.output.set':
      for (const output of s.sound.outputs) output.current = output.id === params.id;
      return params;
    case 'apps.hide': {
      const app = s.apps.find((item) => item.pid === params.pid);
      if (app) app.hidden = true;
      return { pid: params.pid, name: app?.name };
    }
    case 'apps.quit':
    case 'apps.forceQuit': {
      if (action === 'apps.forceQuit' && !confirmed) {
        return { needsConfirm: true, reason: '强制退出会丢失未保存的内容（预览模拟）' };
      }
      const app = s.apps.find((item) => item.pid === params.pid);
      s.apps = s.apps.filter((item) => item.pid !== params.pid);
      return { pid: params.pid, name: app?.name, stillRunning: false };
    }
    default:
      return { ...params };
  }
}

async function handleAction({ action, params = {}, confirmed = false }) {
  const check = validateParams(action, params);
  if (!check.ok) return { ok: false, error: 'bad-params', message: check.error };
  if (action === 'state.get') return { ok: true, result: await currentState() };
  if (action === 'apps.installed' || action === 'apps.icon') return { ok: true, result: await dispatch(action, check.params) };
  await currentState();
  const result = simulate(action, check.params, confirmed === true);
  return { ok: true, result, state: result.needsConfirm ? undefined : state };
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 16_384) throw new Error('body too large');
  }
  return data ? JSON.parse(data) : {};
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function serveStatic(pathname, res) {
  let relative;
  if (pathname === '/') relative = 'public/login.html';
  else if (pathname === '/app' || pathname === '/app/') relative = 'app/index.html';
  else if (pathname.startsWith('/app/')) relative = `app/${pathname.slice(5)}`;
  else relative = `public/${pathname.slice(1)}`;
  const file = normalize(join(WEB, decodeURIComponent(relative)));
  if (!file.startsWith(WEB.endsWith(sep) ? WEB : WEB + sep)) return send(res, 403, 'forbidden', 'text/plain');
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream');
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
}

const server = createServer(async (req, res) => {
  // Loopback only, and refuse foreign Host headers (DNS rebinding).
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')) return send(res, 403, 'forbidden', 'text/plain');
  const { pathname } = new URL(req.url, 'http://preview');
  try {
    if (pathname === '/api/state') {
      return send(res, 200, { ok: true, online: true, lastSeen: Date.now(), stateAt: Date.now(), state: await currentState() });
    }
    if (pathname === '/api/action' && req.method === 'POST') {
      const reply = await handleAction(await readBody(req));
      return send(res, reply.ok ? 200 : 400, reply);
    }
    if (pathname === '/api/installed') return send(res, 200, { ok: true, apps: await dispatch('apps.installed', {}) });
    if (pathname.startsWith('/api/icon/')) {
      const { png } = await dispatch('apps.icon', { bundleId: decodeURIComponent(pathname.slice('/api/icon/'.length)) });
      return send(res, 200, Buffer.from(png, 'base64'), 'image/png');
    }
    if (pathname === '/auth/logout') return send(res, 200, { ok: true });
    return serveStatic(pathname, res);
  } catch (error) {
    return send(res, 400, { ok: false, error: error.code || 'internal', message: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${PORT}/app/  (reads are real, changes are simulated)`);
});
