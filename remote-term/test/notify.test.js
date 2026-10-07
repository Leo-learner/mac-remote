import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Notifier, vapidKeys } from '../agent/notify.js';

const require = createRequire(new URL('../agent/package.json', import.meta.url));
const webpush = require('web-push');

const point = (jwk) => Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);

async function closedPort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('VAPID keys made without web-push are full length, and web-push signs with them', () => {
  // One key in 256 has a leading zero byte somewhere; a few hundred keys would show it being dropped.
  for (let i = 0; i < 300; i += 1) {
    const keys = vapidKeys();
    assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
    assert.equal(Buffer.from(keys.privateKey, 'base64url').length, 32);
  }
  const keys = vapidKeys();
  const { Authorization } = webpush.getVapidHeaders('https://web.push.apple.com', 'mailto:owner@remote-term.invalid', keys.publicKey, keys.privateKey, 'aes128gcm');
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(Authorization);
  assert.equal(k, keys.publicKey);
  const raw = Buffer.from(keys.publicKey, 'base64url');
  assert.equal(raw[0], 4, 'an uncompressed point');
  const publicKey = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  const [header, payload, signature] = jwt.split('.');
  assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')),
    'the public key is the private key\'s');
});

test('a first start makes and keeps its VAPID keys', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'rt-push-')), 'push.json');
  const notifier = await new Notifier({ file }).load();
  assert.equal(Buffer.from(notifier.publicKey, 'base64url').length, 65);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.vapid.publicKey, notifier.publicKey);
  assert.equal((await new Notifier({ file }).load()).publicKey, notifier.publicKey, 'the next start reuses them');
});

test('sending goes through web-push, loaded on first use; a send that fails is logged, not thrown', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'rt-push-')), 'push.json');
  const logs = [];
  // A proxy where nothing listens: the request fails on this Mac before anything leaves it.
  const notifier = await new Notifier({
    file, subject: 'https://term.example.test', proxy: `http://127.0.0.1:${await closedPort()}`, log: (event, details) => logs.push({ event, ...details }),
  }).load();
  const phoneKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  notifier.subscribe('phone', {
    endpoint: 'https://web.push.apple.com/QGuQyavXutnMH4XlAX2bjJGm0B',
    keys: { p256dh: point(phoneKey).toString('base64url'), auth: randomBytes(16).toString('base64url') },
  });
  assert.equal(await notifier.notify({ kind: 'bell', sessionId: 's1', label: 'zsh' }), 0);
  assert.deepEqual(logs.map(({ event, status }) => ({ event, status })), [{ event: 'push-failed', status: null }]);
  assert.match(logs[0].message, /ECONNREFUSED/);
  assert.equal(notifier.subscriptions.length, 1, 'a network failure keeps the subscription');
  await notifier.flush();
});
