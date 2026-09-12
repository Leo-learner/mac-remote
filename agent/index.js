// mac-remote agent: connects out to the relay and executes allow-listed actions.
// stdout carries one JSON object per line for the MacRemote launcher (status icon + log).
import { loadConfig } from './config.js';
import { dispatch, READ_ONLY } from './registry.js';
import { startRelayClient } from './relay-client.js';
import { snapshot } from './state.js';

const VERSION = '0.1.0';
const VIEWER_TICK_MS = 3000;

const report = (event, details = {}) => process.stdout.write(`${JSON.stringify({ event, ...details, ts: Date.now() })}\n`);

const config = await loadConfig();
let viewers = 0;
let timer = null;
let lastSent = '';

const client = startRelayClient({
  url: config.relayUrl,
  token: config.deviceToken,
  hello: () => ({ type: 'hello', version: VERSION }),
  onStatus(status, details) {
    report('status', { status, ...details });
    if (status === 'connected') {
      lastSent = '';
      tick();
    }
  },
  onViewers(count) {
    const wasIdle = viewers === 0;
    viewers = count;
    if (wasIdle && viewers > 0) tick();
    else schedule();
  },
  async onRpc({ action, params, confirmed, meta }) {
    try {
      const result = await dispatch(action, params ?? {}, { confirmed: confirmed === true, via: meta });
      const changed = !READ_ONLY.has(action) && !result?.needsConfirm;
      return { ok: true, result, state: changed ? await pushState(true) : undefined };
    } catch (error) {
      if (!error.code) report('error', { action, message: error.message });
      return { ok: false, error: error.code || 'internal', message: error.message };
    }
  },
});

// Push only when something changed; the relay keeps the last snapshot for the phone.
async function pushState(force = false) {
  const state = await snapshot();
  const key = JSON.stringify({ ...state, ts: 0 });
  if (force || key !== lastSent) {
    lastSent = key;
    client.send({ type: 'state', state });
  }
  return state;
}

// Poll only while someone is looking; an idle Mac is not sampled at all.
function schedule() {
  clearTimeout(timer);
  if (viewers > 0) timer = setTimeout(tick, VIEWER_TICK_MS);
}

async function tick() {
  try {
    await pushState();
  } catch (error) {
    report('error', { message: error.message });
  }
  schedule();
}

function stopAgent() {
  clearTimeout(timer);
  client.stop();
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGTERM', stopAgent);
process.on('SIGINT', stopAgent);

report('started', { version: VERSION, relay: new URL(config.relayUrl).host });
