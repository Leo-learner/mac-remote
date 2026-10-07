// The display wake watch. Under MacRemote the menu bar app watches for the key press and the agent
// only tells it when; the cli and a dev agent keep macctl's wait-for-input loop. No monitor and no
// macctl are involved: the watch's calls go to fakes.
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { ActionError, BIN } from '../agent/exec.js';

// The DDC queue rests 400 ms after every write and a failed wake asks again after 2 s. Every timer
// here runs ten times faster, which keeps the order of events and drops ten seconds of waiting.
const realSetTimeout = globalThis.setTimeout;
mock.method(globalThis, 'setTimeout', (callback, ms = 0, ...args) => realSetTimeout(callback, ms / 10, ...args));

// The standby marker sits next to the agent config, which has to point at a scratch folder before
// display.js is loaded: a test must never clear the marker of a monitor that is in standby now.
const dir = await mkdtemp(join(tmpdir(), 'mac-remote-wake-'));
process.env.MAC_REMOTE_CONFIG = join(dir, 'agent.json');
delete process.env.MAC_REMOTE_WAKE_WATCH_SEC;
const { resumeStandbyWatch, setDisplayAwake, standbyIo, wakeOnInput } = await import('../agent/controls/display.js');

const MARKER = join(dir, 'display-standby');
const hasMarker = () => access(MARKER).then(() => true, () => false);
const watchInput = (on) => ({ event: 'watch-input', on });
const WOKEN = { event: 'display', awake: true, via: 'input' };
const underMacRemote = () => { process.env.MAC_REMOTE_PARENT_PIPE = '1'; };
const withoutLauncher = () => { delete process.env.MAC_REMOTE_PARENT_PIPE; };

let writes; // the awake writes macctl was asked for
let replies; // what the next writes answer, in order (an Error is thrown); { ok: true } after that
let watches; // wait-for-input runs, each waiting for the test to answer it
let events; // what the launcher was told, without timestamps

standbyIo.macctl = async (args) => {
  writes.push(args.join(' '));
  const reply = await (replies.shift() ?? { ok: true });
  if (reply instanceof Error) throw reply;
  return reply;
};
standbyIo.run = (bin, args, options) => new Promise((answer) => watches.push({ bin, args, options, answer }));
standbyIo.report = (event, details) => events.push({ event, ...details });

beforeEach(() => {
  writes = [];
  replies = [];
  watches = [];
  events = [];
});
after(() => rm(dir, { recursive: true, force: true }));

async function until(check, what) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('under MacRemote, standby has the launcher watch and starts no macctl', async () => {
  underMacRemote();
  await setDisplayAwake({ on: false });
  assert.deepEqual(writes, ['display awake off']);
  assert.deepEqual(events, [watchInput(true)]);
  assert.equal(watches.length, 0, 'no wait-for-input run');
  assert.ok(await hasMarker(), 'the marker is still written for an agent that restarts');

  await wakeOnInput();
  assert.deepEqual(writes, ['display awake off', 'display awake on']);
  assert.deepEqual(events, [watchInput(true), watchInput(false), WOKEN]);
  assert.equal(await hasMarker(), false);
});

test('input wakes the monitor only while the launcher is watching', async () => {
  underMacRemote();
  await wakeOnInput();
  assert.deepEqual(writes, [], 'nothing is in standby');

  await setDisplayAwake({ on: false });
  await Promise.all([wakeOnInput(), wakeOnInput()]);
  assert.deepEqual(writes, ['display awake off', 'display awake on'], 'two reports, one wake');

  await setDisplayAwake({ on: false });
  await setDisplayAwake({ on: true }); // the phone wakes it, which ends the watch
  await wakeOnInput();
  assert.equal(writes.length, 4, 'a late report wakes nothing');
  assert.deepEqual(events, [watchInput(true), watchInput(false), WOKEN, watchInput(true), watchInput(false)]);
});

test('an agent that starts while the marker is there has the launcher watch again', async () => {
  underMacRemote();
  await resumeStandbyWatch();
  assert.deepEqual(events, [], 'no marker, nothing to watch');

  await writeFile(MARKER, 'left by an earlier agent\n');
  await resumeStandbyWatch();
  assert.deepEqual(events, [watchInput(true)]);
  assert.equal(watches.length, 0, 'no wait-for-input run');
  replies.push({ ok: false });
  await wakeOnInput();
  assert.deepEqual(events, [watchInput(true), watchInput(true)], 'a failed wake is retried as before the restart');
  await wakeOnInput();
  assert.deepEqual(writes, ['display awake on', 'display awake on']);
  assert.equal(await hasMarker(), false);
});

test('a wake that does not go through leaves the launcher watching', async () => {
  underMacRemote();
  await setDisplayAwake({ on: false });
  replies.push(new ActionError('no-ddc-display'), { ok: false });
  await assert.rejects(setDisplayAwake({ on: true }), { code: 'no-ddc-display' });
  assert.deepEqual(events, [watchInput(true)], "the phone's failed wake leaves the watch alone");

  await wakeOnInput(); // this write fails too: after 2 s the launcher is asked to watch again
  assert.deepEqual(events, [watchInput(true), watchInput(true)]);
  assert.ok(await hasMarker());

  await wakeOnInput();
  assert.deepEqual(writes, ['display awake off', 'display awake on', 'display awake on', 'display awake on']);
  assert.deepEqual(events.slice(2), [watchInput(false), WOKEN]);
  assert.equal(await hasMarker(), false);
});

test('a failed wake is not retried once the monitor was woken some other way', async () => {
  underMacRemote();
  await setDisplayAwake({ on: false });
  let finishPhoneWake;
  replies.push(new Promise((resolve) => { finishPhoneWake = resolve; }), { ok: false });
  const phoneWake = setDisplayAwake({ on: true });
  await until(() => writes.length === 2, "the phone's wake");
  const inputWake = wakeOnInput(); // queued behind the phone's wake, and its own write fails
  finishPhoneWake({ ok: true });
  await Promise.all([phoneWake, inputWake]);
  assert.equal(writes.length, 3);
  assert.deepEqual(events, [watchInput(true), watchInput(false)], 'no watch for a monitor that is awake');
});

test('the wake asked for by input waits its turn on the DDC queue', async () => {
  underMacRemote();
  await setDisplayAwake({ on: false });
  let finishPhoneWake;
  replies.push(new Promise((resolve) => { finishPhoneWake = resolve; }));
  const phoneWake = setDisplayAwake({ on: true });
  await until(() => writes.length === 2, "the phone's wake");
  const inputWake = wakeOnInput(); // a key press while the phone's wake is still on the bus
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(writes.length, 2, 'the second write waits for the first');

  finishPhoneWake({ ok: true });
  await Promise.all([phoneWake, inputWake]);
  assert.deepEqual(writes, ['display awake off', 'display awake on', 'display awake on']);
  assert.deepEqual(events, [watchInput(true), watchInput(false), watchInput(false), WOKEN]);
});

test('without the launcher, macctl wait-for-input watches as before', async () => {
  withoutLauncher();
  await setDisplayAwake({ on: false });
  assert.deepEqual(events, [], 'no launcher to tell');
  assert.equal(watches.length, 1);
  const [{ bin, args, options }] = watches;
  assert.deepEqual({ bin, args, options }, {
    bin: BIN.macctl, args: ['display', 'wait-for-input', '1800'], options: { timeoutMs: 1_805_000 },
  });

  await wakeOnInput();
  assert.deepEqual(writes, ['display awake off'], 'a stray {cmd:"input"} wakes nothing');

  watches[0].answer({ ok: true, stdout: '{"ok":true,"input":false}' }); // that run timed out
  await until(() => watches.length === 2, 'the next run');
  watches[1].answer({ ok: true, stdout: '{"ok":true,"input":true}' });
  await until(() => events.length === 1, 'the wake');
  assert.deepEqual(writes, ['display awake off', 'display awake on']);
  assert.deepEqual(events, [WOKEN]);
  assert.equal(await hasMarker(), false);
});

test('without the launcher, an agent that starts while the marker is there runs macctl again', async () => {
  withoutLauncher();
  await writeFile(MARKER, 'left by an earlier agent\n');
  await resumeStandbyWatch();
  assert.equal(watches.length, 1);
  assert.deepEqual(events, []);

  watches[0].answer({ ok: true, stdout: '{"ok":true,"input":true}' });
  await until(() => events.length === 1, 'the wake');
  assert.deepEqual(writes, ['display awake on']);
  assert.equal(await hasMarker(), false);
});
