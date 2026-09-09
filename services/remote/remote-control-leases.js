'use strict';

function createControlLeases({ now, randomId } = {}) {
  if (typeof now !== 'function' || typeof randomId !== 'function') {
    throw new TypeError('Remote control leases require clock and id functions.');
  }
  const leases = new Map();

  function request(sessionId, deviceId) {
    const existing = leases.get(sessionId);
    if (existing) {
      if (existing.device_id === deviceId) return { ok: true, lease: { ...existing } };
      return { ok: false, reason: 'held', holder: existing.device_id };
    }
    const lease = {
      lease_id: randomId(),
      session_id: sessionId,
      device_id: deviceId,
      granted_at: Number(now()),
    };
    leases.set(sessionId, lease);
    return { ok: true, lease: { ...lease } };
  }

  function release(sessionId, deviceId) {
    const existing = leases.get(sessionId);
    if (!existing || existing.device_id !== deviceId) return false;
    leases.delete(sessionId);
    return true;
  }

  function leaseFor(sessionId, deviceId) {
    const lease = leases.get(sessionId);
    return lease?.device_id === deviceId ? { ...lease } : null;
  }

  function controllerOf(sessionId) {
    return leases.get(sessionId)?.device_id || null;
  }

  const holderOf = controllerOf;

  function revokeSession(sessionId) {
    return leases.delete(sessionId);
  }

  function revokeDevice(deviceId) {
    let revoked = 0;
    for (const [sessionId, lease] of leases) {
      if (lease.device_id !== deviceId) continue;
      leases.delete(sessionId);
      revoked += 1;
    }
    return revoked;
  }

  function revokeAll() {
    const count = leases.size;
    leases.clear();
    return count;
  }

  function list() {
    return [...leases.values()].map((lease) => ({ ...lease }));
  }

  return Object.freeze({
    request,
    release,
    leaseFor,
    controllerOf,
    holderOf,
    revokeSession,
    revokeDevice,
    revokeAll,
    list,
  });
}

module.exports = { createControlLeases };
