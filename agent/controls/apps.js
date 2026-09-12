// Running / installed apps, icons, open, hide, quit.
// Every target is looked up in a fresh list first: a bundle id must belong to an installed or
// running app, a pid must belong to a running regular app.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ActionError, BIN, macctl, runOrThrow } from '../exec.js';

const INSTALLED_TTL_MS = 10 * 60 * 1000;
const ICON_SIZE = 128;
const ICON_DIR = join(homedir(), 'Library', 'Caches', 'MacRemote', 'icons');

let installed = { at: 0, list: [] };
let installedScan = null;

// One scan at a time: a page full of icons asks for this list many times at once.
export function installedApps() {
  if (Date.now() - installed.at <= INSTALLED_TTL_MS) return Promise.resolve(installed.list);
  installedScan ??= macctl(['apps', 'installed'], { timeoutMs: 20_000 })
    .then((list) => {
      installed = { at: Date.now(), list };
      return list;
    })
    .finally(() => {
      installedScan = null;
    });
  return installedScan;
}

export const runningApps = () => macctl(['apps', 'running']);

async function appForBundle(bundleId) {
  const app = (await installedApps()).find((item) => item.bundleId === bundleId)
    ?? (await runningApps()).find((item) => item.bundleId === bundleId);
  if (!app) throw new ActionError('no-such-app');
  return app;
}

async function appForPid(pid) {
  const app = (await runningApps()).find((item) => item.pid === pid);
  if (!app) throw new ActionError('no-such-app');
  return app;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitForExit(pid, timeoutMs) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!isAlive(pid)) return true;
  }
  return false;
}

// `open -b` launches the app, or brings it to the front if it is already running.
// (Direct activation from a background process is ignored since Sonoma.)
export async function open({ bundleId }) {
  const app = await appForBundle(bundleId);
  await runOrThrow(BIN.open, ['-b', bundleId]);
  return { bundleId, name: app.name };
}

export const activate = open;

export async function hide({ pid }) {
  const app = await appForPid(pid);
  await macctl(['apps', 'hide', String(pid)]);
  return { pid, name: app.name };
}

// A graceful quit can be held up by a "save changes?" sheet; report that instead of guessing.
export async function quit({ pid }) {
  const app = await appForPid(pid);
  await macctl(['apps', 'quit', String(pid)]);
  return { pid, name: app.name, stillRunning: !(await waitForExit(pid, 3000)) };
}

export async function forceQuit({ pid }) {
  const app = await appForPid(pid);
  await macctl(['apps', 'force-quit', String(pid)]);
  return { pid, name: app.name, stillRunning: !(await waitForExit(pid, 2000)) };
}

// Bundle ids are schema-checked (no "/" possible), so they are safe as file names.
export async function icon({ bundleId }) {
  const file = join(ICON_DIR, `${bundleId}.png`);
  const cached = await readFile(file).catch(() => null);
  if (cached) return { bundleId, png: cached.toString('base64') };
  const app = await appForBundle(bundleId);
  const { png } = await macctl(['apps', 'icon', app.path, String(ICON_SIZE)]);
  await mkdir(ICON_DIR, { recursive: true });
  await writeFile(file, Buffer.from(png, 'base64'));
  return { bundleId, png };
}
