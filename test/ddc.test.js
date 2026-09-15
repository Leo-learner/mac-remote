import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmedReply, settleReading } from '../agent/controls/display.js';

// Replies captured from the VG2481-4K with m1ddc 1.2.0 on 2026-09-15.
const BACK_TO_BACK = [0, 0, 0, 0, -125, 0, 0, 0, 0, 0, 67, 0];
const READS_400MS_APART = [0, 0, 67, 67, 0, 67, 0, 0, 67, 67, 0, 67];
const MAX_READS = [0, 67, 100, 100, 0, 100];

test('two equal in-range replies confirm a reading', () => {
  assert.equal(confirmedReply(READS_400MS_APART, 100), 67);
  assert.equal(settleReading(READS_400MS_APART, 100), 67);
});

test('failed reads (0 and negative junk) never count', () => {
  assert.equal(confirmedReply([0, 0, -125, -125, 0], 100), null);
  assert.equal(settleReading([0, 0, -125, -125, 0], 100), null);
  assert.equal(settleReading([0, 0, 0], 100, 40), 40);
});

test('replies above the maximum are junk', () => {
  assert.equal(settleReading([250, 250], 100), null);
});

test('a lone reply never overrides a known level', () => {
  assert.equal(settleReading(BACK_TO_BACK, 100, 40), 40);
});

test('with nothing known, the latest lone reply is the best guess', () => {
  assert.equal(settleReading(BACK_TO_BACK, 100), 67);
  assert.equal(settleReading([0, 30, 0, 45, 0], 100), 45);
});

test('a stale answer to an earlier command is outvoted', () => {
  // The max-luminance read got the previous brightness reply (67) once before settling on 100.
  assert.equal(confirmedReply(MAX_READS, 0xffff), 100);
});

test('a confirmed reply beats the known level (someone used the monitor buttons)', () => {
  assert.equal(settleReading([0, 55, 0, 55], 100, 67), 55);
});
