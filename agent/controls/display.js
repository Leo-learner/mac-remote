// Brightness (m1ddc for external monitors, DisplayServices via macctl for the built-in panel),
// dark mode, Night Shift and Stage Manager.
import { ActionError, BIN, macctl, osascript, run, runOrThrow } from '../exec.js';

// DDC/CI over USB-C/DisplayPort is fragile. Measured on the VG2481-4K (m1ddc 1.2.0): back-to-back
// reads failed 11 times out of 12, reads 400 ms apart failed about half the time, a failed read
// still exits 0 and prints 0 or -125, and a reply can even answer the previous command. So every
// m1ddc call waits its turn in one queue with a pause after it, a reading only counts once two
// replies agree, and the level we last wrote beats a lone reply.
const DDC_GAP_MS = 400;
const READ_ATTEMPTS = 6;
const WRITE_SETTLE_MS = 10_000; // after our own write, report it instead of reading it back
const MAX_RETRY_MS = 10 * 60_000; // how long an unconfirmed max-luminance guess is kept
const DISPLAY_LIST_TTL_MS = 60_000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ddcQueue = Promise.resolve();
function ddcTask(task) {
  const result = ddcQueue.then(task);
  ddcQueue = result.catch(() => {}).then(() => pause(DDC_GAP_MS));
  return result;
}
const ddc = (args) => ddcTask(() => run(BIN.m1ddc, args, { timeoutMs: 4000 }));

let displayList = { at: 0, list: null };

// "[1] VG2481-4K (9384AAC3-66EE-4133-90D2-2B95F987A2C7)"
export async function ddcDisplays() {
  if (displayList.list && Date.now() - displayList.at < DISPLAY_LIST_TTL_MS) return displayList.list;
  const result = await ddc(['display', 'list']);
  if (!result.ok) return displayList.list ?? [];
  const list = result.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\[(\d+)\]\s+(.+?)\s+\(([0-9A-Fa-f-]+)\)\s*$/);
    return match ? [{ index: Number(match[1]), name: match[2], uuid: match[3] }] : [];
  });
  displayList = { at: Date.now(), list };
  return list;
}

// Replies worth believing, with how often each came back. A failed read prints 0 or a negative
// number, so only 1..limit counts — a real 0 is only ever learned from our own write.
function tally(replies, limit) {
  const counts = new Map();
  for (const value of replies) {
    if (Number.isInteger(value) && value > 0 && value <= limit) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

// The value that came back at least twice (the most frequent one, if several did).
export function confirmedReply(replies, limit) {
  let best = null;
  let bestCount = 1;
  for (const [value, count] of tally(replies, limit)) {
    if (count > bestCount) [best, bestCount] = [value, count];
  }
  return best;
}

// Two equal replies settle it. A lone reply may be junk or the answer to an earlier command, so it
// never overrides a known level; with nothing known, the latest lone reply is the best guess.
export function settleReading(replies, limit, known = null) {
  const confirmed = confirmedReply(replies, limit);
  if (confirmed !== null) return confirmed;
  if (known !== null) return known;
  const seen = [...tally(replies, limit).keys()];
  return seen.length > 0 ? seen[seen.length - 1] : null;
}

// Reads until one value has come back twice, giving up after READ_ATTEMPTS replies.
async function ddcReplies(index, verb, limit) {
  const replies = [];
  while (replies.length < READ_ATTEMPTS && confirmedReply(replies, limit) === null) {
    const result = await ddc(['display', String(index), verb, 'luminance']);
    replies.push(result.ok ? Number.parseInt(result.stdout, 10) : Number.NaN);
  }
  return replies;
}

const maxLuminance = new Map(); // display index -> { value, confirmed, at }

async function ddcMaxLuminance(index) {
  const cached = maxLuminance.get(index);
  if (cached && (cached.confirmed || Date.now() - cached.at < MAX_RETRY_MS)) return cached.value;
  const confirmed = confirmedReply(await ddcReplies(index, 'max', 0xffff), 0xffff);
  const entry = { value: confirmed ?? 100, confirmed: confirmed !== null, at: Date.now() };
  maxLuminance.set(index, entry);
  return entry.value;
}

const levels = new Map(); // display index -> { level, at, written }: what we last read or wrote

// External monitors that answer DDC, with brightness as 0-100 (scaled by the monitor's max).
export async function ddcScreens() {
  const screens = [];
  for (const display of await ddcDisplays()) {
    const max = await ddcMaxLuminance(display.index);
    let last = levels.get(display.index);
    if (!last?.written || Date.now() - last.at > WRITE_SETTLE_MS) {
      const startedAt = Date.now();
      const level = settleReading(await ddcReplies(display.index, 'get', max), max, last?.level ?? null);
      last = levels.get(display.index);
      // A write that landed while we were reading is newer than anything we just read.
      const wroteMeanwhile = last?.written && last.at >= startedAt;
      if (!wroteMeanwhile && level !== null) {
        last = { level, at: Date.now(), written: false };
        levels.set(display.index, last);
      }
    }
    if (!last) continue;
    const brightness = Math.min(100, Math.round((last.level / max) * 100));
    screens.push({ id: `ddc:${display.index}`, name: display.name, brightness, kind: 'ddc' });
  }
  return screens;
}

const waitingWrites = new Map(); // display index -> the write still waiting in the queue

// A slider drag sends a value every ~180 ms, faster than the queue drains. At most one write per
// display waits in the queue; newer values replace its target instead of queueing up.
function writeLuminance(index, level) {
  const waiting = waitingWrites.get(index);
  if (waiting) {
    waiting.level = level;
    return waiting.done;
  }
  const write = { level };
  write.done = ddcTask(async () => {
    waitingWrites.delete(index);
    const result = await run(BIN.m1ddc, ['display', String(index), 'set', 'luminance', String(write.level)], { timeoutMs: 4000 });
    if (result.ok) levels.set(index, { level: write.level, at: Date.now(), written: true });
    return result;
  });
  waitingWrites.set(index, write);
  return write.done;
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
    const result = await writeLuminance(id, level);
    if (!result.ok) {
      throw new ActionError(result.timedOut ? 'timeout' : 'command-failed', `m1ddc: ${result.stderr || `exit ${result.code}`}`);
    }
  }
  return { display, value };
}

// The monitor's own standby, over DDC: macOS keeps sending a picture, so the screen stays dark
// even when the mouse moves — which is the point of using DDC instead of display sleep. A key
// press, a click or a scroll at the Mac does bring it back: a macctl process watches for that and
// ends on the first deliberate input, on its timeout, or with the agent. Standby and the wake ride
// the same queue as the brightness reads, since they share one bus.
let wakeWatch = 0;

async function watchForWake() {
  const generation = ++wakeWatch;
  const result = await run(BIN.macctl, ['display', 'wait-for-input', '1800'], { timeoutMs: 1_805_000 });
  if (generation !== wakeWatch || !result.ok) return;
  try {
    if (JSON.parse(result.stdout)?.input) await setDisplayAwake({ on: true });
  } catch {
    // a half-written reply is not worth acting on
  }
}

export async function setDisplayAwake({ on }) {
  wakeWatch += 1; // whatever was waiting for input is stale now
  const result = await ddcTask(() => macctl(['display', 'awake', on ? 'on' : 'off']));
  if (!result.ok) throw new ActionError('ddc-write-failed');
  if (!on) watchForWake();
  return { on };
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
