// Append-only JSONL audit log of every mutating or refused action.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = process.env.MAC_REMOTE_LOG_DIR || join(homedir(), 'Library', 'Logs', 'MacRemote');
const FILE = join(DIR, 'audit.jsonl');
const MAX_BYTES = 5 * 1024 * 1024;

let queue = Promise.resolve();

export function audit(entry) {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  queue = queue
    .then(async () => {
      await mkdir(DIR, { recursive: true });
      const size = await stat(FILE).then((s) => s.size, () => 0);
      if (size > MAX_BYTES) await rename(FILE, `${FILE}.1`);
      await appendFile(FILE, line, { mode: 0o600 });
    })
    .catch(() => {});
  return queue;
}
