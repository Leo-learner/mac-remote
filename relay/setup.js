// Create or rotate relay secrets inside an env file:
//   node relay/setup.js --env relay/.env [--totp-only] [--agent-hash <hex>] [--password-stdin]
// Asks for the login password (hidden) unless --totp-only, generates a new TOTP setup key and
// shows it as text and as a QR code for an authenticator app. Other keys in the file are kept.
// Exits non-zero, with nothing written, when the password is rejected.
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
  console.error('用法：node setup.js --env <文件> [--totp-only] [--agent-hash <hex>] [--password-stdin]');
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

function parseEnv(text) {
  return Object.fromEntries(text.split('\n')
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

async function mergeEnv(file, existing, values) {
  const lines = existing.split('\n').filter((line, index, all) => line !== '' || index < all.length - 1);
  for (const [key, value] of Object.entries(values)) {
    const at = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (at >= 0) lines[at] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  await writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 });
}

// The QR code is a convenience (scan with the phone camera); the text key always works.
async function printQr(text) {
  try {
    const { default: qrcode } = await import('qrcode-terminal');
    qrcode.generate(text, { small: false }, (qr) => console.log(qr));
  } catch {
    console.log('（没装 qrcode-terminal，跳过二维码）');
  }
}

const existing = await readFile(envFile, 'utf8').catch(() => '');
const values = {};

if (!args.includes('--totp-only')) {
  const fromStdin = args.includes('--password-stdin');
  const password = fromStdin ? await readStdin() : await askHidden('登录密码（至少 12 位，输入时屏幕不显示）：');
  if (password.length < 12) {
    console.error('✗ 密码至少要 12 个字符。什么都没有改动。');
    process.exit(1);
  }
  if (!fromStdin && (await askHidden('再输一次同样的密码：')) !== password) {
    console.error('✗ 两次输入的密码不一样。什么都没有改动。');
    process.exit(1);
  }
  values.PASSWORD_HASH = await hashPassword(password);
}
if (!args.includes('--keep-totp')) values.TOTP_SECRET = base32Encode(randomBytes(20));

const agentHash = option('--agent-hash');
if (agentHash) {
  if (!/^[0-9a-f]{64}$/i.test(agentHash)) {
    console.error('✗ --agent-hash 必须是 agent/setup.js 打印的 64 位十六进制 AGENT_TOKEN_SHA256');
    process.exit(1);
  }
  values.AGENT_TOKEN_SHA256 = agentHash.toLowerCase();
}

await mergeEnv(envFile, existing, values);
console.log(`\n✓ 已写入 ${envFile}：${Object.keys(values).join(', ')}`);

if (values.TOTP_SECRET) {
  const issuer = option('--issuer') ?? 'Orbit';
  let account = option('--account');
  try {
    account ??= new URL(parseEnv(existing).PUBLIC_ORIGIN).host;
  } catch {
    account ??= 'owner';
  }
  const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
    + `?secret=${values.TOTP_SECRET}&issuer=${encodeURIComponent(issuer)}`;
  console.log('\n用手机相机扫下面的二维码，按提示把验证码加进「密码」App；');
  console.log('或者在验证器里选「输入设置密钥」，手动输入二维码下面那串字符。\n');
  await printQr(uri);
  console.log(`设置密钥：${values.TOTP_SECRET.match(/.{1,4}/g).join(' ')}\n`);
}

process.exit(0);
