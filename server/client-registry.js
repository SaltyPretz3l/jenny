'use strict';

const { randomBytes, timingSafeEqual } = require('node:crypto');
const { requireBoundedInteger } = require('./resource-limits');

// A client ID is public routing metadata. The independently issued token is
// authority, bound to a login session and kept only in that tab's memory.
class ClientRegistry {
  constructor({ now = Date.now, capacity = 32, perDeviceCapacity = Math.min(8, capacity),
    ttlMs = 30 * 60_000, registrationGraceMs = Math.min(10_000, ttlMs) } = {}) {
    this.now = now;
    this.capacity = requireBoundedInteger(capacity, 32);
    this.perDeviceCapacity = requireBoundedInteger(perDeviceCapacity, this.capacity);
    this.ttlMs = requireBoundedInteger(ttlMs, 30 * 60_000);
    this.registrationGraceMs = requireBoundedInteger(registrationGraceMs, this.ttlMs);
    this.clients = new Map();
  }

  _prune(now) {
    for (const [id, entry] of this.clients) {
      if (entry.expiresAt <= now) this.clients.delete(id);
    }
  }

  _oldestDetached(now, deviceId = null) {
    let oldest = null;
    for (const [id, entry] of this.clients) {
      if ((deviceId !== null && entry.deviceId !== deviceId) || entry.connections.size > 0) continue;
      if (!entry.reclaimable && now - entry.lastUsedAt < this.registrationGraceMs) continue;
      if (!oldest || entry.lastUsedAt < oldest.entry.lastUsedAt) oldest = { id, entry };
    }
    return oldest?.id || null;
  }

  _reclaimDetached(now, deviceId = null) {
    const candidate = this._oldestDetached(now, deviceId);
    if (!candidate) return false;
    this.clients.delete(candidate);
    return true;
  }

  register(deviceId) {
    const now = this.now();
    this._prune(now);
    if (!deviceId) return null;
    const deviceClients = [...this.clients.values()].filter((entry) => entry.deviceId === deviceId).length;
    if (deviceClients >= this.perDeviceCapacity && !this._reclaimDetached(now, deviceId)) return null;
    if (this.clients.size >= this.capacity && !this._reclaimDetached(now)) return null;
    const clientId = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('base64url');
    this.clients.set(clientId, {
      deviceId,
      token,
      expiresAt: now + this.ttlMs,
      lastUsedAt: now,
      connections: new Set(),
      reclaimable: false,
    });
    return { client_id: clientId, client_token: token };
  }

  authorize(clientId, token, deviceId) {
    const entry = this.clients.get(clientId);
    if (!entry || entry.expiresAt <= this.now() || entry.deviceId !== deviceId) return false;
    if (typeof token !== 'string' || token.length !== entry.token.length) return false;
    const actual = Buffer.from(token);
    const expected = Buffer.from(entry.token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    const now = this.now();
    entry.expiresAt = now + this.ttlMs;
    entry.lastUsedAt = now;
    return true;
  }

  attach(clientId, token, deviceId) {
    if (!this.authorize(clientId, token, deviceId)) return null;
    const entry = this.clients.get(clientId);
    const connection = Symbol('client-connection');
    entry.reclaimable = true;
    entry.connections.add(connection);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      if (this.clients.get(clientId) === entry) entry.connections.delete(connection);
    };
  }

  revokeDevice(deviceId) {
    for (const [id, entry] of this.clients) {
      if (entry.deviceId === deviceId) this.clients.delete(id);
    }
  }
}

module.exports = { ClientRegistry };
