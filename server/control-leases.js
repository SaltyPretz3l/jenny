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

  // `memberId` (slice 3-7): the member who drives, on a team host only. Without it the
  // record has no member_id key at all, as on the single-owner host.
  acquire(sessionId, clientId, deviceId, takeover = false, memberId = undefined) {
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
      ...(memberId !== undefined ? { member_id: memberId } : {}),
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

  // Slice 3-7: drop the member's leases on the conversations `inScope(sessionId)` names. It
  // filters by member first, so the caller's lookup runs only for that member's leases; a
  // lookup that throws drops the lease (the holder takes it again if still allowed). Silent,
  // like revokeDevice. Answers how many were dropped.
  revokeMember(memberId, inScope) {
    if (typeof memberId !== 'string' || !memberId || typeof inScope !== 'function') return 0;
    const held = [];
    for (const [sessionId, lease] of this.leases) if (lease.member_id === memberId) held.push(sessionId);
    let dropped = 0;
    for (const sessionId of held) {
      let drop;
      try { drop = inScope(sessionId) === true; } catch (_error) { drop = true; }
      if (drop && this.leases.delete(sessionId)) dropped += 1;
    }
    return dropped;
  }
}

// The team host's callback for a project member change (slice 3-7): for each member the
// event names, drop their leases in that project's conversations. `sessionProject` is the
// host's conversation-to-project lookup (null for General or an unknown conversation).
function projectLeaseRevoker({ leases, sessionProject }) {
  return function revokeProjectLeases(projectId, memberIds) {
    if (typeof projectId !== 'string' || !projectId || !Array.isArray(memberIds)) return;
    for (const memberId of memberIds) leases.revokeMember(memberId, (sessionId) => sessionProject(sessionId) === projectId);
  };
}

module.exports = { ControlLeases, projectLeaseRevoker };
