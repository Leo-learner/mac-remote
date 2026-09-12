// House rule (Leo, 2026-09-12): the phone can never shut down, reboot or sleep the Mac — not as
// an action, not as a key press, not hidden inside a command. This fails if any of it sneaks in.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ACTION_NAMES } from '../shared/actions.js';

const POWER_NAMES = /shut\s*down|restart|reboot|sleep|halt|power|log\s*out/i;
const POWER_CODE = /sleepnow|\bshutdown\b|\breboot\b|\bhalt\b|shut down|restart computer|NX_POWER_KEY|kAEShutDown|kAERestart|kAESleep|kAEReallyLogOut/i;

test('the action catalog has no power actions', () => {
  for (const name of ACTION_NAMES) assert.doesNotMatch(name, POWER_NAMES, name);
});

// policy.js is excluded: it names the rule, it never runs anything.
test('agent and helper code never issue power commands', async () => {
  const files = [];
  for (const dir of ['../agent/', '../agent/controls/']) {
    for (const name of await readdir(new URL(dir, import.meta.url))) {
      if (name.endsWith('.js') && name !== 'policy.js') files.push(`${dir}${name}`);
    }
  }
  files.push('../helper/macctl.swift');
  for (const file of files) {
    assert.doesNotMatch(await readFile(new URL(file, import.meta.url), 'utf8'), POWER_CODE, file);
  }
});

test('media keys are limited to play, next and previous', async () => {
  const swift = await readFile(new URL('../helper/macctl.swift', import.meta.url), 'utf8');
  assert.match(swift, /let mediaKeyCodes = \["play": 16, "next": 17, "prev": 18\]/);
});
