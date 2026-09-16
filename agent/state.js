// State snapshot. Each reader is cached for its own TTL: fast-changing values are re-read on
// every tick, slow ones less often. Actions invalidate exactly the readers they affect.
import * as display from './controls/display.js';
import * as network from './controls/network.js';
import * as sound from './controls/sound.js';
import * as system from './controls/system.js';
import { SELF_BUNDLE_ID } from './config.js';
import { macctl } from './exec.js';

const READERS = {
  native: { ttl: 1_000, read: () => macctl(['state']) }, // apps, audio outputs, displays, Night Shift, AX
  volume: { ttl: 1_000, read: sound.getVolume },
  wifi: { ttl: 1_000, read: network.getWifi },
  uplink: { ttl: 15_000, read: network.uplinkInterface },
  // blueutil aborts (and writes a crash report) without permission: back off after a failure.
  bluetooth: { ttl: 10_000, retryAfterFailure: 5 * 60_000, read: network.getBluetooth },
  proxy: { ttl: 5_000, read: network.getSystemProxy }, // Clash Verge's system proxy
  dark: { ttl: 5_000, read: display.getDark },
  stageManager: { ttl: 5_000, read: display.getStageManager },
  // A DDC read takes seconds (replies are queued 400 ms apart), so it refreshes in the background.
  ddc: { ttl: 30_000, background: true, read: display.ddcScreens },
  battery: { ttl: 60_000, read: system.battery },
  host: { ttl: 3_600_000, read: system.computerName },
};

const INVALIDATES = {
  'wifi.set': ['wifi', 'uplink'],
  'bluetooth.set': ['bluetooth'],
  'proxy.set': ['proxy'],
  'display.brightness.set': ['ddc', 'native'],
  'display.dark.set': ['dark'],
  'display.nightShift.set': ['native'],
  'display.stageManager.set': ['stageManager'],
  'sound.volume.set': ['volume'],
  'sound.mute.set': ['volume'],
  'sound.output.set': ['native', 'volume'],
  'apps.open': ['native'],
  'apps.activate': ['native'],
  'apps.hide': ['native'],
  'apps.quit': ['native'],
  'apps.forceQuit': ['native'],
};

const cache = new Map(); // name -> { at, value, failed }
const inflight = new Map(); // name -> Promise, so concurrent snapshots share one read

function read(name) {
  const reader = READERS[name];
  const entry = cache.get(name);
  const age = entry ? Date.now() - entry.at : Infinity;
  if (entry && age < (entry.failed ? reader.retryAfterFailure ?? reader.ttl : reader.ttl)) {
    return Promise.resolve(entry.value);
  }
  if (!inflight.has(name)) {
    inflight.set(name, (async () => {
      let value = null;
      try {
        value = await reader.read();
      } catch {
        value = null;
      }
      cache.set(name, { at: Date.now(), value, failed: value === null });
      inflight.delete(name);
      return value;
    })());
  }
  // A background reader answers with its last value while it refreshes; only a reader with no
  // value yet makes the snapshot wait.
  if (reader.background && entry) return Promise.resolve(entry.value);
  return inflight.get(name);
}

// The launcher's brightness slider reads the same cached value the phone's snapshot uses.
export const cachedDdcScreens = () => read('ddc');

export function invalidateFor(action) {
  for (const name of INVALIDATES[action] ?? []) cache.delete(name);
}

export async function snapshot() {
  const names = Object.keys(READERS);
  const values = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await read(name)])));
  const native = values.native ?? {};
  const builtinScreens = (native.displays ?? [])
    .filter((screen) => screen.builtin && Number.isInteger(screen.brightness))
    .map((screen) => ({ id: `builtin:${screen.id}`, name: screen.name, brightness: screen.brightness, kind: 'builtin' }));
  const screens = [...builtinScreens, ...(values.ddc ?? [])];
  const wifi = values.wifi;

  return {
    ts: Date.now(),
    host: { name: values.host },
    capabilities: {
      bluetooth: values.bluetooth !== null,
      systemProxy: values.proxy !== null,
      brightness: screens.length > 0,
      nightShift: Boolean(native.nightShift),
      stageManager: values.stageManager !== null,
      mediaKeys: Boolean(native.axTrusted),
    },
    network: {
      wifi: wifi ? { ...wifi, isUplink: wifi.device === values.uplink } : null,
      uplink: values.uplink,
      bluetooth: values.bluetooth,
      proxy: values.proxy,
    },
    display: {
      dark: values.dark,
      nightShift: native.nightShift ?? null,
      stageManager: values.stageManager,
      screens,
    },
    sound: { ...(values.volume ?? { volume: null, muted: false }), outputs: native.audioOutputs ?? [] },
    apps: native.apps ?? [],
    battery: values.battery,
  };
}

export async function policyContext() {
  const [wifi, uplink, native] = await Promise.all([read('wifi'), read('uplink'), read('native')]);
  return {
    wifiDevice: wifi?.device ?? null,
    uplinkInterface: uplink,
    runningApps: (native?.apps ?? []).map(({ pid, bundleId, name }) => ({ pid, bundleId, name })),
    selfBundleId: SELF_BUNDLE_ID,
  };
}
