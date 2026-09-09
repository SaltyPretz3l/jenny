'use strict';

const remoteCrypto = require('./remote-crypto');
const defaultLimits = require('./remote-limits');

const RECORD_VERSION = 1;
const RECORD_KEYS = Object.freeze([
  'record_version', 'desktop_id', 'desktop_secret', 'devices', 'shared_sessions', 'relay_url',
]);
const DEVICE_KEYS = Object.freeze([
  'device_id', 'label', 'device_secret', 'paired_at', 'last_seen_at', 'revision',
]);
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const RELAY_ORIGIN_RE = /^wss:\/\/[^/?#]+\/?$/;
// Explicit bounds keep the encrypted record well inside SecureStore's 64 KiB.
const MAX_SHARED_SESSIONS = 64;
const SESSION_ID_MAX_CHARS = 128;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function validTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validSecret(value) {
  try {
    return remoteCrypto.fromBase64Url(value).byteLength === 32;
  } catch (_error) {
    return false;
  }
}

function validId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= SESSION_ID_MAX_CHARS;
}

function validLabel(value) {
  return typeof value === 'string' && Array.from(value).length <= 64;
}

function validateRecord(value, maxDevices) {
  if (!isPlainObject(value)) return { ok: false, reason: 'record_malformed' };
  if (value.record_version !== RECORD_VERSION) {
    return Number.isInteger(value.record_version)
      ? { ok: false, reason: 'record_version_unsupported' }
      : { ok: false, reason: 'record_malformed' };
  }
  if (!hasExactKeys(value, RECORD_KEYS)
    || !validId(value.desktop_id) || !validSecret(value.desktop_secret)
    || !Array.isArray(value.devices) || value.devices.length > maxDevices
    || !Array.isArray(value.shared_sessions) || value.shared_sessions.length > MAX_SHARED_SESSIONS
    || typeof value.relay_url !== 'string') {
    return { ok: false, reason: 'record_malformed' };
  }

  const deviceIds = new Set();
  for (const device of value.devices) {
    if (!isPlainObject(device) || !hasExactKeys(device, DEVICE_KEYS)
      || !validId(device.device_id) || deviceIds.has(device.device_id)
      || !validLabel(device.label) || !validSecret(device.device_secret)
      || !validTime(device.paired_at) || !validTime(device.last_seen_at)
      || device.last_seen_at < device.paired_at
      || !Number.isSafeInteger(device.revision) || device.revision < 1) {
      return { ok: false, reason: 'record_malformed' };
    }
    deviceIds.add(device.device_id);
  }

  const sessionIds = new Set();
  for (const sessionId of value.shared_sessions) {
    if (!validSessionId(sessionId) || sessionIds.has(sessionId)) {
      return { ok: false, reason: 'record_malformed' };
    }
    sessionIds.add(sessionId);
  }
  if (value.relay_url && !normalizeRelayUrl(value.relay_url)) {
    return { ok: false, reason: 'record_malformed' };
  }
  return { ok: true };
}

function cloneRecord(record) {
  return {
    record_version: record.record_version,
    desktop_id: record.desktop_id,
    desktop_secret: record.desktop_secret,
    devices: record.devices.map((device) => ({ ...device })),
    shared_sessions: [...record.shared_sessions],
    relay_url: record.relay_url,
  };
}

function projectRecord(record) {
  if (!record) return null;
  return {
    record_version: record.record_version,
    desktop_id: record.desktop_id,
    devices: record.devices.map(({ device_secret: _secret, ...device }) => ({ ...device })),
    shared_sessions: [...record.shared_sessions],
    relay_url: record.relay_url,
  };
}

function hasForbiddenUrlCharacter(value) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return /\s/u.test(character) || codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function normalizeRelayUrl(value) {
  if (typeof value !== 'string' || !value || hasForbiddenUrlCharacter(value)
    || !RELAY_ORIGIN_RE.test(value)) return '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    return '';
  }
  if (parsed.protocol !== 'wss:' || !parsed.hostname || parsed.hostname.endsWith('.')
    || parsed.username || parsed.password
    || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    return '';
  }
  return parsed.origin;
}

function createDeviceStore({ secureStore, now, limits = defaultLimits } = {}) {
  if (!secureStore || typeof secureStore.hasRemoteControlRecord !== 'function'
    || typeof secureStore.getRemoteControlRecord !== 'function'
    || typeof secureStore.setRemoteControlRecord !== 'function'
    || typeof secureStore.deleteRemoteControlRecord !== 'function'
    || typeof now !== 'function'
    || !Number.isInteger(limits.MAX_DEVICES) || limits.MAX_DEVICES <= 0) {
    throw new TypeError('invalid device store configuration');
  }

  let record = null;
  let loaded = false;
  const revoked = new Set();
  let generation = 0;
  let writeChain = Promise.resolve();

  function currentTime() {
    const value = Number(now());
    if (!validTime(value)) throw new TypeError('now must return a non-negative safe integer');
    return value;
  }

  function requireLoaded() {
    return loaded && record ? null : { ok: false, reason: 'store_not_loaded' };
  }

  function withoutRevoked(candidate) {
    const snapshot = cloneRecord(candidate);
    snapshot.devices = snapshot.devices.filter((device) => !revoked.has(device.device_id));
    return snapshot;
  }

  function withWriteLock(operation) {
    const result = writeChain.then(operation, operation);
    writeChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async function persist(candidate) {
    try {
      await secureStore.setRemoteControlRecord(withoutRevoked(candidate));
      return { ok: true };
    } catch (_error) {
      return { ok: false, reason: 'secure_store_error' };
    }
  }

  function load() {
    loaded = false;
    record = null;
    generation += 1;
    return withWriteLock(async () => {
      let exists;
      let stored;
      try {
        exists = await secureStore.hasRemoteControlRecord();
        stored = exists ? await secureStore.getRemoteControlRecord() : null;
      } catch (_error) {
        return { ok: false, reason: 'secure_store_error' };
      }
      if (exists && !stored) return { ok: false, reason: 'record_malformed' };
      if (stored) {
        const validation = validateRecord(stored, limits.MAX_DEVICES);
        if (!validation.ok) return validation;
        record = withoutRevoked(stored);
        loaded = true;
        return { ok: true, created: false };
      }

      const fresh = {
        record_version: RECORD_VERSION,
        desktop_id: remoteCrypto.randomId(),
        desktop_secret: remoteCrypto.toBase64Url(remoteCrypto.randomSecret()),
        devices: [],
        shared_sessions: [],
        relay_url: '',
      };
      const saved = await persist(fresh);
      if (!saved.ok) return saved;
      record = fresh;
      loaded = true;
      return { ok: true, created: true };
    });
  }

  function save() {
    return withWriteLock(async () => {
      const blocked = requireLoaded();
      if (blocked) return blocked;
      return persist(record);
    });
  }

  function getRecord() {
    return projectRecord(loaded ? record : null);
  }

  function mutateWithRollback(mutator) {
    return withWriteLock(async () => {
      const blocked = requireLoaded();
      if (blocked) return blocked;
      const operationGeneration = generation;
      const previous = withoutRevoked(record);
      const result = mutator(record);
      if (result && result.ok === false) return result;
      const saved = await persist(record);
      if (!saved.ok) {
        if (loaded && record && generation === operationGeneration) record = previous;
        else if (record) record = withoutRevoked(record);
        return saved;
      }
      if (record) record = withoutRevoked(record);
      return { ok: true };
    });
  }

  async function setRelayUrl(url) {
    const blocked = requireLoaded();
    if (blocked) return blocked;
    const normalized = normalizeRelayUrl(url);
    if (!normalized) return { ok: false, reason: 'relay_url_invalid' };
    return mutateWithRollback((candidate) => {
      candidate.relay_url = normalized;
      return null;
    });
  }

  async function addDevice(device) {
    const blocked = requireLoaded();
    if (blocked) return blocked;
    if (!isPlainObject(device) || !validId(device.device_id)
      || !(device.device_secret instanceof Uint8Array) || device.device_secret.byteLength !== 32
      || !validLabel(device.label) || !validTime(device.paired_at)) {
      return { ok: false, reason: 'device_malformed' };
    }
    return mutateWithRollback((candidate) => {
      if (revoked.has(device.device_id)) return { ok: false, reason: 'device_revoked' };
      if (candidate.devices.length >= limits.MAX_DEVICES) {
        return { ok: false, reason: 'device_limit' };
      }
      if (candidate.devices.some((item) => item.device_id === device.device_id)) {
        return { ok: false, reason: 'device_exists' };
      }
      candidate.devices.push({
        device_id: device.device_id,
        label: device.label,
        device_secret: remoteCrypto.toBase64Url(device.device_secret),
        paired_at: device.paired_at,
        last_seen_at: device.paired_at,
        revision: 1,
      });
      return null;
    });
  }

  function revokeDevice(deviceId) {
    const blocked = requireLoaded();
    if (blocked) return Promise.resolve(blocked);
    const index = record.devices.findIndex((device) => device.device_id === deviceId);
    if (index < 0) return Promise.resolve({ ok: false, reason: 'device_not_found' });
    revoked.add(deviceId);
    record.devices.splice(index, 1);
    generation += 1;
    return withWriteLock(async () => {
      if (!loaded || !record) return { ok: false, reason: 'revocation_not_saved' };
      const saved = await persist(record);
      return saved.ok ? saved : { ok: false, reason: 'revocation_not_saved' };
    });
  }

  async function touchDevice(deviceId) {
    return mutateWithRollback((candidate) => {
      const device = candidate.devices.find((item) => item.device_id === deviceId);
      if (!device) return { ok: false, reason: 'device_not_found' };
      device.last_seen_at = Math.max(device.paired_at, currentTime());
      return null;
    });
  }

  async function shareSession(sessionId) {
    if (!validSessionId(sessionId)) {
      return { ok: false, reason: 'session_id_invalid' };
    }
    return mutateWithRollback((candidate) => {
      if (candidate.shared_sessions.includes(sessionId)) return null;
      if (candidate.shared_sessions.length >= MAX_SHARED_SESSIONS) {
        return { ok: false, reason: 'shared_sessions_limit' };
      }
      candidate.shared_sessions.push(sessionId);
      return null;
    });
  }

  async function unshareSession(sessionId) {
    if (!validSessionId(sessionId)) {
      return { ok: false, reason: 'session_id_invalid' };
    }
    return mutateWithRollback((candidate) => {
      candidate.shared_sessions = candidate.shared_sessions.filter((item) => item !== sessionId);
      return null;
    });
  }

  function forgetAll() {
    for (const device of record?.devices || []) revoked.add(device.device_id);
    record = null;
    loaded = false;
    generation += 1;
    return withWriteLock(async () => {
      try {
        await secureStore.deleteRemoteControlRecord();
        return { ok: true };
      } catch (_error) {
        // Slice 4 admission must remain denied after this result; the durable
        // record still exists even though this store instance stays unloaded.
        return { ok: false, reason: 'forget_not_deleted' };
      }
    });
  }

  function isDeviceTrusted(deviceId) {
    return Boolean(!revoked.has(deviceId)
      && loaded && record?.devices.some((device) => device.device_id === deviceId));
  }

  function deviceSecret(deviceId) {
    if (revoked.has(deviceId) || !loaded || !record) return null;
    const device = record.devices.find((item) => item.device_id === deviceId);
    return device ? remoteCrypto.fromBase64Url(device.device_secret) : null;
  }

  function desktopSecret() {
    return loaded && record ? remoteCrypto.fromBase64Url(record.desktop_secret) : null;
  }

  return Object.freeze({
    load,
    save,
    getRecord,
    setRelayUrl,
    addDevice,
    revokeDevice,
    touchDevice,
    shareSession,
    unshareSession,
    forgetAll,
    isDeviceTrusted,
    deviceSecret,
    desktopSecret,
  });
}

module.exports = { createDeviceStore };
