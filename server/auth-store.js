'use strict';

// The hosted MVP authentication store owns exactly one JSON document.  It is
// deliberately small: password material is a salted scrypt record and session
// material is one-way hashed. The host durable-json primitive supplies
// fsync-backed atomic writes; this module adds fail-closed validation,
// serialization, and permission hardening around that primitive.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { readJson, writeJson } = require('../services/host/durable-json');

const AUTH_SCHEMA_VERSION = 1;
const SCRYPT_PARAMS = Object.freeze({ N: 2 ** 17, r: 8, p: 1, keyLength: 64 });
const MAX_SESSIONS = 16;
const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
const STORE_FILE_MODE = 0o600;
const STORE_DIRECTORY_MODE = 0o700;
const MAX_STORE_BYTES = 256 * 1024;

class AuthStoreError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'AuthStoreError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isBase64(value, expectedBytes) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === expectedBytes && decoded.toString('base64') === value;
  } catch (_error) {
    return false;
  }
}

function isHex(value, bytes) {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${bytes * 2}}$`).test(value);
}

function hashOpaque(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyAuthState() {
  return { schema_version: AUTH_SCHEMA_VERSION, password: null, sessions: [] };
}

function validateState(value, now = Date.now()) {
  if (!isPlainObject(value)) return { ok: false, reason: 'store_not_object' };
  if (!Object.keys(value).every((key) => ['schema_version', 'password', 'sessions'].includes(key))) {
    return { ok: false, reason: 'store_unknown_field' };
  }
  if (value.schema_version !== AUTH_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: value.schema_version > AUTH_SCHEMA_VERSION ? 'future_schema' : 'unsupported_schema',
    };
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'password') || !Array.isArray(value.sessions)) {
    return { ok: false, reason: 'store_shape_invalid' };
  }
  if (value.sessions.length > MAX_SESSIONS) return { ok: false, reason: 'session_limit_exceeded' };

  if (value.password !== null) {
    if (!isPlainObject(value.password)
      || !Object.keys(value.password).every((key) => ['salt', 'hash', 'params'].includes(key))) {
      return { ok: false, reason: 'password_record_unknown_field' };
    }
    if (!isBase64(value.password.salt, 16)
      || !isBase64(value.password.hash, SCRYPT_PARAMS.keyLength)
      || !isPlainObject(value.password.params)
      || value.password.params.N !== SCRYPT_PARAMS.N
      || value.password.params.r !== SCRYPT_PARAMS.r
      || value.password.params.p !== SCRYPT_PARAMS.p
      || value.password.params.key_length !== SCRYPT_PARAMS.keyLength) {
      return { ok: false, reason: 'password_record_invalid' };
    }
  }

  const ids = new Set();
  const tokenHashes = new Set();
  const csrfHashes = new Set();
  for (const session of value.sessions) {
    if (!isPlainObject(session)
      || !Object.keys(session).every((key) => [
        'id', 'token_hash', 'csrf_hash', 'created_at', 'last_seen_at', 'expires_at',
      ].includes(key))) {
      return { ok: false, reason: 'session_record_unknown_field' };
    }
    if (!isPlainObject(session)
      || typeof session.id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(session.id)
      || ids.has(session.id)
      || !isHex(session.token_hash, 32)
      || !isHex(session.csrf_hash, 32)
      || tokenHashes.has(session.token_hash)
      || csrfHashes.has(session.csrf_hash)
      || !isSafeInteger(session.created_at)
      || !isSafeInteger(session.last_seen_at)
      || !isSafeInteger(session.expires_at)
      || session.last_seen_at < session.created_at
      || session.created_at > now + 300_000
      || session.last_seen_at > now + 300_000
      || session.expires_at - session.created_at > SESSION_ABSOLUTE_MS
      || session.expires_at < session.created_at
      || session.expires_at < session.last_seen_at) {
      return { ok: false, reason: 'session_record_invalid' };
    }
    ids.add(session.id);
    tokenHashes.add(session.token_hash);
    csrfHashes.add(session.csrf_hash);
  }
  return { ok: true };
}

class AuthStore {
  constructor({ filePath, store, logger = null, now = Date.now } = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw new TypeError('AuthStore requires an absolute filePath.');
    }
    this.filePath = filePath;
    this._logger = typeof logger === 'function' ? logger : null;
    this._now = typeof now === 'function' ? now : () => Number(now);
    // `store` is retained as a narrow test seam. Production uses the host
    // durable-json primitive, which fsyncs both the file and containing
    // directory before a successful mutation is acknowledged.
    this._fileStore = store || null;
    this._loaded = false;
    this._state = null;
    this._broken = null;
    this._mutationChain = Promise.resolve();
  }

  _log(level, event, fields = {}) {
    if (!this._logger) return;
    try { this._logger(level, event, fields); } catch (_error) { /* logging is non-authoritative */ }
  }

  _validatePermissions() {
    const directory = path.dirname(this.filePath);
    if (fs.existsSync(directory)) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_auth_directory');
      if (process.platform !== 'win32' && ((stat.mode & 0o777) !== STORE_DIRECTORY_MODE
        || fs.realpathSync(directory) !== path.resolve(directory))) throw new Error('unsafe_auth_directory');
    }
    if (fs.existsSync(this.filePath)) {
      const stat = fs.lstatSync(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('invalid_auth_file');
      if (process.platform !== 'win32' && (stat.mode & 0o777) !== STORE_FILE_MODE) throw new Error('unsafe_auth_file');
    }
  }

  _load() {
    if (this._broken) throw this._broken;
    if (this._loaded) return this._state;
    let candidate;
    try {
      this._validatePermissions();
      if (this._fileStore) {
        const result = this._fileStore.readWithStatus(emptyAuthState());
        if (result.corrupted) throw new AuthStoreError('AUTH_STORE_CORRUPT', 'Authentication store is unreadable.');
        candidate = result.value;
      } else {
        const existed = fs.existsSync(this.filePath);
        candidate = readJson(this.filePath, { maxBytes: MAX_STORE_BYTES });
        if (candidate === null && !existed) candidate = emptyAuthState();
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        candidate = emptyAuthState();
      } else if (error?.code === 'AUTH_STORE_CORRUPT') {
        this._broken = error;
        this._log('ERROR', 'auth_store.read_failed', { reason: 'corrupt' });
        throw error;
      } else {
        const storeError = new AuthStoreError('AUTH_STORE_CORRUPT', 'Authentication store is unreadable.', error);
        this._broken = storeError;
        this._log('ERROR', 'auth_store.read_failed', { reason: 'corrupt', code: error?.code || null });
        throw storeError;
      }
    }
    const checked = validateState(candidate, this._now());
    if (!checked.ok) {
      const error = new AuthStoreError('AUTH_STORE_INVALID', 'Authentication store is invalid.');
      this._broken = error;
      this._log('ERROR', 'auth_store.rejected', { reason: checked.reason });
      throw error;
    }
    this._state = clone(candidate);
    this._loaded = true;
    return this._state;
  }

  snapshot() {
    return clone(this._load());
  }

  isConfigured() {
    return this._load().password !== null;
  }

  async mutate(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('AuthStore.mutate requires a function.');
    const run = async () => {
      const current = clone(this._load());
      const previous = clone(current);
      let next = await mutator(current);
      if (next === undefined) next = current;
      const checked = validateState(next, this._now());
      if (!checked.ok) {
        throw new AuthStoreError('AUTH_STORE_INVALID', 'Authentication mutation produced invalid state.');
      }
      if (JSON.stringify(next) === JSON.stringify(previous)) return clone(current);
      try {
        this._validatePermissions();
        // The durable write is synchronous and atomic. It throws before
        // memory is committed when the rename or fsync cannot complete.
        if (this._fileStore) this._fileStore.writeImmediate(next);
        else writeJson(this.filePath, next);
      } catch (error) {
        this._log('ERROR', 'auth_store.write_failed', { code: error?.code || null });
        this._broken = new AuthStoreError('AUTH_STORE_WRITE_FAILED', 'Authentication state could not be persisted.', error);
        throw this._broken;
      }
      this._state = clone(next);
      this._loaded = true;
      return clone(next);
    };
    const result = this._mutationChain.then(run, run);
    // Keep future mutations running after a rejected mutation while retaining
    // the rejection for this caller.
    this._mutationChain = result.catch(() => undefined);
    return result;
  }
}

module.exports = {
  AUTH_SCHEMA_VERSION,
  MAX_SESSIONS,
  SCRYPT_PARAMS,
  SESSION_IDLE_MS,
  SESSION_ABSOLUTE_MS,
  MAX_STORE_BYTES,
  AuthStore,
  AuthStoreError,
  hashOpaque,
  validateState,
};
