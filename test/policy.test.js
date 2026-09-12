// The owner's rules for agent/policy.js (Leo, 2026-09-12).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessRisk } from '../agent/policy.js';

const ctx = {
  wifiDevice: 'en0',
  uplinkInterface: 'en0',
  selfBundleId: 'dev.mac-remote.launcher',
  runningApps: [
    { pid: 100, bundleId: 'dev.mac-remote.launcher', name: 'MacRemote' },
    { pid: 200, bundleId: 'com.apple.TextEdit', name: 'TextEdit' },
    { pid: 300, bundleId: 'io.github.clash-verge-rev.clash-verge-rev', name: 'Clash Verge' },
  ],
};
const runsUnattended = (decision) => decision.allow === true && !decision.needsConfirm;
const asksFirst = (decision) => decision.allow === true && decision.needsConfirm === true;
const VPN_ID = 'B0859091-E5F2-4FF0-9AD7-7D63A703DC9C';

test('harmless actions run without confirmation', () => {
  const cases = [
    ['state.get', {}],
    ['sound.volume.set', { value: 20 }],
    ['wifi.set', { on: true }],
    ['apps.open', { bundleId: 'com.apple.TextEdit' }],
    ['apps.quit', { pid: 200 }],
    ['display.dark.set', { on: true }],
  ];
  for (const [action, params] of cases) assert.ok(runsUnattended(assessRisk(action, params, ctx)), action);
});

test('Wi-Fi can be switched on but never off, restore timer or not', () => {
  for (const params of [{ on: false }, { on: false, restoreAfterSec: 60 }]) {
    assert.equal(assessRisk('wifi.set', params, ctx).allow, false);
    assert.equal(assessRisk('wifi.set', params, { ...ctx, uplinkInterface: 'en1' }).allow, false, 'even off-uplink');
  }
});

test('MacRemote and Clash Verge can never be quit remotely', () => {
  for (const pid of [100, 300]) {
    for (const action of ['apps.quit', 'apps.forceQuit']) {
      const decision = assessRisk(action, { pid }, ctx);
      assert.equal(decision.allow, false, `${action} ${pid}`);
      assert.match(decision.reason, /受保护/);
    }
  }
});

test('force-quitting an ordinary app asks first', () => {
  assert.ok(asksFirst(assessRisk('apps.forceQuit', { pid: 200 }, ctx)));
});

test('connecting or disconnecting a VPN asks first', () => {
  for (const on of [true, false]) assert.ok(asksFirst(assessRisk('vpn.set', { id: VPN_ID, on }, ctx)), `on=${on}`);
});
