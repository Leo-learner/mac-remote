// Volume/mute (AppleScript), output device and media keys (macctl).
import { ActionError, BIN, macctl, osascript, run } from '../exec.js';

// "output volume:13, input volume:71, alert volume:30, output muted:false"
// Outputs without a volume control (e.g. DisplayPort audio) report "missing value".
export async function getVolume() {
  const result = await run(BIN.osascript, ['-e', 'get volume settings']);
  if (!result.ok) return null;
  const volume = result.stdout.match(/output volume:(\d+)/)?.[1];
  return {
    volume: volume === undefined ? null : Number(volume),
    muted: /output muted:true/.test(result.stdout),
  };
}

export async function setVolume({ value }) {
  await osascript(['on run argv', 'set volume output volume (item 1 of argv as integer)', 'end run'], [String(value)]);
  return { value };
}

export async function setMute({ on }) {
  await osascript([on ? 'set volume with output muted' : 'set volume without output muted']);
  return { on };
}

export async function setOutput({ id }) {
  const outputs = await macctl(['audio', 'outputs']);
  if (!outputs.some((output) => output.id === id)) throw new ActionError('no-such-device');
  await macctl(['audio', 'set-output', id]);
  return { id };
}

export async function mediaKey({ key }) {
  await macctl(['media', key]);
  return { key };
}
