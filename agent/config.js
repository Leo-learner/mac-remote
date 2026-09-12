// Agent configuration: ~/Library/Application Support/MacRemote/agent.json (mode 600),
// created by agent/setup.js. MAC_REMOTE_CONFIG overrides the path (used by tests and dev).
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_DIR = join(homedir(), 'Library', 'Application Support', 'MacRemote');
export const CONFIG_FILE = process.env.MAC_REMOTE_CONFIG || join(CONFIG_DIR, 'agent.json');
export const SELF_BUNDLE_ID = process.env.MAC_REMOTE_SELF_BUNDLE_ID || 'dev.mac-remote.launcher';

const LOCAL_WS = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//;

export async function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${CONFIG_FILE}: run "node agent/setup.js <relay-url>" first (${error.message})`);
  }
  const { relayUrl, deviceToken } = raw;
  if (typeof relayUrl !== 'string' || !(relayUrl.startsWith('wss://') || LOCAL_WS.test(relayUrl))) {
    throw new Error('relayUrl must be wss://… (plain ws:// is only allowed for localhost)');
  }
  if (typeof deviceToken !== 'string' || deviceToken.length < 32) {
    throw new Error('deviceToken is missing or too short');
  }
  return { relayUrl, deviceToken };
}
