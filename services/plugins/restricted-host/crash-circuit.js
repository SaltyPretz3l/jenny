'use strict';

const RESTART_DELAYS_MS = Object.freeze([100, 500, 2000]);
const CRASH_WINDOW_MS = 10 * 60 * 1000;

class CrashCircuit {
  constructor({ now = () => Date.now() } = {}) { this._now = now; this._crashes = new Map(); }
  _key(identity) { return [identity.contribution_id, identity.artifact_digest, identity.component_digest, identity.commit_epoch].join('\0'); }
  _sweep(now) {
    for (const [key, history] of this._crashes) {
      const crashes = history.filter((at) => now - at <= CRASH_WINDOW_MS);
      if (crashes.length) this._crashes.set(key, crashes); else this._crashes.delete(key);
    }
  }
  record(identity, { expected = false } = {}) {
    const now = this._now(); this._sweep(now);
    if (expected) return { open: false, restart_delay_ms: null, crash_count: 0 };
    const key = this._key(identity);
    const crashes = this._crashes.get(key) || [];
    crashes.push(now); this._crashes.set(key, crashes);
    const open = crashes.length >= 3;
    return { open, crash_count: crashes.length,
      restart_delay_ms: open ? null : RESTART_DELAYS_MS[Math.min(crashes.length - 1, RESTART_DELAYS_MS.length - 1)] };
  }
  isOpen(identity) {
    const key = this._key(identity); const now = this._now();
    this._sweep(now);
    const crashes = this._crashes.get(key) || [];
    return crashes.length >= 3;
  }
  reset(identity) { this._crashes.delete(this._key(identity)); }
}

module.exports = { RESTART_DELAYS_MS, CRASH_WINDOW_MS, CrashCircuit };
