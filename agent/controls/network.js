// Wi-Fi (networksetup), Bluetooth (blueutil) and VPN services (scutil --nc).
import { spawn } from 'node:child_process';
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

// * (Disconnected)   6A3D2F1B-…-…  PPP --> L2TP   "Office VPN"   [PPP/L2TP]
export async function listVpns() {
  const result = await run(BIN.scutil, ['--nc', 'list']);
  if (!result.ok) return [];
  return result.stdout.split('\n').flatMap((line) => {
    const match = line.match(/\(([^)]+)\)\s+([0-9A-Fa-f-]{36})\s.*?"(.+)"/);
    return match ? [{ id: match[2], name: match[3], status: match[1], connected: match[1] === 'Connected' }] : [];
  });
}

export async function setVpn({ id, on }) {
  const vpn = (await listVpns()).find((item) => item.id === id);
  if (!vpn) throw new ActionError('no-such-vpn');
  await runOrThrow(BIN.scutil, ['--nc', on ? 'start' : 'stop', id]);
  return { id, name: vpn.name, on };
}
