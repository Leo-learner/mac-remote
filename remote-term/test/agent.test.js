// The agent process the way the menu bar app runs it (commands on stdin, JSON lines on stdout),
// with a relay address where nothing listens: what an idle agent loads, and what it reports.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import module from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { waitFor } from './helpers/phone.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRELOAD = new URL('./helpers/loaded-modules.js', import.meta.url).href;
const TCC_DB = '/Library/Application Support/com.apple.TCC/TCC.db';
// Passkey ceremonies, sessions, notifications and the --pair QR code need these; sitting idle does not.
const HEAVY = ['@simplewebauthn/server', '@xterm/headless', '@xterm/addon-serialize', '@xterm/addon-unicode11', 'node-pty', 'web-push', 'qrcode-terminal'];

async function closedPort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function readable(path) {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function startIdleAgent() {
  const home = await mkdtemp(join(tmpdir(), 'rt-idle-'));
  const port = await closedPort();
  await writeFile(join(home, 'agent.json'), JSON.stringify({ relayUrl: `ws://localhost:${port}/agent`, deviceToken: randomBytes(32).toString('base64url') }));
  const loaded = join(home, 'loaded.json');
  const child = spawn(process.execPath, ['--import', PRELOAD, 'agent/index.js'], {
    cwd: ROOT,
    env: { ...process.env, REMOTE_TERM_HOME: home, REMOTE_TERM_PARENT_PIPE: '1', LOADED_MODULES_OUT: loaded },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const events = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        events.push(JSON.parse(line));
      } catch {
        // not a report line
      }
    }
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  // The launcher closing its end of the pipe is how the agent is told to stop.
  const stop = () => {
    child.stdin.end();
    return exited;
  };
  return { child, events, loaded, stop };
}

test('an idle agent answers status with whether it has Full Disk Access, and reports no sessions', async () => {
  const agent = await startIdleAgent();
  try {
    await waitFor(() => agent.events.some((event) => event.event === 'status' && event.status === 'disconnected'), { what: 'a failed connection attempt' });
    agent.child.stdin.write(`${JSON.stringify({ id: 'status-1', cmd: 'status' })}\n`);
    const reply = await waitFor(() => agent.events.find((event) => event.event === 'reply' && event.id === 'status-1'), { what: 'status reply' });
    assert.equal(reply.ok, true);
    assert.equal(typeof reply.fullDiskAccess, 'boolean');
    // The agent is this test's child, so the same permission identity answers for both.
    assert.equal(reply.fullDiskAccess, readable(TCC_DB));
    assert.deepEqual([reply.sessions, reply.links, reply.devices, reply.pairing], [0, 0, 0, null]);
    assert.equal(agent.events.filter((event) => event.event === 'sessions').length, 0, 'zero sessions is what the launcher assumes');
  } finally {
    assert.equal(await agent.stop(), 0);
  }
});

test('starting and idling loads none of the heavy modules', { skip: typeof module.registerHooks !== 'function' && 'needs module.registerHooks (Node 22.15 or later)' }, async () => {
  const agent = await startIdleAgent();
  try {
    await waitFor(() => agent.events.some((event) => event.event === 'started'), { what: 'started' });
    await waitFor(() => agent.events.some((event) => event.event === 'status' && event.status === 'disconnected'), { what: 'a failed connection attempt' });
    agent.child.stdin.write(`${JSON.stringify({ id: 'status-1', cmd: 'status' })}\n`);
    await waitFor(() => agent.events.find((event) => event.event === 'reply'), { what: 'status reply' });
  } finally {
    assert.equal(await agent.stop(), 0);
  }
  const urls = JSON.parse(await readFile(agent.loaded, 'utf8'));
  const packages = new Set(urls.flatMap((url) => /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(url)?.[1] ?? []));
  assert.ok(packages.has('ws'), 'the relay socket library shows up, so the list is real');
  assert.ok(urls.some((url) => url.endsWith('/agent/sessions.js')), 'the modules that load them lazily were loaded');
  assert.deepEqual(HEAVY.filter((name) => packages.has(name)), []);
});
