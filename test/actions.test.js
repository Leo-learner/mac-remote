import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTION_NAMES, validateParams } from '../shared/actions.js';

test('accepts well-formed params', () => {
  assert.deepEqual(validateParams('sound.volume.set', { value: 30 }), { ok: true, params: { value: 30 } });
  assert.deepEqual(validateParams('apps.open', { bundleId: 'com.apple.Safari' }).ok, true);
  assert.deepEqual(validateParams('wifi.set', { on: false }), { ok: true, params: { on: false } });
  assert.deepEqual(validateParams('state.get'), { ok: true, params: {} });
});

test('rejects wrong types and ranges', () => {
  assert.equal(validateParams('sound.volume.set', { value: 101 }).error, 'out-of-range:value');
  assert.equal(validateParams('sound.volume.set', { value: 1.5 }).error, 'out-of-range:value');
  assert.equal(validateParams('sound.volume.set', { value: '5' }).error, 'out-of-range:value');
  assert.equal(validateParams('bluetooth.set', { on: 'yes' }).error, 'not-bool:on');
  assert.equal(validateParams('media.key', { key: 'eject' }).error, 'not-allowed:key');
  assert.equal(validateParams('sound.volume.set', {}).error, 'missing:value');
});

test('rejects unknown keys, including prototype tricks', () => {
  assert.equal(validateParams('sound.volume.set', { value: 5, extra: 1 }).error, 'unexpected:extra');
  assert.equal(validateParams('sound.volume.set', { value: 5, toString: 1 }).error, 'unexpected:toString');
  assert.equal(validateParams('sound.volume.set', JSON.parse('{"value":5,"__proto__":{"x":1}}')).error, 'unexpected:__proto__');
});

test('string patterns block path and control characters', () => {
  assert.equal(validateParams('apps.open', { bundleId: '../../etc' }).ok, false);
  assert.equal(validateParams('apps.open', { bundleId: 'a/b' }).ok, false);
  assert.equal(validateParams('sound.output.set', { id: 'bad\nid' }).ok, false);
  assert.equal(validateParams('vpn.set', { id: 'not-a-uuid', on: true }).ok, false);
  assert.equal(validateParams('display.brightness.set', { display: 'ddc:1', value: 50 }).ok, true);
  assert.equal(validateParams('display.brightness.set', { display: 'ddc:1;rm', value: 50 }).ok, false);
});

test('unknown actions and non-object params', () => {
  assert.equal(validateParams('shell.exec', {}).error, 'unknown-action');
  assert.equal(validateParams('toString', {}).error, 'unknown-action');
  assert.equal(validateParams('sound.volume.set', null).error, 'params-must-be-object');
  assert.equal(validateParams('sound.volume.set', [1]).error, 'params-must-be-object');
  assert.ok(ACTION_NAMES.length > 10);
});
