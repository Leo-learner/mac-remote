// Command bus: validate -> policy -> handler -> audit. The only way anything runs on this Mac.
import { ACTIONS, validateParams } from '../shared/actions.js';
import { audit } from './audit.js';
import * as apps from './controls/apps.js';
import * as display from './controls/display.js';
import * as network from './controls/network.js';
import * as sound from './controls/sound.js';
import { ActionError } from './exec.js';
import { assessRisk } from './policy.js';
import { invalidateFor, policyContext, snapshot } from './state.js';

const HANDLERS = {
  'state.get': () => snapshot(),
  'apps.installed': () => apps.installedApps(),
  'apps.icon': apps.icon,
  'apps.open': apps.open,
  'apps.activate': apps.activate,
  'apps.hide': apps.hide,
  'apps.quit': apps.quit,
  'apps.forceQuit': apps.forceQuit,
  'wifi.set': network.setWifi,
  'bluetooth.set': network.setBluetooth,
  'proxy.set': network.setSystemProxy,
  'display.brightness.set': display.setBrightness,
  'display.awake.set': display.setDisplayAwake,
  'display.dark.set': display.setDark,
  'display.nightShift.set': display.setNightShift,
  'display.stageManager.set': display.setStageManager,
  'sound.volume.set': sound.setVolume,
  'sound.mute.set': sound.setMute,
  'sound.output.set': sound.setOutput,
  'media.key': sound.mediaKey,
};

for (const name of Object.keys(ACTIONS)) {
  if (!HANDLERS[name]) throw new Error(`no handler registered for action ${name}`);
}

export const READ_ONLY = new Set(['state.get', 'apps.installed', 'apps.icon']);

export async function dispatch(action, rawParams = {}, meta = {}) {
  const validation = validateParams(action, rawParams);
  if (!validation.ok) throw new ActionError('bad-params', validation.error);

  const decision = assessRisk(action, validation.params, await policyContext())
    ?? { allow: false, reason: 'policy returned nothing' };
  if (!decision.allow) {
    audit({ action, params: validation.params, ok: false, error: 'denied', reason: decision.reason, via: meta.via });
    throw new ActionError('denied', decision.reason || 'refused by policy');
  }
  if (decision.needsConfirm && !meta.confirmed) {
    return { needsConfirm: true, reason: decision.reason || '' };
  }

  // A policy may adjust params; they must still satisfy the schema.
  const adjusted = validateParams(action, decision.params ?? validation.params);
  if (!adjusted.ok) throw new ActionError('bad-params', `policy produced invalid params: ${adjusted.error}`);

  if (READ_ONLY.has(action)) return HANDLERS[action](adjusted.params);
  try {
    const result = await HANDLERS[action](adjusted.params);
    audit({ action, params: adjusted.params, ok: true, via: meta.via });
    return result;
  } catch (error) {
    audit({ action, params: adjusted.params, ok: false, error: error.code || 'internal', message: error.message, via: meta.via });
    throw error;
  } finally {
    invalidateFor(action);
  }
}
