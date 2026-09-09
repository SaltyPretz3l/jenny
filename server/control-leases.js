'use strict';

const { requireBoundedInteger } = require('./resource-limits');

class ControlLeases {
  constructor({ now = Date.now, ttlMs = 60_000, capacity = 1000 } = {}) {
    this.now = now;
    this.ttlMs = requireBoundedInteger(ttlMs, 60_000);
    this.capacity = requireBoundedInteger(capacity, 1000);
    this.generation = 0;
    this.leases = new Map();
  }

  get(sessionId) {
    const lease = this.leases.get(sessionId);
    if (!lease) return null;
    if (lease.expires_at <= this.now()) {
      this.leases.delete(sessionId);
      return null;
    }
    return { ...lease };
  }

  acquire(sessionId, clientId, deviceId, takeover = false) {
    for (const key of this.leases.keys()) this.get(key);
    const current = this.get(sessionId);
    if (current?.client_id === clientId && current.device_id === deviceId) {
      return this.heartbeat(sessionId, clientId, deviceId, current.generation);
    }
    if (current && !takeover) return null;
    if (!current && this.leases.size >= this.capacity) return null;
    if (this.generation >= Number.MAX_SAFE_INTEGER) return null;
    const lease = {
      client_id: clientId, device_id: deviceId,
      generation: ++this.generation, expires_at: this.now() + this.ttlMs,
    };
    this.leases.set(sessionId, lease);
    return { ...lease };
  }

  owns(sessionId, clientId, deviceId, generation) {
    const lease = this.get(sessionId);
    return Boolean(lease && lease.client_id === clientId && lease.device_id === deviceId
      && lease.generation === generation);
  }

  heartbeat(sessionId, clientId, deviceId, generation) {
    if (!this.owns(sessionId, clientId, deviceId, generation)) return null;
    this.leases.get(sessionId).expires_at = this.now() + this.ttlMs;
    return this.get(sessionId);
  }

  release(sessionId, clientId, deviceId, generation) {
    if (!this.owns(sessionId, clientId, deviceId, generation)) return false;
    this.leases.delete(sessionId);
    return true;
  }

  revokeDevice(deviceId) {
    for (const [sessionId, lease] of this.leases) {
      if (lease.device_id === deviceId) this.leases.delete(sessionId);
    }
  }
}

module.exports = { ControlLeases };
