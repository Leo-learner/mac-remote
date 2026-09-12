// mac-remote relay: the only public entry point. It serves the phone UI behind a password + TOTP
// login and forwards allow-listed actions to the Mac agent over the agent's outbound WebSocket.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { ACTION_NAMES } from '../shared/actions.js';
import { LoginThrottle, Sessions, base32Decode, checkTotp, verifyPassword } from './auth.js';

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const READ_ONLY = new Set(['state.get', 'apps.installed', 'apps.icon']);
const RPC_TIMEOUT_MS = 20_000;
const VIEWER_TTL_MS = 8_000;
const SESSION_MAX_AGE_S = 7 * 24 * 3600;
const INSTALLED_TTL_MS = 10 * 60_000;
const CSP = [
  "default-src 'self'", "img-src 'self' data:", "script-src 'self'", "style-src 'self'",
  "connect-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

export function configFromEnv(env = process.env) {
  const missing = ['PASSWORD_HASH', 'TOTP_SECRET', 'AGENT_TOKEN_SHA256'].filter((key) => !env[key]);
  if (missing.length) throw new Error(`missing ${missing.join(', ')} (generate them with relay/setup.js)`);
  if (!env.PASSWORD_HASH.startsWith('scrypt:')) throw new Error('PASSWORD_HASH must come from relay/setup.js');
  if (base32Decode(env.TOTP_SECRET).length < 10) throw new Error('TOTP_SECRET is too short');
  if (!/^[0-9a-f]{64}$/i.test(env.AGENT_TOKEN_SHA256)) throw new Error('AGENT_TOKEN_SHA256 must be 64 hex characters');
  const port = Number(env.PORT || 3030);
  return {
    port,
    host: env.HOST || '127.0.0.1',
    publicOrigin: (env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`).replace(/\/$/, ''),
    passwordHash: env.PASSWORD_HASH,
    totpSecret: env.TOTP_SECRET,
    agentTokenSha256: env.AGENT_TOKEN_SHA256.toLowerCase(),
    dataDir: env.RELAY_DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url)),
  };
}

export function createRelay(config) {
  const secure = config.publicOrigin.startsWith('https://');
  const cookieName = secure ? '__Host-sid' : 'sid';
  const sessions = new Sessions();
  const throttle = new LoginThrottle();
  const agentDigest = Buffer.from(config.agentTokenSha256, 'hex');
  let lastTotpCounter = -1;

  // ---- audit trail -----------------------------------------------------------------------
  const auditFile = join(config.dataDir, 'audit.jsonl');
  let auditQueue = mkdir(config.dataDir, { recursive: true }).catch(() => {});
  function audit(entry) {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
    auditQueue = auditQueue.then(() => appendFile(auditFile, line, { mode: 0o600 })).catch(() => {});
  }

  // ---- agent link --------------------------------------------------------------------------
  let agent = null; // { ws, alive, version }
  let state = null; // latest snapshot pushed by the agent
  let stateAt = 0;
  let lastSeen = 0;
  const pending = new Map(); // rpc id -> { resolve, timer }

  function rememberState(next) {
    if (next && typeof next === 'object') {
      state = next;
      stateAt = Date.now();
    }
  }

  function rpc(action, params, { confirmed = false, meta } = {}) {
    return new Promise((resolve) => {
      if (!agent) return resolve({ ok: false, error: 'agent-offline' });
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'agent-timeout' });
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      agent.ws.send(JSON.stringify({ type: 'rpc', id, action, params, confirmed, meta }));
    });
  }

  // Sessions that polled recently count as viewers; the agent samples only while count > 0.
  const viewers = new Map(); // session key -> last poll
  let reportedViewers = -1;
  function syncViewers() {
    const now = Date.now();
    for (const [key, at] of viewers) if (now - at > VIEWER_TTL_MS) viewers.delete(key);
    if (agent && viewers.size !== reportedViewers) {
      agent.ws.send(JSON.stringify({ type: 'viewers', count: viewers.size }));
      reportedViewers = viewers.size;
    }
  }

  // ---- HTTP --------------------------------------------------------------------------------
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  });

  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const noStore = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const cookieValue = (req) => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === cookieName) return rest.join('=');
    }
    return null;
  };
  const sessionOf = (req) => sessions.touch(cookieValue(req));
  const pageSession = (req, res, next) => {
    const found = sessionOf(req);
    if (!found) return res.redirect(302, '/');
    req.sessionKey = found.key;
    next();
  };
  const apiSession = (req, res, next) => {
    const found = sessionOf(req);
    if (!found) return res.status(401).json({ ok: false, error: 'unauthenticated' });
    req.sessionKey = found.key;
    next();
  };
  // Cookies are SameSite=Strict already; the Origin check is the second lock on state changes.
  const sameOrigin = (req, res, next) => {
    const origin = req.get('origin');
    const ok = origin ? origin === config.publicOrigin : req.get('sec-fetch-site') === 'same-origin';
    if (ok) return next();
    res.status(403).json({ ok: false, error: 'bad-origin' });
  };
  // Token bucket per session: bursts for slider drags, ~3 actions/s sustained.
  const buckets = new Map();
  const actionLimit = (req, res, next) => {
    const now = Date.now();
    const bucket = buckets.get(req.sessionKey) ?? { tokens: 40, at: now };
    bucket.tokens = Math.min(40, bucket.tokens + ((now - bucket.at) / 1000) * 3);
    bucket.at = now;
    buckets.set(req.sessionKey, bucket);
    if (bucket.tokens < 1) return res.status(429).json({ ok: false, error: 'slow-down' });
    bucket.tokens -= 1;
    next();
  };

  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  app.get('/', noStore, (req, res) => (sessionOf(req)
    ? res.redirect(302, '/app/')
    : res.sendFile(join(WEB_ROOT, 'public', 'login.html'))));
  app.use(express.static(join(WEB_ROOT, 'public'), { index: false, maxAge: '1h' }));

  app.post('/auth/login', noStore, sameOrigin, express.json({ limit: '2kb' }), wrap(async (req, res) => {
    const gate = throttle.check(req.ip);
    if (!gate.allowed) {
      const retryAfterSec = Math.ceil(gate.retryAfterMs / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ ok: false, error: 'too-many-attempts', retryAfterSec });
    }
    const { password, code } = req.body ?? {};
    const passwordOk = typeof password === 'string' && password.length <= 256
      && (await verifyPassword(password, config.passwordHash));
    const counter = passwordOk ? checkTotp(config.totpSecret, String(code ?? ''), { lastCounter: lastTotpCounter }) : null;
    if (counter === null) {
      throttle.fail(req.ip);
      audit({ event: 'login-failed', ip: req.ip });
      return res.status(401).json({ ok: false, error: 'invalid-credentials' });
    }
    lastTotpCounter = counter;
    throttle.succeed(req.ip);
    const id = sessions.create({ ip: req.ip, ua: String(req.get('user-agent') ?? '').slice(0, 160) });
    res.set('Set-Cookie', `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_S}${secure ? '; Secure' : ''}`);
    audit({ event: 'login', ip: req.ip });
    res.json({ ok: true });
  }));

  app.post('/auth/logout', noStore, sameOrigin, (req, res) => {
    const id = cookieValue(req);
    if (id) sessions.destroy(id);
    res.set('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
    res.json({ ok: true });
  });

  // The control UI itself is only ever sent to a logged-in session.
  app.use('/app', pageSession, (req, res, next) => {
    res.set('Cache-Control', 'no-cache');
    next();
  }, express.static(join(WEB_ROOT, 'app'), { index: 'index.html' }));

  app.get('/api/state', noStore, apiSession, (req, res) => {
    viewers.set(req.sessionKey, Date.now());
    syncViewers();
    res.json({ ok: true, online: Boolean(agent), lastSeen, stateAt, state });
  });

  app.post('/api/action', noStore, apiSession, sameOrigin, actionLimit, express.json({ limit: '16kb' }), wrap(async (req, res) => {
    const { action, params = {}, confirmed = false } = req.body ?? {};
    if (!ACTION_NAMES.includes(action)) return res.status(400).json({ ok: false, error: 'unknown-action' });
    const reply = await rpc(action, params, { confirmed: confirmed === true, meta: { ip: req.ip } });
    if (!READ_ONLY.has(action)) audit({ event: 'action', action, params, ok: reply.ok, error: reply.error, ip: req.ip });
    const status = reply.ok ? 200 : { 'agent-offline': 503, 'agent-timeout': 504 }[reply.error] ?? 400;
    res.status(status).json(reply);
  }));

  let installed = { at: 0, apps: null };
  app.get('/api/installed', noStore, apiSession, wrap(async (req, res) => {
    if (!installed.apps || Date.now() - installed.at > INSTALLED_TTL_MS) {
      const reply = await rpc('apps.installed', {});
      if (!reply.ok) return res.status(reply.error === 'agent-offline' ? 503 : 502).json(reply);
      installed = { at: Date.now(), apps: reply.result };
    }
    res.json({ ok: true, apps: installed.apps });
  }));

  const icons = new Map();
  app.get('/api/icon/:bundleId', apiSession, wrap(async (req, res) => {
    const { bundleId } = req.params;
    if (!BUNDLE_ID.test(bundleId)) return res.sendStatus(400);
    let icon = icons.get(bundleId);
    if (!icon) {
      const reply = await rpc('apps.icon', { bundleId });
      if (!reply.ok) return res.sendStatus(reply.error === 'agent-offline' ? 503 : 404);
      const png = Buffer.from(String(reply.result?.png ?? ''), 'base64');
      if (png.length === 0 || png.length > 2_000_000) return res.sendStatus(502);
      icon = { png, etag: `"${createHash('sha1').update(png).digest('hex').slice(0, 20)}"` };
      if (icons.size >= 400) icons.clear();
      icons.set(bundleId, icon);
    }
    res.set({ 'Cache-Control': 'private, max-age=604800', ETag: icon.etag });
    if (req.get('if-none-match') === icon.etag) return res.status(304).end();
    res.type('png').send(icon.png);
  }));

  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = error.status ?? error.statusCode ?? 500;
    res.status(status).json({ ok: false, error: status === 400 ? 'bad-request' : status === 413 ? 'too-large' : 'internal' });
  });

  // ---- WebSocket for the agent -------------------------------------------------------------
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const reject = (status) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (new URL(req.url, 'http://relay').pathname !== '/agent') return reject('404 Not Found');
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const digest = createHash('sha256').update(token ?? '').digest();
    if (!token || !timingSafeEqual(digest, agentDigest)) {
      audit({ event: 'agent-rejected', ip: socket.remoteAddress });
      return reject('401 Unauthorized');
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    if (agent) agent.ws.close(4000, 'replaced by a newer connection');
    const link = { ws, alive: true, version: '' };
    agent = link;
    lastSeen = Date.now();
    reportedViewers = -1;
    syncViewers();
    audit({ event: 'agent-connected' });

    ws.on('pong', () => {
      link.alive = true;
      lastSeen = Date.now();
    });
    ws.on('message', (data) => {
      lastSeen = Date.now();
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.type === 'hello') {
        link.version = String(message.version ?? '');
      } else if (message.type === 'state') {
        rememberState(message.state);
      } else if (message.type === 'result' && pending.has(message.id)) {
        const { resolve, timer } = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(timer);
        rememberState(message.state);
        const { type, id, ...body } = message; // eslint-disable-line no-unused-vars
        resolve(body);
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (agent !== link) return;
      agent = null;
      for (const { resolve, timer } of pending.values()) {
        clearTimeout(timer);
        resolve({ ok: false, error: 'agent-offline' });
      }
      pending.clear();
      audit({ event: 'agent-disconnected' });
    });
  });

  const timers = [
    setInterval(syncViewers, 2_000),
    setInterval(() => {
      if (agent) {
        if (!agent.alive) agent.ws.terminate();
        else {
          agent.alive = false;
          agent.ws.ping();
        }
      }
      sessions.sweep();
    }, 25_000),
  ];
  for (const timer of timers) timer.unref();

  return {
    server,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    async close() {
      for (const timer of timers) clearInterval(timer);
      for (const client of wss.clients) client.terminate();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
      await auditQueue;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configFromEnv();
  const relay = createRelay(config);
  const port = await relay.listen();
  console.log(`relay listening on ${config.host}:${port} (public origin ${config.publicOrigin})`);
  const stop = () => relay.close().finally(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
