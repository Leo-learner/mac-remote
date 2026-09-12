// Read-only system facts.
import { BIN, run } from '../exec.js';

export async function computerName() {
  const result = await run(BIN.scutil, ['--get', 'ComputerName']);
  return result.ok && result.stdout ? result.stdout : null;
}

// "Now drawing from 'AC Power'\n -InternalBattery-0 (id=…)\t80%; AC attached; not charging present: true"
export async function battery() {
  const result = await run(BIN.pmset, ['-g', 'batt']);
  const match = result.stdout.match(/(\d+)%;\s*([^;]+);/);
  if (!match) return null;
  return { percent: Number(match[1]), state: match[2].trim(), onAC: /'AC Power'/.test(result.stdout) };
}
