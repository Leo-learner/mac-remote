// End-to-end checks of the relay's security boundary with a fake agent.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { base32Encode, hashPassword, totpAt } from '../relay/auth.js';
import { createRelay } from '../relay/server.js';

const WebSocket = createRequire(new URL('../relay/package.json', import.meta.url))('ws');

const PASSWORD = 'test-password-123';
const TOTP_SECRET = base32Encode(randomBytes(20));
const AGENT_TOKEN = randomBytes(32).toString('base64url');
const config = {
  port: 0,
  host: '127.0.0.1',
  publicOrigin: 'http://127.0.0.1',
  passwordHash: '',
  totpSecret: TOTP_SECRET,
  agentTokenSha256: createHash('sha256').update(AGENT_TOKEN).digest('hex'),
  dataDir: '',
};

let relay;
let base;
let cookie = '';
let agentSocket;
const viewerCounts = [];
const counter = () => Math.floor(Date.now() / 30_000);

before(async () => {
  config.passwordHash = await hashPassword(PASSWORD);
  config.dataDir = await mkdtemp(join(tmpdir(), 'relay-test-'));
  relay = createRelay(config);
  const port = await relay.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
  config.publicOrigin = base; // read per request by the Origin check
});

after(async () => {
  agentSocket?.terminate();
  await relay.close();
});

const request = (path, { method = 'GET', body, headers = {} } = {}) => fetch(base + path, {
  method,
  redirect: 'manual',
  headers: { origin: base, cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined,
});
const login = (code, extra = {}) => request('/auth/login', { method: 'POST', body: { password: PASSWORD, code }, ...extra });

// The message handler is attached before 'open': the relay speaks first (viewer count), and
// EventEmitter does not buffer events that fire before anyone listens.
function connectAgent(token, onMessage = () => {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/agent`, { headers: { authorization: `Bearer ${token}` } });
    ws.on('message', (data) => onMessage(ws, JSON.parse(data)));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

test('anonymous visitors only get a neutral login page', async () => {
  const res = await request('/', { headers: { cookie: '' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  const publicFiles = [await res.text()];
  for (const file of ['login.js', 'login.css', 'manifest.webmanifest']) {
    publicFiles.push(await readFile(new URL(`../web/public/${file}`, import.meta.url), 'utf8'));
  }
  for (const text of publicFiles) {
    assert.doesNotMatch(text, /remote|control|terminal|mac\b|远程|控制|终端/i);
  }
  assert.equal(await (await request('/robots.txt')).text(), 'User-agent: *\nDisallow: /\n');
});

test('the control UI and API are closed without a session', async () => {
  for (const path of ['/app/', '/app/app.js', '/app/app.css']) {
    const res = await request(path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get('location'), '/');
  }
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/api/action', { method: 'POST', body: { action: 'state.get' } })).status, 401);
  assert.equal((await request('/api/icon/com.apple.Safari')).status, 401);
});

test('login rejects a foreign Origin and wrong credentials', async () => {
  assert.equal((await login(totpAt(TOTP_SECRET, counter()), { headers: { origin: 'https://evil.example' } })).status, 403);
  const wrong = await request('/auth/login', { method: 'POST', body: { password: 'nope', code: '000000' } });
  assert.equal(wrong.status, 401);
});

test('password + TOTP logs in; the same code cannot be replayed', async () => {
  const code = totpAt(TOTP_SECRET, counter());
  const res = await login(code);
  assert.equal(res.status, 200);
  const setCookie = res.headers.getSetCookie()[0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(';')[0];
  assert.equal((await login(code, { headers: { cookie: '' } })).status, 401, 'replayed code');
});

test('with a session: UI loads, agent offline is reported', async () => {
  assert.equal((await request('/app/')).status, 200);
  const state = await (await request('/api/state')).json();
  assert.equal(state.online, false);
  const action = await request('/api/action', { method: 'POST', body: { action: 'sound.volume.set', params: { value: 5 } } });
  assert.equal(action.status, 503);
  assert.equal((await request('/api/action', { method: 'POST', body: { action: 'shell.exec' } })).status, 400);
  const foreign = await request('/api/action', { method: 'POST', body: { action: 'state.get' }, headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
});

test('agents need the right token', async () => {
  await assert.rejects(connectAgent('wrong-token'), /401/);
  agentSocket = await connectAgent(AGENT_TOKEN, (ws, message) => {
    if (message.type === 'viewers') viewerCounts.push(message.count);
    if (message.type === 'rpc') {
      ws.send(JSON.stringify({
        type: 'result', id: message.id, ok: true,
        result: { echoed: message.action, params: message.params, confirmed: message.confirmed },
        state: { fake: true },
      }));
    }
  });
});

test('actions are forwarded to the agent and state flows back', async () => {
  const res = await request('/api/action', { method: 'POST', body: { action: 'sound.volume.set', params: { value: 7 }, confirmed: true } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.result, { echoed: 'sound.volume.set', params: { value: 7 }, confirmed: true });
  const state = await (await request('/api/state')).json();
  assert.equal(state.online, true);
  assert.deepEqual(state.state, { fake: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(viewerCounts.includes(1), `viewer count sent to agent: ${viewerCounts}`);
});

test('logout ends the session', async () => {
  assert.equal((await request('/auth/logout', { method: 'POST' })).status, 200);
  assert.equal((await request('/api/state')).status, 401);
});

test('repeated failures are throttled', async () => {
  const bad = () => request('/auth/login', { method: 'POST', body: { password: 'wrong', code: '123456' }, headers: { cookie: '' } });
  const statuses = [];
  for (let i = 0; i < 4; i += 1) statuses.push((await bad()).status);
  assert.deepEqual(statuses.slice(-1), [429], statuses.join(','));
});
