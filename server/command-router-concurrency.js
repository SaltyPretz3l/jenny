'use strict';

const { requireBoundedInteger } = require('./resource-limits');

class SessionMutationQueue {
  constructor({ capacity = 10_000 } = {}) {
    this.capacity = requireBoundedInteger(capacity, 10_000);
    this.tails = new Map();
  }

  async run(sessionId, execute) {
    const previous = this.tails.get(sessionId);
    if (!previous && this.tails.size >= this.capacity) throw new Error('mutation_capacity');
    let release;
    const tail = new Promise((resolve) => { release = resolve; });
    this.tails.set(sessionId, tail);
    if (previous) await previous;
    try { return await execute(); }
    finally {
      release();
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    }
  }
}

class CancellationRegistry {
  constructor({ now = Date.now, capacity = 256, ttlMs = 120_000 } = {}) {
    this.now = now;
    this.capacity = requireBoundedInteger(capacity, 10_000);
    this.ttlMs = requireBoundedInteger(ttlMs, 86_400_000);
    this.entries = new Map();
  }

  _key(sessionId, streamId) { return `${sessionId}:${streamId}`; }

  _trim(makeRoom = false) {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    const limit = makeRoom ? this.capacity - 1 : this.capacity;
    while (this.entries.size > limit) this.entries.delete(this.entries.keys().next().value);
  }

  remember(command, deviceId) {
    const key = this._key(command.session_id, command.params.stream_id);
    this.entries.delete(key);
    this._trim(true);
    const entry = {
      sessionId: command.session_id,
      streamId: command.params.stream_id,
      clientId: command.client_id,
      deviceId,
      controlGeneration: command.control_generation,
      terminal: false,
      expiresAt: this.now() + this.ttlMs,
    };
    this.entries.set(key, entry);
    return entry;
  }

  find(command, deviceId) {
    this._trim();
    const entry = this.entries.get(this._key(command.session_id, command.params.stream_id));
    return entry && entry.clientId === command.client_id && entry.deviceId === deviceId
      && entry.controlGeneration === command.control_generation ? entry : null;
  }

  markTerminal(sessionId, streamId) {
    const entry = this.entries.get(this._key(sessionId, streamId));
    if (entry) entry.terminal = true;
  }

  forget(entry) {
    const key = this._key(entry.sessionId, entry.streamId);
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }

  clear() { this.entries.clear(); }
}

module.exports = { CancellationRegistry, SessionMutationQueue };
