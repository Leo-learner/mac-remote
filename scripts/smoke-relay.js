// End-to-end smoke test against a running relay + agent (local dev or production):
//   node scripts/smoke-relay.js --env relay/.env --password-file <file> [--base https://host]
// Logs in with the password plus a TOTP code computed from TOTP_SECRET, checks that the agent
// is online, reads state, installed apps and an icon, and runs one harmless action (volume set
// to its current value). Nothing on the Mac changes.
import { readFile } from 'node:fs/promises';
import { totpAt } from '../relay/auth.js';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
if (!option('--env') || !option('--password-file')) {
  console.error('usage: node scripts/smoke-relay.js --env <relay env file> --password-file <file> [--base <origin>]');
  process.exit(1);
}

const env = Object.fromEntries((await readFile(option('--env'), 'utf8'))
  .split('\n')
  .filter((line) => line.includes('=') && !line.startsWith('#'))
  .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const base = (option('--base') ?? env.PUBLIC_ORIGIN).replace(/\/$/, '');
const password = (await readFile(option('--password-file'), 'utf8')).trim();

let cookie = '';
async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { origin: base, cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = response.headers.get('content-type') ?? '';
  const data = type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, body: data };
}

function check(label, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Each TOTP code works once; if this window's code was already used, wait for the next one.
let login;
for (let attempt = 0; attempt < 2; attempt += 1) {
  login = await call('/auth/login', { method: 'POST', body: { password, code: totpAt(env.TOTP_SECRET, Math.floor(Date.now() / 30_000)) } });
  if (login.status !== 401 || attempt === 1) break;
  await sleep(30_000 - (Date.now() % 30_000) + 500);
}
check('login (password + TOTP)', login.status === 200, `HTTP ${login.status}`);
cookie = login.headers.getSetCookie()[0]?.split(';')[0] ?? '';

let state;
for (let attempt = 0; attempt < 20; attempt += 1) {
  state = await call('/api/state');
  if (state.body.online && state.body.state) break;
  await sleep(500);
}
check('agent online', state.body.online === true);
const snapshot = state.body.state ?? {};
check('snapshot', Boolean(snapshot.host), `${snapshot.host?.name} · ${snapshot.apps?.length} apps · volume ${snapshot.sound?.volume}`);

const installed = await call('/api/installed');
check('installed apps', installed.status === 200 && installed.body.apps?.length > 0, `${installed.body.apps?.length} apps`);

const icon = await call('/api/icon/com.apple.finder');
check('icon', icon.status === 200 && icon.body.subarray(1, 4).toString() === 'PNG', `${icon.body.length} bytes`);

if (Number.isInteger(snapshot.sound?.volume)) {
  const volume = await call('/api/action', { method: 'POST', body: { action: 'sound.volume.set', params: { value: snapshot.sound.volume } } });
  check('action round trip (volume unchanged)', volume.status === 200 && volume.body.ok === true, JSON.stringify(volume.body.result));
}

const bad = await call('/api/action', { method: 'POST', body: { action: 'sound.volume.set', params: { value: 500 } } });
check('agent rejects bad params', bad.status === 400 && bad.body.error === 'bad-params', bad.body.message);

await call('/auth/logout', { method: 'POST' });
