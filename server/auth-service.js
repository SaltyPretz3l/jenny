'use strict';

const crypto = require('node:crypto');
const { requireBoundedInteger } = require('./resource-limits');

const {
  AuthStore,
  AuthStoreError,
  MAX_SESSIONS,
  SCRYPT_PARAMS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  hashOpaque,
} = require('./auth-store');

const PASSWORD_MIN_BYTES = 8;
const PASSWORD_MAX_BYTES = 1024;
const TOKEN_BYTES = 32;
const SESSION_ID_BYTES = 16;
const VERIFY_WINDOW_MS = 60 * 1000;
const VERIFY_ATTEMPTS_PER_WINDOW = 5;
const MAX_RATE_KEYS = 1024;
const AUTH_COOKIE_NAME = '__Host-jenny';

function invalid(code, message) {
  return { ok: false, code, message };
}

function validPassword(password) {
  return typeof password === 'string'
    && Buffer.byteLength(password, 'utf8') >= PASSWORD_MIN_BYTES
    && Buffer.byteLength(password, 'utf8') <= PASSWORD_MAX_BYTES;
}

function opaqueToken(bytes = TOKEN_BYTES) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// The opaque login cookie is a random secret, never its persisted hash. Domain
// separation gives each session a stable CSRF token without storing raw tokens
// or allowing the browser to recover the HttpOnly authentication credential.
function sessionCsrfToken(token) {
  return crypto.createHmac('sha256', token).update('jenny-host-csrf-v1').digest('base64url');
}

function safeNow(now) {
  const value = Number(now());
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
}

function constantTimeStringEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function constantTimeHashEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string'
    || !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

async function scryptHash(password, salt = crypto.randomBytes(16)) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_PARAMS.keyLength, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      maxmem: 256 * 1024 * 1024,
    }, (error, derived) => error ? reject(error) : resolve({ salt, derived }));
  });
}

async function defaultPasswordHasher(password) {
  const result = await scryptHash(password);
  return {
    salt: result.salt.toString('base64'),
    hash: result.derived.toString('base64'),
    params: {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      key_length: SCRYPT_PARAMS.keyLength,
    },
  };
}

async function defaultPasswordVerifier(password, record) {
  if (!record || !record.salt || !record.hash
    || record.params?.N !== SCRYPT_PARAMS.N
    || record.params?.r !== SCRYPT_PARAMS.r
    || record.params?.p !== SCRYPT_PARAMS.p
    || record.params?.key_length !== SCRYPT_PARAMS.keyLength) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(record.salt, 'base64');
    expected = Buffer.from(record.hash, 'base64');
  } catch (_error) {
    return false;
  }
  if (salt.length !== 16 || expected.length !== SCRYPT_PARAMS.keyLength) return false;
  const result = await scryptHash(password, salt);
  return expected.length === result.derived.length
    && crypto.timingSafeEqual(expected, result.derived);
}

class AuthService {
  constructor({
    filePath,
    store,
    logger = null,
    now = Date.now,
    passwordHasher = defaultPasswordHasher,
    passwordVerifier = defaultPasswordVerifier,
    maxVerifyAttempts = VERIFY_ATTEMPTS_PER_WINDOW,
    verifyWindowMs = VERIFY_WINDOW_MS,
    onInvalidate = null,
  } = {}) {
    this.store = store || new AuthStore({ filePath, logger, now });
    this._onInvalidate = onInvalidate;
    this._invalidationFailed = false;
    this._logger = typeof logger === 'function' ? logger : null;
    this._now = typeof now === 'function' ? now : () => Number(now);
    this._hashPassword = passwordHasher;
    this._verifyPassword = passwordVerifier;
    this._maxVerifyAttempts = requireBoundedInteger(maxVerifyAttempts, VERIFY_ATTEMPTS_PER_WINDOW);
    this._verifyWindowMs = requireBoundedInteger(verifyWindowMs, VERIFY_WINDOW_MS);
    this._verifyBusy = false;
    this._rate = new Map();
    this._revoked = new Set();
  }

  _rememberRevoked(tokenHash) {
    this._revoked.add(tokenHash);
    // Session persistence is capped at 16; a small extra cap prevents failed
    // revocation retries from growing process memory without bound.
    while (this._revoked.size > MAX_SESSIONS * 4) {
      this._revoked.delete(this._revoked.values().next().value);
    }
  }

  _isRevoked(tokenHash) {
    for (const revokedHash of this._revoked) {
      if (constantTimeHashEqual(revokedHash, tokenHash)) return true;
    }
    return false;
  }

  _log(level, event, fields = {}) {
    if (!this._logger) return;
    try { this._logger(level, event, fields); } catch (_error) { /* caller logger cannot affect auth */ }
  }

  _invalidate(session, reason) {
    this._rememberRevoked(session.token_hash);
    try { this._onInvalidate?.(session.id, reason); }
    catch (_error) {
      this._invalidationFailed = true;
      this._log('ERROR', 'auth.invalidation_failed');
    }
  }

  _timestamp() { return safeNow(this._now); }

  isConfigured() {
    try { return this.store.isConfigured(); } catch (_error) { return false; }
  }

  async initializePassword(password) {
    if (!validPassword(password)) return invalid('AUTH_PASSWORD_INVALID', 'Password does not meet the password bounds.');
    try {
      if (this.store.isConfigured()) return invalid('AUTH_ALREADY_INITIALIZED', 'Authentication is already initialized.');
      const record = await this._hashPassword(password);
      if (!record || typeof record !== 'object') return invalid('AUTH_PASSWORD_HASH_FAILED', 'Password hashing failed.');
      await this.store.mutate((state) => {
        if (state.password !== null) throw new AuthStoreError('AUTH_ALREADY_INITIALIZED', 'Authentication is already initialized.');
        return { ...state, password: record };
      });
      this._log('INFO', 'auth.password_initialized');
      return { ok: true };
    } catch (error) {
      if (error?.code === 'AUTH_ALREADY_INITIALIZED') return invalid(error.code, error.message);
      if (error?.code === 'AUTH_STORE_WRITE_FAILED') return invalid(error.code, error.message);
      this._log('ERROR', 'auth.password_initialization_failed', { code: error?.code || null });
      return invalid('AUTH_PASSWORD_HASH_FAILED', 'Password hashing failed.');
    }
  }

  _rateKey(options) {
    const supplied = options?.rateKey ?? 'global';
    const value = String(supplied || 'global').slice(0, 200);
    return value || 'global';
  }

  _allowVerify(key) {
    const now = this._timestamp();
    let entry = this._rate.get(key);
    if (!entry || now - entry.startedAt >= this._verifyWindowMs) {
      entry = { startedAt: now, attempts: 0 };
      this._rate.set(key, entry);
    }
    if (this._rate.size > MAX_RATE_KEYS) {
      const oldest = this._rate.keys().next().value;
      if (oldest !== undefined && oldest !== key) this._rate.delete(oldest);
    }
    if (entry.attempts >= this._maxVerifyAttempts || this._verifyBusy) return false;
    entry.attempts += 1;
    return true;
  }

  async _verify(password, record, rateKey) {
    if (!this._allowVerify(rateKey)) return invalid('AUTH_RATE_LIMITED', 'Authentication verification is temporarily busy.');
    this._verifyBusy = true;
    try {
      const verified = await this._verifyPassword(password, record);
      return verified === true;
    } catch (_error) {
      return false;
    } finally {
      this._verifyBusy = false;
    }
  }

  async login(input = {}) {
    if (this._invalidationFailed) return invalid('AUTH_UNAVAILABLE', 'Authentication is unavailable.');
    const password = input.password;
    let state;
    try { state = this.store.snapshot(); } catch (error) {
      this._log('ERROR', 'auth.login_rejected', { code: error?.code || 'AUTH_STORE_UNAVAILABLE' });
      return invalid(error?.code || 'AUTH_STORE_UNAVAILABLE', 'Authentication is unavailable.');
    }
    if (state.password === null) return invalid('AUTH_NOT_INITIALIZED', 'Authentication has not been initialized.');
    if (!validPassword(password)) {
      this._log('WARN', 'auth.login_failed', { code: 'AUTH_INVALID_CREDENTIALS' });
      return invalid('AUTH_INVALID_CREDENTIALS', 'Invalid credentials.');
    }
    const verified = await this._verify(password, state.password, this._rateKey(input));
    if (verified !== true) {
      const code = verified?.code || 'AUTH_INVALID_CREDENTIALS';
      this._log('WARN', 'auth.login_failed', { code });
      return invalid(code, code === 'AUTH_RATE_LIMITED' ? verified.message : 'Invalid credentials.');
    }
    const now = this._timestamp();
    const token = opaqueToken();
    const csrfToken = sessionCsrfToken(token);
    const session = {
      id: opaqueToken(SESSION_ID_BYTES),
      token_hash: hashOpaque(token),
      csrf_hash: hashOpaque(csrfToken),
      created_at: now,
      last_seen_at: now,
      expires_at: now + SESSION_ABSOLUTE_MS,
    };
    try {
      await this.store.mutate((current) => {
        if (current.password === null) throw new AuthStoreError('AUTH_NOT_INITIALIZED', 'Authentication has not been initialized.');
        const sessions = current.sessions.filter((entry) => {
          if (!this._expired(entry, now)) return true;
          this._invalidate(entry, 'expired');
          return false;
        });
        sessions.push(session);
        while (sessions.length > MAX_SESSIONS) this._invalidate(sessions.shift(), 'session_limit');
        return { ...current, sessions };
      });
    } catch (error) {
      this._log('ERROR', 'auth.login_persistence_failed', { code: error?.code || null });
      return invalid(error?.code || 'AUTH_STORE_WRITE_FAILED', 'Authentication is unavailable.');
    }
    this._log('INFO', 'auth.login_succeeded', { session_id: session.id });
    return {
      ok: true,
      token,
      csrfToken,
      session: this._publicSession(session),
    };
  }

  _expired(session, now = this._timestamp()) {
    return now >= session.expires_at || now - session.last_seen_at >= SESSION_IDLE_MS;
  }

  _publicSession(session) {
    return {
      id: session.id,
      createdAt: session.created_at,
      lastSeenAt: session.last_seen_at,
      expiresAt: session.expires_at,
    };
  }

  async authenticateCookie(token, { touch = true } = {}) {
    if (this._invalidationFailed) return invalid('AUTH_UNAVAILABLE', 'Authentication is unavailable.');
    if (typeof token !== 'string' || token.length < 32 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      return invalid('AUTH_UNAUTHENTICATED', 'Authentication required.');
    }
    const tokenHash = hashOpaque(token);
    if (this._isRevoked(tokenHash)) return invalid('AUTH_UNAUTHENTICATED', 'Authentication required.');
    const now = this._timestamp();
    try {
      let authenticated;
      await this.store.mutate((state) => {
        const current = state.sessions.find((entry) => constantTimeHashEqual(entry.token_hash, tokenHash));
        if (!current || this._expired(current, now)) {
          authenticated = false;
          return state;
        }
        if (touch && now - current.last_seen_at >= 60_000) current.last_seen_at = Math.max(current.last_seen_at, now);
        authenticated = this._publicSession(current);
        return state;
      });
      if (!authenticated || !this.isSessionActive(authenticated.id)) return invalid('AUTH_UNAUTHENTICATED', 'Authentication required.');
      return { ok: true, session: authenticated };
    } catch (error) {
      this._log('ERROR', 'auth.authenticate_failed', { code: error?.code || null });
      return invalid(error?.code || 'AUTH_STORE_UNAVAILABLE', 'Authentication is unavailable.');
    }
  }

  async validateCsrf(token, csrfToken) {
    if (typeof csrfToken !== 'string' || csrfToken.length < 32 || csrfToken.length > 256) return false;
    if (typeof token !== 'string') return false;
    const tokenHash = hashOpaque(token);
    if (this._isRevoked(tokenHash)) return false;
    try {
      const state = this.store.snapshot();
      const session = state.sessions.find((entry) => constantTimeHashEqual(entry.token_hash, tokenHash));
      // Preserve pre-upgrade random tokens until the existing session expires
      // or is revoked; bootstrapping another tab never replaces that hash.
      return Boolean(session && !this._expired(session) && (
        constantTimeStringEqual(session.csrf_hash, hashOpaque(csrfToken))
        || constantTimeStringEqual(sessionCsrfToken(token), csrfToken)
      ));
    } catch (_error) {
      return false;
    }
  }

  // Authenticated same-origin bootstrap returns the same token to every tab
  // sharing this cookie, including after a server restart. No schema change.
  async bootstrap(token) {
    const authenticated = await this.authenticateCookie(token);
    if (!authenticated.ok) return authenticated;
    const tokenHash = hashOpaque(token);
    try {
      const current = this.store.snapshot().sessions
        .find((entry) => constantTimeHashEqual(entry.token_hash, tokenHash));
      if (!current || this._isRevoked(tokenHash) || this._expired(current)) {
        return invalid('AUTH_UNAUTHENTICATED', 'Authentication required.');
      }
      return { ok: true, csrfToken: sessionCsrfToken(token), session: this._publicSession(current) };
    } catch (error) {
      this._log('ERROR', 'auth.bootstrap_failed', { code: error?.code || null });
      return invalid(error?.code || 'AUTH_STORE_UNAVAILABLE', 'Authentication is unavailable.');
    }
  }

  async logout(token) {
    return this._removeSession(token, 'auth.logout');
  }

  async revokeSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return invalid('AUTH_SESSION_INVALID', 'Session id is invalid.');
    try {
      let removed = false;
      await this.store.mutate((state) => {
        const session = state.sessions.find((entry) => entry.id === sessionId);
        if (!session) return state;
        removed = true;
        this._invalidate(session, 'revoked');
        return { ...state, sessions: state.sessions.filter((entry) => entry.id !== sessionId) };
      });
      return { ok: true, revoked: removed };
    } catch (error) {
      return invalid(error?.code || 'AUTH_STORE_WRITE_FAILED', 'Authentication is unavailable.');
    }
  }

  async _removeSession(token, event) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      return { ok: true, revoked: false };
    }
    const tokenHash = hashOpaque(token);
    try {
      let removed = false;
      await this.store.mutate((state) => {
        const session = state.sessions.find((entry) => constantTimeHashEqual(entry.token_hash, tokenHash));
        if (!session) return state;
        removed = true;
        this._invalidate(session, 'logout');
        return { ...state, sessions: state.sessions
          .filter((entry) => !constantTimeHashEqual(entry.token_hash, tokenHash)) };
      });
      this._log('INFO', event, { revoked: removed });
      return { ok: true, revoked: removed };
    } catch (error) {
      // Keep the in-memory deny-list when a session was identified but the
      // durable revocation could not land. This request cannot authenticate
      // again in this process; the caller receives a structured failure.
      this._rememberRevoked(tokenHash);
      return invalid(error?.code || 'AUTH_STORE_WRITE_FAILED', 'Authentication is unavailable.');
    }
  }

  listSessions() {
    try {
      const now = this._timestamp();
      return {
        ok: true,
        sessions: this._invalidationFailed ? [] : this.store.snapshot().sessions
          .filter((session) => !this._isRevoked(session.token_hash) && !this._expired(session, now))
          .map((session) => this._publicSession(session)),
      };
    } catch (error) {
      return invalid(error?.code || 'AUTH_STORE_UNAVAILABLE', 'Authentication is unavailable.');
    }
  }

  isSessionActive(sessionId) {
    const result = this.listSessions();
    return result.ok === true && result.sessions.some((session) => session.id === sessionId);
  }
}

module.exports = {
  AUTH_COOKIE_NAME,
  AuthService,
  defaultPasswordHasher,
  defaultPasswordVerifier,
  scryptHash,
  PASSWORD_MIN_BYTES,
  PASSWORD_MAX_BYTES,
  VERIFY_WINDOW_MS,
};
