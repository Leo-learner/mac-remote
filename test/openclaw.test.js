import assert from 'node:assert/strict';
import { test } from 'node:test';
import { egressPort, gatewayPort, parseJob, sandboxProfile } from '../agent/controls/openclaw.js';

// `launchctl print gui/501/ai.openclaw.gateway` on this Mac (2026-10-24), shortened. The nested
// blocks carry `state = active` lines of their own, deeper in.
const PRINT_RUNNING = `gui/501/ai.openclaw.gateway = {
\tactive count = 3
\tpath = /Users/leo/Library/LaunchAgents/ai.openclaw.gateway.plist
\ttype = LaunchAgent
\tstate = running

\tprogram = /usr/bin/sandbox-exec
\tdomain = gui/501 [100020]
\truns = 1
\tpid = 56675
\timmediate reason = speculative

\tspawn type = interactive (4)
\tjetsam priority = 40
\tendpoints = {
\t\t"com.apple.example" = {
\t\t\tport = 0x1234
\t\t\tactive = 1
\t\t\tstate = active
\t\t}
\t}
}`;

// The gateway's launch arguments as the owner's sandboxed setup has them, and as
// `openclaw gateway install --force` writes them again.
const SANDBOXED = [
  '/usr/bin/sandbox-exec', '-f', '/Users/leo/Library/Application Support/openclaw-egress/gateway.sb',
  '/bin/sh', '/Users/leo/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh',
  '/Users/leo/.openclaw/service-env/ai.openclaw.gateway.env',
  '/Users/leo/.nvm/versions/node/v24.22.1/bin/node', '--max-old-space-size=2048',
  '/Users/leo/.nvm/versions/node/v24.22.1/lib/node_modules/openclaw/dist/index.js', 'gateway', '--port', '18789',
];
const PLAIN = SANDBOXED.slice(3);

test('reads the job state and pid from the top level only', () => {
  assert.deepEqual(parseJob(PRINT_RUNNING), { state: 'running', pid: 56675 });
});

test('reads a stopped or stopping job', () => {
  const notRunning = PRINT_RUNNING.replace('\tstate = running', '\tstate = not running').replace(/^\tpid = .*\n/m, '');
  assert.deepEqual(parseJob(notRunning), { state: 'not running', pid: null });
  // Right after bootout, until the process has exited.
  assert.equal(parseJob(PRINT_RUNNING.replace('\tstate = running', '\tstate = SIGTERMed')).state, 'SIGTERMed');
});

test('finds no job in output without a top-level state', () => {
  assert.equal(parseJob(''), null);
  assert.equal(parseJob('\t\tstate = active\n'), null);
});

test('accepts the gateway only when it starts under sandbox-exec with a profile', () => {
  assert.equal(sandboxProfile(SANDBOXED), '/Users/leo/Library/Application Support/openclaw-egress/gateway.sb');
  assert.equal(sandboxProfile(PLAIN), null);
  assert.equal(sandboxProfile(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)', '/bin/sh']), null);
  assert.equal(sandboxProfile(null), null);
});

test('takes the gateway port from its arguments, the egress port from its config', () => {
  assert.equal(gatewayPort(SANDBOXED), 18789);
  assert.equal(gatewayPort([...PLAIN.slice(0, -2), '--port', '19001']), 19001);
  assert.equal(gatewayPort(['node', 'gateway']), 18789);
  assert.equal(egressPort('# OpenClaw 专用出口\nmixed-port: 7899\nbind-address: 127.0.0.1\n'), 7899);
  assert.equal(egressPort('mixed-port: 17899\n'), 17899);
  assert.equal(egressPort(null), 7899);
});
