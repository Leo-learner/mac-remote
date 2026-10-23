// External monitor brightness: which DDC path is taken, how a drag is written, and the read-back of
// its last value. A fake monitor stands in for macctl, m1ddc and the bus.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionError } from '../agent/exec.js';
import { ddcIo, ddcScreens, setBrightness, standbyIo } from '../agent/controls/display.js';
import { invalidatedBy } from '../agent/state.js';

const ONE = '[1] VG2481-4K (9384AAC3-66EE-4133-90D2-2B95F987A2C7)';
const TWO = `${ONE}\n[2] DELL U2720Q (1B2C3D4E-0000-1111-2222-333344445555)`;

// The display list is cached for a minute and our own writes are trusted for ten seconds: moving
// the clock past both lets each test start from what the monitor says.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const nextScene = () => { skew += 120_000; };

const monitor = { list: ONE, level: 23, max: 100, macctlAnswers: true, missWrites: 0 };
let calls = [];

ddcIo.macctl = async (args) => {
  calls.push(`macctl ${args.slice(1).join(' ')}`);
  if (!monitor.macctlAnswers) throw new ActionError('ddc-no-reply');
  if (args[1] === 'ddc-luminance') return { ok: true, current: monitor.level, max: monitor.max };
  if (monitor.missWrites > 0) monitor.missWrites -= 1; // sent fine, but the monitor did not take it
  else monitor.level = Number(args[2]);
  return { ok: true };
};
ddcIo.run = async (bin, args) => {
  calls.push(`m1ddc ${args.join(' ')}`);
  if (args[1] === 'list') return { ok: true, stdout: monitor.list };
  if (args[2] === 'set') monitor.level = Number(args[4]);
  const value = args[2] === 'max' ? monitor.max : monitor.level;
  return { ok: true, stdout: args[2] === 'set' ? '' : String(value) };
};

async function until(check, what) {
  const started = realNow();
  while (!check()) {
    if (realNow() - started > 5000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const writes = () => calls.filter((call) => / set|set-luminance/.test(call));

test('with one monitor, macctl reads it, checked, and m1ddc only lists it', async () => {
  nextScene();
  calls = [];
  assert.deepEqual(await ddcScreens(), [{ id: 'ddc:1', name: 'VG2481-4K', brightness: 23, kind: 'ddc' }]);
  assert.ok(calls.includes('macctl ddc-luminance'));
  assert.deepEqual(calls.filter((call) => call.startsWith('m1ddc')), ['m1ddc display list']);
});

test('a drag writes where the finger is, not every value it passed', async () => {
  nextScene();
  calls = [];
  const steps = Array.from({ length: 30 }, (_, i) => setBrightness({ display: 'ddc:1', value: 30 + i }));
  await Promise.all(steps);
  assert.equal(monitor.level, 59);
  assert.ok(writes().length <= 3, `writes: ${writes().join(', ')}`);
  assert.ok(writes().every((call) => call.startsWith('macctl ddc-set-luminance')));
  await until(() => calls.at(-1) === 'macctl ddc-luminance', 'the read-back');
  assert.deepEqual(await ddcScreens(), [{ id: 'ddc:1', name: 'VG2481-4K', brightness: 59, kind: 'ddc' }]);
});

test('a last value the monitor missed is read back and sent again', async () => {
  nextScene();
  calls = [];
  monitor.missWrites = 1;
  await setBrightness({ display: 'ddc:1', value: 70 });
  assert.equal(monitor.level, 59, 'the first write was missed');
  await until(() => monitor.level === 70, 'the second write');
  assert.deepEqual(calls.slice(-3), ['macctl ddc-set-luminance 70', 'macctl ddc-luminance', 'macctl ddc-set-luminance 70']);
});

test('the read-back never puts back a value the finger has already left', async () => {
  nextScene();
  calls = [];
  monitor.missWrites = 1;
  const first = setBrightness({ display: 'ddc:1', value: 40 });
  await first;
  await setBrightness({ display: 'ddc:1', value: 45 }); // arrives before the read-back of 40
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(monitor.level, 45);
  assert.ok(!writes().slice(1).includes('macctl ddc-set-luminance 40'), `writes: ${writes().join(', ')}`);
});

test('when macctl never gets an answer, m1ddc takes over', async () => {
  nextScene();
  // Another monitor, whose DDC macctl's default service cannot reach. (Once macctl has worked for a
  // monitor it stays in use, so a monitor in standby does not switch it off for good.)
  monitor.macctlAnswers = false;
  monitor.list = '[1] LG HDR 4K (AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE)';
  calls = [];
  for (let i = 0; i < 3; i += 1) await ddcScreens();
  nextScene();
  calls = [];
  await setBrightness({ display: 'ddc:1', value: 35 });
  assert.deepEqual(writes(), ['m1ddc display 1 set luminance 35']);
  assert.ok(!calls.some((call) => call.startsWith('macctl')), 'macctl is not asked again');
  assert.equal(monitor.level, 35);
  monitor.macctlAnswers = true;
});

test('with two monitors, m1ddc addresses each by its index', async () => {
  nextScene();
  monitor.list = TWO;
  calls = [];
  await setBrightness({ display: 'ddc:2', value: 50 });
  assert.deepEqual(writes(), ['m1ddc display 2 set luminance 50']);
  assert.ok(!calls.some((call) => call.startsWith('macctl')));
});

test('under MacRemote, each level written is reported to the menu bar app; without it, nothing is printed', async () => {
  nextScene();
  monitor.list = ONE;
  const reports = [];
  standbyIo.report = (event, details) => reports.push({ event, ...details });
  process.env.MAC_REMOTE_PARENT_PIPE = '1';
  await setBrightness({ display: 'ddc:1', value: 42 });
  assert.deepEqual(reports, [{ event: 'brightness', display: 'ddc:1', value: 42 }]);
  delete process.env.MAC_REMOTE_PARENT_PIPE;
  await setBrightness({ display: 'ddc:1', value: 43 });
  assert.equal(reports.length, 1);
});

test("an external monitor's brightness leaves the native state cached; the built-in panel's does not", () => {
  assert.deepEqual(invalidatedBy('display.brightness.set', { display: 'ddc:1' }), ['ddc']);
  assert.deepEqual(invalidatedBy('display.brightness.set', { display: 'builtin:1' }), ['native']);
  assert.deepEqual(invalidatedBy('wifi.set', { on: true }), ['wifi', 'uplink']);
});
