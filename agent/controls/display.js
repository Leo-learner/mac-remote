// Brightness (m1ddc for external monitors, DisplayServices via macctl for the built-in panel),
// dark mode, Night Shift and Stage Manager.
import { access, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CONFIG_FILE } from '../config.js';
import { ActionError, BIN, macctl, osascript, run, runOrThrow } from '../exec.js';

// Every DDC message waits its turn in one queue, with a pause after it: a monitor that is still
// busy with the last message ignores or garbles the next one.
//
// With one external monitor (this Mac's setup), macctl talks DDC itself: it gives the monitor the
// 40 ms DDC/CI allows to prepare a reply and checks the reply's checksum, so a reading is either
// right or reported as failed. On the VG2481-4K that read 30 of 30 times, writes 50 ms apart all
// landed, and a write takes about 3 ms plus macctl's start.
//
// m1ddc (1.2.0) remains for several monitors. It asks twice and reads after 10 ms: there, three
// reads in four failed, a failed read still exits 0 and prints 0 or -125, and a reply can even
// answer the previous command. So its calls are spaced 400 ms apart, a reading only counts once
// two replies agree, and the level we last wrote beats a lone reply.
const DDC_GAP_MS = 400; // after an m1ddc call
const DIRECT_GAP_MS = 60; // after one of macctl's checked DDC messages
const DIRECT_GIVE_UP = 3; // failed macctl readings in a row, with none ever good, before m1ddc takes over
const READ_ATTEMPTS = 6;
const WRITE_SETTLE_MS = 10_000; // after our own write, report it instead of reading it back
const VERIFY_AFTER_MS = 50; // a drag's last write is read back this long after it went out
const MAX_RETRY_MS = 10 * 60_000; // how long an unconfirmed max-luminance guess is kept
const DISPLAY_LIST_TTL_MS = 60_000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ddcQueue = Promise.resolve();
function ddcTask(task, gapMs = DDC_GAP_MS) {
  const result = ddcQueue.then(task);
  ddcQueue = result.catch(() => {}).then(() => pause(gapMs));
  return result;
}

// The DDC calls, so the tests can stand in for macctl, m1ddc and the monitor.
export const ddcIo = {
  macctl,
  run,
};

// macctl's DDC goes to the default external display, so it is used while that is the only one, and
// until it has failed DIRECT_GIVE_UP times in a row without ever answering (another kind of setup).
const direct = { works: false, failures: 0, uuids: '' };
const useDirect = (displays) => displays.length === 1 && (direct.works || direct.failures < DIRECT_GIVE_UP);

async function directLuminance() {
  try {
    const { current, max } = await ddcTask(() => ddcIo.macctl(['display', 'ddc-luminance'], { timeoutMs: 3000 }), DIRECT_GAP_MS);
    if (!(Number.isInteger(max) && max > 0 && Number.isInteger(current) && current >= 0 && current <= max)) return null;
    direct.works = true;
    direct.failures = 0;
    return { current, max };
  } catch {
    direct.failures += 1;
    return null;
  }
}

// One write as the queue runs it: macctl's, or m1ddc's for monitor `index`.
const sendLuminance = (index, level, viaMacctl) => (viaMacctl
  ? ddcIo.macctl(['display', 'ddc-set-luminance', String(level)], { timeoutMs: 3000 })
    .then(() => ({ ok: true }), (error) => ({ ok: false, stderr: error.code }))
  : ddcIo.run(BIN.m1ddc, ['display', String(index), 'set', 'luminance', String(level)], { timeoutMs: 4000 }));

let displayList = { at: 0, list: null };

// "[1] VG2481-4K (9384AAC3-66EE-4133-90D2-2B95F987A2C7)"
export async function ddcDisplays() {
  if (displayList.list && Date.now() - displayList.at < DISPLAY_LIST_TTL_MS) return displayList.list;
  // Listing reads the IORegistry, not the monitor, so it needs no pause after it.
  const result = await ddcTask(() => ddcIo.run(BIN.m1ddc, ['display', 'list'], { timeoutMs: 4000 }), DIRECT_GAP_MS);
  if (!result.ok) return displayList.list ?? [];
  const list = result.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\[(\d+)\]\s+(.+?)\s+\(([0-9A-Fa-f-]+)\)\s*$/);
    if (!match) return [];
    // Right after the monitor wakes, macOS can briefly report no product name; m1ddc prints "(null)".
    const index = Number(match[1]);
    const known = displayList.list?.find((item) => item.index === index)?.name;
    return [{ index, name: match[2] === '(null)' ? known ?? '外接显示器' : match[2], uuid: match[3] }];
  });
  displayList = { at: Date.now(), list };
  // A different set of monitors gets a fresh chance at macctl's DDC.
  const uuids = list.map((item) => item.uuid).join(',');
  if (uuids !== direct.uuids) Object.assign(direct, { works: false, failures: 0, uuids });
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
    const result = await ddcTask(() => ddcIo.run(BIN.m1ddc, ['display', String(index), verb, 'luminance'], { timeoutMs: 4000 }));
    replies.push(result.ok ? Number.parseInt(result.stdout, 10) : Number.NaN);
  }
  return replies;
}

const maxLuminance = new Map(); // display index -> { value, confirmed, at }

async function ddcMaxLuminance(index, displays) {
  const cached = maxLuminance.get(index);
  if (cached && (cached.confirmed || Date.now() - cached.at < MAX_RETRY_MS)) return cached.value;
  if (useDirect(displays)) {
    const reading = await directLuminance();
    if (reading) {
      maxLuminance.set(index, { value: reading.max, confirmed: true, at: Date.now() });
      return reading.max;
    }
    if (useDirect(displays)) return cached?.value ?? 100; // not given up on yet: try again next time
  }
  const confirmed = confirmedReply(await ddcReplies(index, 'max', 0xffff), 0xffff);
  const entry = { value: confirmed ?? 100, confirmed: confirmed !== null, at: Date.now() };
  maxLuminance.set(index, entry);
  return entry.value;
}

const levels = new Map(); // display index -> { level, at, written }: what we last read or wrote

// External monitors that answer DDC, with brightness as 0-100 (scaled by the monitor's max).
export async function ddcScreens() {
  const screens = [];
  const displays = await ddcDisplays();
  for (const display of displays) {
    const max = await ddcMaxLuminance(display.index, displays);
    let last = levels.get(display.index);
    if (!last?.written || Date.now() - last.at > WRITE_SETTLE_MS) {
      const startedAt = Date.now();
      const level = await readLevel(display.index, displays, max, last?.level ?? null);
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

// One checked macctl reading, or m1ddc's agreeing replies.
async function readLevel(index, displays, max, known) {
  if (useDirect(displays)) {
    const reading = await directLuminance();
    if (reading || useDirect(displays)) return reading?.current ?? known;
  }
  return settleReading(await ddcReplies(index, 'get', max), max, known);
}

const waitingWrites = new Map(); // display index -> the write still waiting in the queue

// A slider sends a value every 100-180 ms while it is dragged. At most one write per display waits;
// newer values replace its target instead of queueing up, so the monitor follows the finger
// rather than replaying its path.
function writeLuminance(index, level, viaMacctl) {
  const waiting = waitingWrites.get(index);
  if (waiting) {
    waiting.level = level;
    return waiting.done;
  }
  const write = { level };
  // The write takes its place in the queue now; its value is read when its turn comes.
  write.done = ddcTask(async () => {
    waitingWrites.delete(index);
    const result = await sendLuminance(index, write.level, viaMacctl);
    if (result.ok) {
      levels.set(index, { level: write.level, at: Date.now(), written: true });
      if (viaMacctl && !waitingWrites.has(index)) verifyLevel(index, write.level);
    }
    return result;
  }, viaMacctl ? DIRECT_GAP_MS : DDC_GAP_MS);
  waitingWrites.set(index, write);
  return write.done;
}

// The last write of a drag is read back once, and sent again if the monitor did not take it: a
// message the monitor missed would otherwise leave the screen at a level the phone no longer shows.
function verifyLevel(index, level) {
  const stillLatest = () => !waitingWrites.has(index) && levels.get(index)?.level === level;
  pause(VERIFY_AFTER_MS).then(async () => {
    if (!stillLatest()) return;
    const reading = await directLuminance();
    if (!reading || reading.current === level || !stillLatest()) return;
    const again = await ddcTask(() => sendLuminance(index, level, true), DIRECT_GAP_MS);
    if (again.ok && stillLatest()) levels.set(index, { level, at: Date.now(), written: true });
  });
}

export async function setBrightness({ display, value }) {
  const [kind, raw] = display.split(':');
  const id = Number(raw);
  if (kind === 'builtin') {
    const screens = await macctl(['display', 'list']);
    if (!screens.some((screen) => screen.id === id && screen.builtin)) throw new ActionError('no-such-display');
    await macctl(['display', 'set-brightness', String(id), String(value)]);
  } else {
    const displays = await ddcDisplays();
    if (!displays.some((item) => item.index === id)) throw new ActionError('no-such-display');
    const level = Math.round((value / 100) * (await ddcMaxLuminance(id, displays)));
    const result = await writeLuminance(id, level, useDirect(displays));
    if (!result.ok) {
      throw new ActionError(result.timedOut ? 'timeout' : 'command-failed', `ddc: ${result.stderr || `exit ${result.code}`}`);
    }
  }
  return { display, value };
}

// The monitor's own standby, over DDC: macOS keeps sending a picture, so the screen stays dark
// even when the mouse moves — which is the point of using DDC instead of display sleep. A key
// press, a click or a scroll at the Mac does bring it back. Standby and the wake ride the same
// queue as the brightness reads, since they share one bus.
//
// The watch has to outlast the person being away. Each macctl run gives up after WAKE_WATCH_SEC,
// so it is started again for as long as the monitor stays in standby, and a marker file next to
// the agent's config lets an agent that restarts in the meantime pick the watch back up.
//
// Under MacRemote (MAC_REMOTE_PARENT_PIPE=1) the menu bar app watches instead: it is connected to
// the window server anyway, so no second AppKit process has to poll for the hours the monitor is
// dark. It is sent {event:"watch-input", on} and answers {cmd:"input"} on the first deliberate
// input. The cli and a dev agent have no launcher to ask, so they keep the macctl loop.
const WAKE_WATCH_SEC = Number(process.env.MAC_REMOTE_WAKE_WATCH_SEC) || 1800;
const STANDBY_MARKER = join(dirname(CONFIG_FILE), 'display-standby');
let wakeWatch = 0;
let standby = false; // the last awake write that went through was "off" (or an earlier agent's was)
let launcherWatching = false; // the launcher was asked to watch and has not reported input since

// Read on every call rather than once, so the tests can take both paths in one process.
const launcherWatches = () => process.env.MAC_REMOTE_PARENT_PIPE === '1';

// The standby writes, the macctl watch and the reports to the launcher go through here, so the
// tests can swap in fakes: no monitor, no macctl binary, no launcher reading stdout.
export const standbyIo = {
  macctl,
  run,
  report: (event, details) => process.stdout.write(`${JSON.stringify({ event, ...details, ts: Date.now() })}\n`),
};

function askLauncherToWatch(on) {
  launcherWatching = on;
  standbyIo.report('watch-input', { on });
}

async function watchForWake() {
  if (launcherWatches()) return askLauncherToWatch(true);
  const generation = ++wakeWatch;
  while (generation === wakeWatch) {
    const result = await standbyIo.run(BIN.macctl, ['display', 'wait-for-input', String(WAKE_WATCH_SEC)], {
      timeoutMs: WAKE_WATCH_SEC * 1000 + 5000,
    });
    if (generation !== wakeWatch) return;
    let input = false;
    try {
      input = JSON.parse(result.stdout)?.input === true;
    } catch {
      // a half-written reply counts as no input
    }
    if (input) {
      try {
        await setDisplayAwake({ on: true });
        standbyIo.report('display', { awake: true, via: 'input' });
      } catch {
        await pause(2000);
        watchForWake(); // the wake did not go through: keep listening for the next key press
      }
      return;
    }
    if (!result.ok) await pause(5000); // a failing helper must not spin
  }
}

export async function setDisplayAwake({ on }) {
  wakeWatch += 1; // whatever was waiting for input is stale now
  const result = await ddcTask(() => standbyIo.macctl(['display', 'awake', on ? 'on' : 'off']));
  // A write that did not go through leaves the monitor, and the launcher's watch, as they were.
  if (!result.ok) throw new ActionError('ddc-write-failed');
  standby = !on;
  if (on) {
    await unlink(STANDBY_MARKER).catch(() => {});
    if (launcherWatches()) askLauncherToWatch(false);
  } else {
    await writeFile(STANDBY_MARKER, `${new Date().toISOString()}\n`).catch(() => {});
    watchForWake();
  }
  return { on };
}

// {cmd:"input"} from the launcher: someone at the Mac pressed a key, clicked or scrolled. It only
// counts while the launcher is watching, so all it can ever do is wake a monitor put in standby.
export async function wakeOnInput() {
  if (!launcherWatching) return;
  launcherWatching = false; // the launcher stopped watching when it reported the input
  try {
    await setDisplayAwake({ on: true });
    standbyIo.report('display', { awake: true, via: 'input' });
  } catch {
    await pause(2000);
    // The wake did not go through: listen for the next key press, unless the monitor was woken
    // some other way or the launcher was asked to watch again in the meantime.
    if (standby && !launcherWatching) askLauncherToWatch(true);
  }
}

// Called once when the agent starts: a monitor an earlier agent left in standby is watched again.
export async function resumeStandbyWatch() {
  if (await access(STANDBY_MARKER).then(() => true, () => false)) {
    standby = true;
    watchForWake();
  }
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
