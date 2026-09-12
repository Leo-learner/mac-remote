import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LoginThrottle, Sessions, base32Decode, base32Encode, checkTotp, hashPassword, totpAt, verifyPassword,
} from '../relay/auth.js';

const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

test('base32 matches the RFC 6238 seed encoding and round-trips', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(base32Decode(RFC_SECRET).toString(), '12345678901234567890');
  assert.equal(base32Decode('gezd gnbv-gy3t qojq').toString(), '1234567890');
});

test('TOTP matches RFC 6238 appendix B (SHA-1, 8 digits)', () => {
  const vectors = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ];
  for (const [seconds, expected] of vectors) assert.equal(totpAt(RFC_SECRET, Math.floor(seconds / 30), 8), expected);
});

test('checkTotp: ±1 window, single use, strict format', () => {
  const now = 1_700_000_000_000;
  const counter = Math.floor(now / 30_000);
  const code = totpAt(RFC_SECRET, counter);
  assert.equal(checkTotp(RFC_SECRET, code, { now }), counter);
  assert.equal(checkTotp(RFC_SECRET, code, { now, lastCounter: counter }), null, 'replay must fail');
  assert.equal(checkTotp(RFC_SECRET, totpAt(RFC_SECRET, counter - 1), { now }), counter - 1);
  assert.equal(checkTotp(RFC_SECRET, totpAt(RFC_SECRET, counter - 2), { now }), null);
  assert.equal(checkTotp(RFC_SECRET, '12345', { now }), null);
  assert.equal(checkTotp(RFC_SECRET, undefined, { now }), null);
});

test('scrypt password hashes verify', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.match(stored, /^scrypt:32768:8:1:/);
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('Correct horse battery staple', stored), false);
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
});

test('sessions expire on idle and absolute limits', () => {
  let now = 0;
  const sessions = new Sessions({ idleMs: 1000, absoluteMs: 2500, now: () => now });
  const id = sessions.create();
  now = 900;
  assert.ok(sessions.touch(id));
  now = 1800;
  assert.ok(sessions.touch(id), 'idle timer was refreshed at 900');
  now = 2600;
  assert.equal(sessions.touch(id), null, 'absolute limit reached');
  const idle = sessions.create();
  now = 3700;
  assert.equal(sessions.touch(idle), null, 'idle limit reached');
  assert.equal(sessions.touch('nope'), null);
});

test('login throttle backs off per IP', () => {
  let now = 0;
  const throttle = new LoginThrottle({ now: () => now });
  for (let i = 0; i < 3; i += 1) {
    assert.ok(throttle.check('1.1.1.1').allowed);
    throttle.fail('1.1.1.1');
  }
  assert.equal(throttle.check('1.1.1.1').allowed, false);
  assert.ok(throttle.check('2.2.2.2').allowed, 'other IPs unaffected');
  now += 31_000;
  assert.ok(throttle.check('1.1.1.1').allowed);
  throttle.succeed('1.1.1.1');
  assert.ok(throttle.check('1.1.1.1').allowed);
});
