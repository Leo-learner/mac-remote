// Create or rotate relay secrets inside an env file:
//   node relay/setup.js --env relay/.env [--agent-hash <hex>] [--keep-totp] [--password-stdin]
// Prompts for the login password (hidden), generates a TOTP secret and prints the key to add to
// an authenticator app. Existing keys in the env file (PORT, PUBLIC_ORIGIN, ...) are kept.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { base32Encode, hashPassword } from './auth.js';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const envFile = option('--env');
if (!envFile) {
  console.error('usage: node relay/setup.js --env <file> [--agent-hash <hex>] [--keep-totp] [--password-stdin]');
  process.exit(1);
}

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return reject(new Error('no terminal: pipe the password with --password-stdin'));
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let value = '';
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          return resolve(value);
        }
        if (char === '') process.exit(130);
        if (char === '' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

async function mergeEnv(file, values) {
  const existing = await readFile(file, 'utf8').catch(() => '');
  const lines = existing.split('\n').filter((line, index, all) => line !== '' || index < all.length - 1);
  for (const [key, value] of Object.entries(values)) {
    const at = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (at >= 0) lines[at] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  await writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 });
}

const fromStdin = args.includes('--password-stdin');
const password = fromStdin ? await readStdin() : await askHidden('Login password: ');
if (password.length < 12) {
  console.error('Use at least 12 characters.');
  process.exit(1);
}
if (!fromStdin && (await askHidden('Repeat password: ')) !== password) {
  console.error('Passwords do not match.');
  process.exit(1);
}

const values = { PASSWORD_HASH: await hashPassword(password) };
if (!args.includes('--keep-totp')) values.TOTP_SECRET = base32Encode(randomBytes(20));
const agentHash = option('--agent-hash');
if (agentHash) {
  if (!/^[0-9a-f]{64}$/i.test(agentHash)) {
    console.error('--agent-hash must be the 64-hex AGENT_TOKEN_SHA256 printed by agent/setup.js');
    process.exit(1);
  }
  values.AGENT_TOKEN_SHA256 = agentHash.toLowerCase();
}
await mergeEnv(envFile, values);
console.log(`updated ${envFile}: ${Object.keys(values).join(', ')}`);

if (values.TOTP_SECRET) {
  const issuer = option('--issuer') ?? 'Orbit';
  console.log('\nAdd this setup key to an authenticator app (Passwords, Google Authenticator, 1Password):');
  console.log(`  ${values.TOTP_SECRET.match(/.{1,4}/g).join(' ')}`);
  console.log(`  otpauth://totp/${encodeURIComponent(issuer)}?secret=${values.TOTP_SECRET}&issuer=${encodeURIComponent(issuer)}`);
}
