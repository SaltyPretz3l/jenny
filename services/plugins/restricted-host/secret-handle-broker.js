'use strict';

const crypto = require('node:crypto');

const MAX_HANDLES = 128;
const MAX_HANDLE_LIFETIME_MS = 5 * 1000;
const MAX_HANDLE_USES = 32;
const AUTHORITY_FIELDS = Object.freeze([
  'publisher_id', 'plugin_id', 'contribution_id', 'artifact_digest',
  'component_digest', 'generation_id', 'commit_epoch', 'lifecycle_epoch',
]);
const DIGEST_FIELDS = new Set(['artifact_digest', 'component_digest']);
const INTEGER_FIELDS = new Set(['commit_epoch', 'lifecycle_epoch']);
const ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,191}$/;

function validAuthority(authority) {
  return Boolean(authority) && AUTHORITY_FIELDS.every((field) => {
    const value = authority[field];
    if (DIGEST_FIELDS.has(field)) return /^[0-9a-f]{64}$/.test(String(value || ''));
    if (INTEGER_FIELDS.has(field)) return Number.isSafeInteger(value) && value >= 0;
    return typeof value === 'string' && ID_PATTERN.test(value);
  });
}

function sameAuthority(left, right) {
  return AUTHORITY_FIELDS.every((field) => left?.[field] === right?.[field]);
}

class SecretHandleBroker {
  constructor({ now = () => performance.now(), randomBytes = crypto.randomBytes } = {}) {
    this._now = now;
    this._randomBytes = randomBytes;
    this._handles = new Map();
  }

  issue(authority, execute, { lifetimeMs = MAX_HANDLE_LIFETIME_MS, uses = 1 } = {}) {
    const now = this._now();
    for (const [handle, record] of this._handles) {
      if (now >= record.expires_at_monotonic_ms) this._handles.delete(handle);
    }
    if (!validAuthority(authority) || typeof execute !== 'function' || this._handles.size >= MAX_HANDLES
      || !Number.isInteger(uses) || uses < 1 || uses > MAX_HANDLE_USES
      || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > MAX_HANDLE_LIFETIME_MS) {
      return { ok: false, reason: 'secret_handle_issue_rejected' };
    }
    const handle = `secret_${this._randomBytes(24).toString('hex')}`;
    if (!/^secret_[0-9a-f]{48}$/.test(handle) || this._handles.has(handle)) {
      return { ok: false, reason: 'secret_handle_nonce_rejected' };
    }
    this._handles.set(handle, Object.freeze({
      authority: Object.freeze(Object.fromEntries(
        AUTHORITY_FIELDS.map((field) => [field, authority[field]])
      )),
      execute,
      expires_at_monotonic_ms: now + lifetimeMs,
      uses_remaining: uses,
    }));
    return { ok: true, handle };
  }

  async use(handle, requestDigest, authority) {
    if (!/^secret_[0-9a-f]{48}$/.test(String(handle || ''))
      || !/^[0-9a-f]{64}$/.test(String(requestDigest || ''))) {
      return { ok: false, reason: 'secret_handle_request_invalid' };
    }
    const record = this._handles.get(handle);
    if (!record || !sameAuthority(record.authority, authority)) {
      return { ok: false, reason: 'secret_handle_unknown_or_stale' };
    }
    if (this._now() >= record.expires_at_monotonic_ms) {
      this._handles.delete(handle);
      return { ok: false, reason: 'secret_handle_expired' };
    }
    const usesRemaining = record.uses_remaining - 1;
    if (usesRemaining === 0) this._handles.delete(handle);
    else this._handles.set(handle, Object.freeze({ ...record, uses_remaining: usesRemaining }));
    let settled;
    try { settled = await record.execute({ request_digest: requestDigest, authority }); }
    catch (_error) { settled = { ok: false, reason: 'secret_handle_operation_failed' }; }
    if (!settled?.ok) return { ok: false, reason: settled?.reason || 'secret_handle_operation_failed' };
    return { ok: true, used: true };
  }

  revokeGeneration(generationId) {
    let revoked = 0;
    for (const [handle, record] of this._handles) {
      if (record.authority.generation_id === generationId) {
        this._handles.delete(handle);
        revoked += 1;
      }
    }
    return revoked;
  }

  clear() { const count = this._handles.size; this._handles.clear(); return count; }
  snapshot() { return { active_handles: this._handles.size }; }
}

module.exports = {
  MAX_HANDLES, MAX_HANDLE_LIFETIME_MS, MAX_HANDLE_USES, AUTHORITY_FIELDS,
  validAuthority, sameAuthority, SecretHandleBroker,
};
