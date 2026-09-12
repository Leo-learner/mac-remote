// Child-process helpers. Everything runs through execFile with an argument array and an
// absolute binary path — a shell is never involved (ported from mac-control's run_args).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BIN = {
  osascript: '/usr/bin/osascript',
  networksetup: '/usr/sbin/networksetup',
  scutil: '/usr/sbin/scutil',
  defaults: '/usr/bin/defaults',
  open: '/usr/bin/open',
  pmset: '/usr/bin/pmset',
  route: '/sbin/route',
  sh: '/bin/sh',
  blueutil: '/opt/homebrew/bin/blueutil',
  m1ddc: '/opt/homebrew/bin/m1ddc',
  macctl: fileURLToPath(new URL('../bin/macctl', import.meta.url)),
};

export class ActionError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

export const has = (name) => existsSync(BIN[name]);

// Never rejects: callers decide whether a failure matters.
export function run(bin, args = [], { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        stdout: String(stdout).trim(),
        stderr: String(stderr).trim(),
        timedOut: Boolean(error?.killed),
      });
    });
  });
}

export async function runOrThrow(bin, args, options) {
  const result = await run(bin, args, options);
  if (!result.ok) {
    const name = bin.split('/').pop();
    throw new ActionError(result.timedOut ? 'timeout' : 'command-failed',
      `${name}: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }
  return result.stdout;
}

// macctl prints JSON on success and {"ok":false,"error":"..."} on failure.
export async function macctl(args, options) {
  const result = await run(BIN.macctl, args, options);
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new ActionError('helper-failed', result.stderr || 'macctl returned no JSON');
  }
  if (!result.ok) throw new ActionError(data?.error || 'helper-failed');
  return data;
}

// AppleScript whose inputs arrive through `on run argv` — values are never spliced into source.
export function osascript(lines, args = [], options) {
  return runOrThrow(BIN.osascript, [...lines.flatMap((line) => ['-e', line]), ...args], options);
}
