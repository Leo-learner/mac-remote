// OpenClaw, the owner's Telegram bot gateway, and the dedicated egress proxy it must send all of
// its traffic through. Both are the owner's own LaunchAgents (set up 2026-10-24):
//   ai.openclaw.egress   a standalone mihomo on 127.0.0.1:7899, independent of Clash Verge
//   ai.openclaw.gateway  OpenClaw, launched under sandbox-exec so it can reach nothing but loopback
// On starts the egress first and the gateway after it; off stops them the other way round. Each
// is also enabled or disabled in launchd, so the switch's state still holds after the next login.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ActionError, BIN, run, runOrThrow } from '../exec.js';
import { portOpen } from './network.js';

const EGRESS = 'ai.openclaw.egress';
const GATEWAY = 'ai.openclaw.gateway';
const AGENTS = join(homedir(), 'Library/LaunchAgents');
const EGRESS_CONFIG = join(homedir(), 'Library/Application Support/openclaw-egress/config.yaml');

const plistPath = (label) => join(AGENTS, `${label}.plist`);
const domain = () => `gui/${process.getuid()}`;
const target = (label) => `${domain()}/${label}`;

// `launchctl print gui/<uid>/<label>`: the job's own fields sit one tab in; nested blocks (its
// endpoints, its spawn type) carry `state = active` lines of their own further in.
export function parseJob(print) {
  const state = print.match(/^\tstate = (.+)$/m)?.[1]?.trim();
  if (!state) return null;
  const pid = Number(print.match(/^\tpid = (\d+)$/m)?.[1]);
  return { state, pid: Number.isInteger(pid) ? pid : null };
}

// The gateway must start as `sandbox-exec -f <profile> …`. `openclaw gateway install --force`
// writes a plain launcher again, and a gateway started from that would reach the internet directly.
export function sandboxProfile(programArguments) {
  const [bin, flag, profile] = programArguments ?? [];
  return bin === '/usr/bin/sandbox-exec' && flag === '-f' && typeof profile === 'string' ? profile : null;
}

export function gatewayPort(programArguments) {
  const index = (programArguments ?? []).indexOf('--port');
  const port = Number(programArguments?.[index + 1]);
  return index >= 0 && Number.isInteger(port) && port > 0 && port < 65_536 ? port : 18_789;
}

export function egressPort(yaml) {
  const port = Number(yaml?.match(/^mixed-port:[ \t]*(\d+)/m)?.[1]);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : 7899;
}

async function job(label) {
  const result = await run(BIN.launchctl, ['print', target(label)]);
  return result.ok ? parseJob(result.stdout) : null; // not loaded
}

async function gatewayArguments() {
  const result = await run(BIN.plutil, ['-extract', 'ProgramArguments', 'json', '-o', '-', plistPath(GATEWAY)]);
  if (!result.ok) return null;
  try {
    const args = JSON.parse(result.stdout);
    return Array.isArray(args) ? args : null;
  } catch {
    return null;
  }
}

async function egressConfig() {
  try {
    return await readFile(EGRESS_CONFIG, 'utf8');
  } catch {
    return null;
  }
}

const installed = () => existsSync(plistPath(GATEWAY)) && existsSync(plistPath(EGRESS));

// Returns null when OpenClaw or its egress is not installed.
export async function getOpenClaw() {
  if (!installed()) return null;
  const [gateway, egress, args, yaml] = await Promise.all([job(GATEWAY), job(EGRESS), gatewayArguments(), egressConfig()]);
  const profile = sandboxProfile(args);
  const gatewayRunning = gateway?.state === 'running';
  const egressRunning = egress?.state === 'running';
  const [ready, egressListening] = await Promise.all([
    gatewayRunning ? portOpen('127.0.0.1', gatewayPort(args)) : false,
    egressRunning ? portOpen('127.0.0.1', egressPort(yaml)) : false,
  ]);
  return {
    on: gatewayRunning,
    ready, // the gateway answers on its port; it takes several seconds after starting
    sandboxed: Boolean(profile && existsSync(profile)),
    egress: egressRunning && egressListening,
  };
}

async function waitFor(check, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return check();
}

async function start(label) {
  await runOrThrow(BIN.launchctl, ['enable', target(label)]);
  const current = await job(label);
  if (current?.state === 'running') return;
  // Loaded but stopped: launchd's KeepAlive is between attempts.
  if (current?.state === 'not running') {
    await runOrThrow(BIN.launchctl, ['kickstart', target(label)]);
    return;
  }
  // Still shutting down after a recent switch-off: launchd refuses a new bootstrap until it is gone.
  if (current && !(await waitFor(async () => !(await job(label)), 8000))) throw new ActionError('openclaw-busy');
  await runOrThrow(BIN.launchctl, ['bootstrap', domain(), plistPath(label)]);
}

// bootout returns at once and the job then exits on its own; the gateway shuts down gracefully.
async function stop(label) {
  await runOrThrow(BIN.launchctl, ['disable', target(label)]);
  if (await job(label)) await runOrThrow(BIN.launchctl, ['bootout', target(label)]);
}

export async function setOpenClaw({ on }) {
  if (!installed()) throw new ActionError('openclaw-not-installed');
  if (!on) {
    await stop(GATEWAY);
    // Its last requests on the way out still go through the egress; the gateway exits in seconds.
    await waitFor(async () => !(await job(GATEWAY)), 8000);
    await stop(EGRESS);
    return { on: false };
  }
  const profile = sandboxProfile(await gatewayArguments());
  if (!profile || !existsSync(profile)) throw new ActionError('openclaw-unsandboxed');
  await start(EGRESS);
  const port = egressPort(await egressConfig());
  if (!(await waitFor(() => portOpen('127.0.0.1', port), 5000))) {
    throw new ActionError('openclaw-egress-down');
  }
  await start(GATEWAY);
  return { on: true };
}
