// Outbound WebSocket to the relay. The Mac never listens on a port; this link is the only way in.
//   agent -> relay: {type:'hello'}, {type:'state', state}, {type:'result', id, ok, result|error, state?}
//   relay -> agent: {type:'rpc', id, action, params, confirmed, meta}, {type:'viewers', count}
import WebSocket from 'ws';

const PING_EVERY_MS = 20_000;
const MAX_RETRY_MS = 30_000;

export function startRelayClient({ url, token, hello, onRpc, onViewers, onStatus }) {
  let socket = null;
  let pingTimer = null;
  let retryMs = 1000;
  let stopped = false;

  const send = (message) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  function connect() {
    if (stopped) return;
    onStatus('connecting');
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 10_000,
      maxPayload: 1 << 20,
    });
    socket = ws;
    let awaitingPong = false;

    ws.on('open', () => {
      retryMs = 1000;
      send(hello());
      onStatus('connected');
      // A link that silently died (sleep, network change) is only noticed by a missing pong.
      pingTimer = setInterval(() => {
        if (awaitingPong) return ws.terminate();
        awaitingPong = true;
        ws.ping();
      }, PING_EVERY_MS);
    });
    ws.on('pong', () => {
      awaitingPong = false;
    });
    ws.on('message', async (data) => {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.type === 'rpc' && typeof message.id === 'string') {
        send({ type: 'result', id: message.id, ...(await onRpc(message)) });
      } else if (message.type === 'viewers') {
        onViewers(Number(message.count) || 0);
      }
    });
    ws.on('error', (error) => onStatus('error', { message: error.message }));
    ws.on('close', (code) => {
      clearInterval(pingTimer);
      onStatus('disconnected', { code });
      if (!stopped) {
        const delay = retryMs * (0.8 + Math.random() * 0.4);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
        setTimeout(connect, delay);
      }
    });
  }

  connect();
  return {
    send,
    stop() {
      stopped = true;
      clearInterval(pingTimer);
      socket?.close(1000, 'agent stopping');
    },
  };
}
