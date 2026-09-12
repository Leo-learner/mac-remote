// Single-user authentication: scrypt password hash, TOTP (RFC 6238), in-memory sessions and
// login throttling. No registration, no database: the relay has exactly one owner.
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// ---- Password (scrypt) ------------------------------------------------------------------

const SCRYPT = { N: 2 ** 15, r: 8, p: 1 };
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

function scryptAsync(password, salt, keylen, params) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { ...params, maxmem: SCRYPT_MAXMEM }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

// Stored as scrypt:N:r:p:salt:hash (base64). No "$", so it survives .env and systemd files verbatim.
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(String(password).normalize('NFKC'), salt, 32, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join(':');
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(String(password).normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}

// ---- TOTP (RFC 6238, SHA-1, 30 s) ----------------------------------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of String(text).toUpperCase().replace(/[\s=-]/g, '')) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('invalid base32 character');
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function totpAt(secretBase32, counter, digits = 6) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secretBase32)).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Returns the matching time-step counter, or null. Codes at or below `lastCounter` are
// rejected, so each code works once even inside its 30 s window.
export function checkTotp(secretBase32, code, { now = Date.now(), window = 1, lastCounter = -1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30_000);
  for (let counter = current - window; counter <= current + window; counter += 1) {
    if (counter > lastCounter && safeEqual(totpAt(secretBase32, counter), code)) return counter;
  }
  return null;
}

// ---- Sessions ---------------------------------------------------------------------------

// Keyed by SHA-256 of the cookie value, so the map itself never holds usable session ids.
export class Sessions {
  constructor({ idleMs = 12 * 3600_000, absoluteMs = 7 * 24 * 3600_000, now = Date.now } = {}) {
    this.idleMs = idleMs;
    this.absoluteMs = absoluteMs;
    this.now = now;
    this.entries = new Map();
  }

  static keyOf(id) {
    return createHash('sha256').update(String(id)).digest('hex');
  }

  create(info = {}) {
    const id = randomBytes(32).toString('base64url');
    const at = this.now();
    this.entries.set(Sessions.keyOf(id), { ...info, createdAt: at, seenAt: at });
    return id;
  }

  expired(session, at) {
    return at - session.seenAt > this.idleMs || at - session.createdAt > this.absoluteMs;
  }

  // Returns { key, session } for a live session and refreshes its idle timer.
  touch(id) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
    const key = Sessions.keyOf(id);
    const session = this.entries.get(key);
    if (!session) return null;
    const at = this.now();
    if (this.expired(session, at)) {
      this.entries.delete(key);
      return null;
    }
    session.seenAt = at;
    return { key, session };
  }

  destroy(id) {
    this.entries.delete(Sessions.keyOf(id));
  }

  sweep() {
    const at = this.now();
    for (const [key, session] of this.entries) if (this.expired(session, at)) this.entries.delete(key);
  }
}

// ---- Login throttling -------------------------------------------------------------------

// Back-off after failed logins from one IP. Default: three free attempts, then 30 s doubling
// up to 1 h. Tune freely — security against brute force vs. locking yourself out.
export function loginDelayMs(failures) {
  if (failures < 3) return 0;
  return Math.min(30_000 * 2 ** (failures - 3), 3_600_000);
}

export class LoginThrottle {
  constructor({ now = Date.now, globalLimit = 30, globalWindowMs = 15 * 60_000 } = {}) {
    this.now = now;
    this.globalLimit = globalLimit;
    this.globalWindowMs = globalWindowMs;
    this.byIp = new Map();
    this.recentFailures = [];
  }

  check(ip) {
    const at = this.now();
    this.recentFailures = this.recentFailures.filter((ts) => at - ts < this.globalWindowMs);
    if (this.recentFailures.length >= this.globalLimit) {
      return { allowed: false, retryAfterMs: this.globalWindowMs - (at - this.recentFailures[0]) };
    }
    const entry = this.byIp.get(ip);
    if (entry && entry.until > at) return { allowed: false, retryAfterMs: entry.until - at };
    return { allowed: true, retryAfterMs: 0 };
  }

  fail(ip) {
    const at = this.now();
    this.recentFailures.push(at);
    const entry = this.byIp.get(ip) ?? { count: 0, until: 0 };
    entry.count += 1;
    entry.until = at + loginDelayMs(entry.count);
    this.byIp.set(ip, entry);
  }

  succeed(ip) {
    this.byIp.delete(ip);
  }
}
