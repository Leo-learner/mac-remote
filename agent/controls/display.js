// Brightness (m1ddc for external monitors, DisplayServices via macctl for the built-in panel),
// dark mode, Night Shift and Stage Manager.
import { ActionError, BIN, macctl, osascript, run, runOrThrow } from '../exec.js';

// "[1] VG2481-4K (9384AAC3-66EE-4133-90D2-2B95F987A2C7)"
export async function ddcDisplays() {
  const result = await run(BIN.m1ddc, ['display', 'list'], { timeoutMs: 4000 });
  if (!result.ok) return [];
  return result.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\[(\d+)\]\s+(.+?)\s+\(([0-9A-Fa-f-]+)\)\s*$/);
    return match ? [{ index: Number(match[1]), name: match[2], uuid: match[3] }] : [];
  });
}

// DDC over DisplayPort is flaky: a failed read often comes back as 0 with exit status 0.
// Retry and prefer a non-zero answer; a genuine 0 still wins when every attempt says so.
async function ddcNumber(index, verb, what, attempts = 3) {
  let zero = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await run(BIN.m1ddc, ['display', String(index), verb, what], { timeoutMs: 4000 });
    const value = Number.parseInt(result.stdout, 10);
    if (result.ok && Number.isFinite(value)) {
      if (value !== 0) return value;
      zero = 0;
    }
  }
  return zero;
}

const ddcMax = new Map();
async function ddcMaxLuminance(index) {
  if (!ddcMax.has(index)) {
    const max = await ddcNumber(index, 'max', 'luminance');
    ddcMax.set(index, max > 0 ? max : 100);
  }
  return ddcMax.get(index);
}

// External monitors that answer DDC, with brightness as 0-100 (scaled by the monitor's max).
export async function ddcScreens() {
  const screens = [];
  for (const display of await ddcDisplays()) {
    const raw = await ddcNumber(display.index, 'get', 'luminance');
    if (raw === null) continue;
    const max = await ddcMaxLuminance(display.index);
    screens.push({ id: `ddc:${display.index}`, name: display.name, brightness: Math.round((raw / max) * 100), kind: 'ddc' });
  }
  return screens;
}

export async function setBrightness({ display, value }) {
  const [kind, raw] = display.split(':');
  const id = Number(raw);
  if (kind === 'builtin') {
    const screens = await macctl(['display', 'list']);
    if (!screens.some((screen) => screen.id === id && screen.builtin)) throw new ActionError('no-such-display');
    await macctl(['display', 'set-brightness', String(id), String(value)]);
  } else {
    if (!(await ddcDisplays()).some((item) => item.index === id)) throw new ActionError('no-such-display');
    const level = Math.round((value / 100) * (await ddcMaxLuminance(id)));
    await runOrThrow(BIN.m1ddc, ['display', String(id), 'set', 'luminance', String(level)]);
  }
  return { display, value };
}

// Light mode has no AppleInterfaceStyle key, so `defaults read` fails; that reads as false.
export async function getDark() {
  const result = await run(BIN.defaults, ['read', '-g', 'AppleInterfaceStyle']);
  return result.ok && result.stdout === 'Dark';
}

export async function setDark({ on }) {
  await osascript([
    `tell application "System Events" to tell appearance preferences to set dark mode to ${on ? 'true' : 'false'}`,
  ]);
  return { on };
}

export async function setNightShift({ on }) {
  await macctl(['nightshift', 'set', on ? 'on' : 'off']);
  return { on };
}

export async function getStageManager() {
  const result = await run(BIN.defaults, ['read', 'com.apple.WindowManager', 'GloballyEnabled']);
  return result.ok ? result.stdout === '1' : null;
}

export async function setStageManager({ on }) {
  await runOrThrow(BIN.defaults, ['write', 'com.apple.WindowManager', 'GloballyEnabled', '-bool', on ? 'true' : 'false']);
  return { on };
}
