'use strict';

const defaultLimits = require('./remote-limits');

function createPairingService({ now, limits = defaultLimits, deviceStore, crypto } = {}) {
  if (typeof now !== 'function' || !deviceStore || typeof deviceStore.addDevice !== 'function'
    || typeof deviceStore.revokeDevice !== 'function'
    || !crypto || typeof crypto.randomId !== 'function'
    || typeof crypto.randomSecret !== 'function'
    || typeof crypto.toBase64Url !== 'function'
    || typeof crypto.verifyHandshake !== 'function'
    || !Number.isFinite(limits.PAIRING_WINDOW_MS) || limits.PAIRING_WINDOW_MS <= 0
    || !Number.isInteger(limits.PAIRING_FAILURES_MAX) || limits.PAIRING_FAILURES_MAX <= 0) {
    throw new TypeError('invalid pairing service configuration');
  }

  let windowState = null;
  let generation = 0;

  function currentTime() {
    const value = Number(now());
    if (!Number.isFinite(value)) throw new TypeError('now must return a finite number');
    return value;
  }

  function burnWindow() {
    if (windowState?.secret) windowState.secret.fill(0);
    windowState = null;
    generation += 1;
  }

  function expireIfNeeded() {
    if (windowState && currentTime() >= windowState.expiresAt) burnWindow();
  }

  function close() {
    burnWindow();
  }

  function openWindow({ epoch, routeId, portalOrigin } = {}) {
    if (typeof epoch !== 'string' || !epoch
      || typeof routeId !== 'string' || !routeId
      || typeof portalOrigin !== 'string' || !portalOrigin) {
      throw new TypeError('invalid pairing window arguments');
    }
    burnWindow();
    const pairingId = crypto.randomId();
    const secret = crypto.randomSecret();
    const expiresAt = currentTime() + limits.PAIRING_WINDOW_MS;
    const origin = portalOrigin.replace(/\/+$/g, '');
    windowState = {
      pairingId,
      epoch,
      secret,
      expiresAt,
      failures: 0,
      consuming: false,
    };
    return {
      pairing_id: pairingId,
      expires_at: expiresAt,
      url: `${origin}/#p=${pairingId}.${crypto.toBase64Url(secret)}.${routeId}`,
      secret,
    };
  }

  function status() {
    expireIfNeeded();
    if (!windowState) {
      return { open: false, pairing_id: null, expires_at: null, failures: 0, epoch: null };
    }
    return {
      open: true,
      pairing_id: windowState.pairingId,
      expires_at: windowState.expiresAt,
      failures: windowState.failures,
      epoch: windowState.epoch,
    };
  }

  function failuresRemaining() {
    expireIfNeeded();
    return windowState
      ? Math.max(0, limits.PAIRING_FAILURES_MAX - windowState.failures)
      : 0;
  }

  function boundedLabel(value) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return Array.from(normalized || 'Phone').slice(0, 64).join('');
  }

  function zeroDeviceSecret(device) {
    if (device?.device_secret instanceof Uint8Array) device.device_secret.fill(0);
  }

  async function consume({ pairingId, proof, transcriptHash, label } = {}) {
    expireIfNeeded();
    const active = windowState;
    if (!active || active.consuming || pairingId !== active.pairingId) {
      return { ok: false, reason: 'pairing_invalid' };
    }
    active.consuming = true;
    let verified;
    try {
      verified = await crypto.verifyHandshake(active.secret, transcriptHash, proof);
    } catch (_error) {
      verified = false;
    }
    if (windowState !== active || currentTime() >= active.expiresAt) {
      if (windowState === active) burnWindow();
      return { ok: false, reason: 'pairing_invalid' };
    }
    if (!verified) {
      active.consuming = false;
      active.failures += 1;
      if (active.failures >= limits.PAIRING_FAILURES_MAX) {
        burnWindow();
        return { ok: false, reason: 'pairing_locked' };
      }
      return { ok: false, reason: 'pairing_invalid' };
    }

    burnWindow();
    const addGeneration = generation;
    const device = {
      device_id: crypto.randomId(),
      device_secret: crypto.randomSecret(),
      label: boundedLabel(label),
      paired_at: currentTime(),
    };
    let result;
    try {
      result = await deviceStore.addDevice(device);
    } catch (error) {
      zeroDeviceSecret(device);
      if (generation !== addGeneration) return { ok: false, reason: 'pairing_cancelled' };
      const reason = error?.reason || error?.code;
      return { ok: false, reason: reason === 'device_limit' ? reason : 'device_store_failed' };
    }
    if (generation !== addGeneration) {
      if (result?.ok === true) {
        try {
          await deviceStore.revokeDevice(device.device_id);
        } catch (_error) {
          // Best effort: the caller receives no credential material.
        }
      }
      zeroDeviceSecret(device);
      return { ok: false, reason: 'pairing_cancelled' };
    }
    if (!result || result.ok !== true) {
      zeroDeviceSecret(device);
      return { ok: false, reason: result?.reason || 'device_store_failed' };
    }
    return { ok: true, device };
  }

  return Object.freeze({ openWindow, status, consume, close, failuresRemaining });
}

module.exports = { createPairingService };
