// Pair this Mac with a relay: node agent/setup.js <relay-url> [--force]
// Writes the agent config with a fresh device token and prints only its SHA-256 for the relay,
// so the raw token never leaves this Mac.
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CONFIG_FILE } from './config.js';

const [relayUrl, flag] = process.argv.slice(2);
if (!relayUrl || !/^wss?:\/\//.test(relayUrl)) {
  console.error('usage: node agent/setup.js <wss://host/agent | ws://127.0.0.1:3030/agent> [--force]');
  process.exit(1);
}
if (flag !== '--force' && (await access(CONFIG_FILE).then(() => true, () => false))) {
  console.error(`${CONFIG_FILE} already exists (pass --force to replace it and re-pair)`);
  process.exit(1);
}

const deviceToken = randomBytes(32).toString('base64url');
await mkdir(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
await writeFile(CONFIG_FILE, `${JSON.stringify({ relayUrl, deviceToken }, null, 2)}\n`, { mode: 0o600 });

console.log(`wrote ${CONFIG_FILE}`);
console.log('put this line into the relay .env:');
console.log(`AGENT_TOKEN_SHA256=${createHash('sha256').update(deviceToken).digest('hex')}`);
