// Wi-Fi (networksetup), Bluetooth (blueutil) and Clash Verge's system proxy (networksetup).
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ActionError, BIN, run, runOrThrow } from '../exec.js';

let wifiDevice = null;

export async function findWifiDevice() {
  if (wifiDevice) return wifiDevice;
  const out = await runOrThrow(BIN.networksetup, ['-listallhardwareports']);
  wifiDevice = out.match(/Hardware Port: (?:Wi-Fi|AirPort)\s*\nDevice: (\S+)/)?.[1] ?? 'en0';
  return wifiDevice;
}

export async function uplinkInterface() {
  const result = await run(BIN.route, ['-n', 'get', 'default']);
  return result.stdout.match(/interface:\s*(\S+)/)?.[1] ?? null;
}

// "Wi-Fi Power (en0): On"
export async function getWifi() {
  const device = await findWifiDevice();
  const result = await run(BIN.networksetup, ['-getairportpower', device]);
  return result.ok ? { device, on: /:\s*On\s*$/i.test(result.stdout) } : null;
}

export async function setWifi({ on, restoreAfterSec }) {
  const device = await findWifiDevice();
  if (on) {
    await runOrThrow(BIN.networksetup, ['-setairportpower', device, 'on']);
    return { on: true };
  }
  if (restoreAfterSec) scheduleWifiRestore(device, restoreAfterSec);
  // Switching off may cut the link to the relay, so reply first and switch a moment later.
  setTimeout(() => run(BIN.networksetup, ['-setairportpower', device, 'off']), 1500);
  return { on: false, restoreAt: restoreAfterSec ? Date.now() + restoreAfterSec * 1000 : null };
}

// Runs outside the agent (detached, own process group) so Wi-Fi comes back even if the agent
// or the launcher dies in the meantime. Values reach sh as positional args, never as source.
function scheduleWifiRestore(device, seconds) {
  const child = spawn(BIN.sh, [
    '-c', 'sleep "$1" && exec /usr/sbin/networksetup -setairportpower "$2" on',
    'mac-remote-wifi-restore', String(seconds), device,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
}

// Returns null when blueutil is missing or lacks the Bluetooth permission.
export async function getBluetooth() {
  const result = await run(BIN.blueutil, ['--power'], { timeoutMs: 4000 });
  return result.ok && /^[01]$/.test(result.stdout) ? { on: result.stdout === '1' } : null;
}

export async function setBluetooth({ on }) {
  await runOrThrow(BIN.blueutil, ['--power', on ? '1' : '0']);
  return { on };
}

// Clash Verge's "System Proxy" switch points the primary network service's web, secure web and
// SOCKS proxies at its mixed port, and switches them off again. Clash Verge offers no way to flip
// that switch from outside (no URL action for it, no hotkey set up), so the agent makes the same
// change itself. Clash Verge's window keeps showing its own last state, and Clash Verge applies
// its saved setting again when it starts.
const CLASH_SETTINGS = join(homedir(), 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/verge.yaml');
const PROXY_KINDS = [
  { key: 'HTTP', set: '-setwebproxy', state: '-setwebproxystate' },
  { key: 'HTTPS', set: '-setsecurewebproxy', state: '-setsecurewebproxystate' },
  { key: 'SOCKS', set: '-setsocksfirewallproxy', state: '-setsocksfirewallproxystate' },
];

// verge.yaml is YAML, but the keys needed here are plain `key: value` lines.
export function parseClashSettings(yaml) {
  const field = (key) => yaml.match(new RegExp(`^${key}:[ \\t]*['"]?([^'"\\s#]+)`, 'm'))?.[1];
  const host = field('proxy_host') ?? '127.0.0.1';
  const port = Number(field('verge_mixed_port') ?? 7897);
  if (!/^[A-Za-z0-9.:-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host, port, pac: field('proxy_auto_config') === 'true' };
}

// `scutil --proxy` shows the settings in effect, which are the primary network service's.
export function parseProxyState(scutil, clash) {
  const field = (key) => scutil.match(new RegExp(`^\\s*${key} : (\\S+)`, 'm'))?.[1];
  const enabled = PROXY_KINDS.filter(({ key }) => field(`${key}Enable`) === '1');
  const toClash = enabled.filter(({ key }) => field(`${key}Proxy`) === clash.host && Number(field(`${key}Port`)) === clash.port);
  return { on: toClash.length > 0, elsewhere: toClash.length < enabled.length };
}

async function clashSettings() {
  try {
    return parseClashSettings(await readFile(CLASH_SETTINGS, 'utf8'));
  } catch {
    return null; // Clash Verge is not installed
  }
}

// Returns null when Clash Verge is not installed.
export async function getSystemProxy() {
  const clash = await clashSettings();
  if (!clash) return null;
  const result = await run(BIN.scutil, ['--proxy']);
  if (!result.ok) return null;
  return { ...parseProxyState(result.stdout, clash), host: clash.host, port: clash.port, pac: clash.pac };
}

// "(2) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)": the enabled service whose device carries the
// default route, else the Wi-Fi service (a VPN tunnel has no service of its own in this list).
async function primaryService() {
  const listing = await runOrThrow(BIN.networksetup, ['-listnetworkserviceorder']);
  const services = [...listing.matchAll(/^\(\d+\)\s+(.+)\n\(Hardware Port: [^,]*, Device: ([^)]*)\)/gm)]
    .map((match) => ({ name: match[1].trim(), device: match[2].trim() }));
  for (const device of [await uplinkInterface(), await findWifiDevice()]) {
    const service = services.find((item) => item.device === device);
    if (service) return service.name;
  }
  throw new ActionError('no-network-service');
}

function portOpen(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function setSystemProxy({ on }) {
  const clash = await clashSettings();
  if (!clash) throw new ActionError('clash-not-installed');
  if (clash.pac) throw new ActionError('clash-pac-mode');
  // Pointing every app at a Clash that is not listening would cut them all off. (The agent reaches
  // the relay directly, so it stays reachable either way.)
  if (on && !(await portOpen(clash.host, clash.port))) throw new ActionError('clash-not-running');
  const service = await primaryService();
  for (const kind of PROXY_KINDS) {
    await runOrThrow(BIN.networksetup, on ? [kind.set, service, clash.host, String(clash.port)] : [kind.state, service, 'off']);
  }
  return { on, service };
}
