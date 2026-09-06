'use strict';

const crypto = require('node:crypto');

const MAX_TOKENS = 1024;
const MAX_LIFETIME_MS = 30000;
const MAX_USES = 32;
const REQUIRED_BINDINGS = Object.freeze([
  'publisher_id', 'plugin_id', 'contribution_id', 'artifact_digest', 'component_digest',
  'generation_id', 'commit_epoch', 'lifecycle_epoch', 'policy_revision', 'process_instance_id',
  'channel_id', 'workspace_incarnation_id', 'purpose', 'destination', 'invocation_id',
  'operation_id', 'cancellation_id', 'argument_hash', 'revocation_generation',
  'deadline_epoch_ms',
]);
const DIGEST_FIELDS = new Set(['artifact_digest', 'component_digest', 'argument_hash']);
const INTEGER_FIELDS = new Set([
  'commit_epoch', 'lifecycle_epoch', 'policy_revision', 'revocation_generation',
  'deadline_epoch_ms',
]);
const ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,191}$/;

function validAuthority(authority) {
  if (!authority || REQUIRED_BINDINGS.some((field) => authority[field] === undefined)) return false;
  return REQUIRED_BINDINGS.every((field) => {
    const value = authority[field];
    if (DIGEST_FIELDS.has(field)) return /^[0-9a-f]{64}$/.test(String(value));
    if (INTEGER_FIELDS.has(field)) return Number.isSafeInteger(value) && value >= 0;
    if (field === 'destination') {
      if (value === '') return true;
      try {
        const url = new URL(String(value));
        return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
      } catch (_error) { return false; }
    }
    return typeof value === 'string' && ID_PATTERN.test(value);
  });
}

function sameBinding(token, authority) {
  for (const field of REQUIRED_BINDINGS) if (token[field] !== authority[field]) return field;
  return null;
}

class RestrictedTokenService {
  constructor({ now = () => performance.now(), randomBytes = crypto.randomBytes } = {}) {
    this._now = now;
    this._randomBytes = randomBytes;
    this._tokens = new Map();
    this._evictionCount = 0;
  }

  mint(authority, { lifetimeMs = MAX_LIFETIME_MS, uses = MAX_USES } = {}) {
    if (!validAuthority(authority)
      || !Number.isInteger(uses) || uses < 1 || uses > MAX_USES
      || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > MAX_LIFETIME_MS) {
      return { ok: false, reason: 'token_mint_authority_invalid' };
    }
    if (this._tokens.size >= MAX_TOKENS) {
      return { ok: false, reason: 'token_ledger_saturated' };
    }
    let tokenId = this._randomBytes(32).toString('hex');
    if (!/^[0-9a-f]{64}$/.test(tokenId) || this._tokens.has(tokenId)) {
      return { ok: false, reason: 'token_nonce_invalid' };
    }
    const token = Object.freeze({ ...authority, token_id: tokenId, nonce: this._randomBytes(32).toString('hex'),
      expires_at_monotonic_ms: this._now() + lifetimeMs, uses_remaining: uses });
    this._tokens.set(tokenId, token);
    return { ok: true, token_id: tokenId, expires_at_monotonic_ms: token.expires_at_monotonic_ms };
  }

  consume(tokenId, authority) {
    if (!/^[0-9a-f]{64}$/.test(String(tokenId || '')) || !validAuthority(authority)) {
      return { ok: false, reason: 'token_shape_invalid' };
    }
    const token = this._tokens.get(tokenId);
    if (!token) return { ok: false, reason: 'token_unknown_or_replayed' };
    const mismatch = sameBinding(token, authority);
    if (mismatch) return { ok: false, reason: `${mismatch}_mismatch` };
    if (this._now() >= token.expires_at_monotonic_ms) {
      this._tokens.delete(tokenId);
      return { ok: false, reason: 'token_expired' };
    }
    if (token.uses_remaining <= 0) {
      this._tokens.delete(tokenId);
      return { ok: false, reason: 'token_use_budget_exhausted' };
    }
    const usesRemaining = token.uses_remaining - 1;
    if (usesRemaining === 0) this._tokens.delete(tokenId);
    else this._tokens.set(tokenId, Object.freeze({ ...token, uses_remaining: usesRemaining }));
    return { ok: true, uses_remaining: usesRemaining };
  }

  revokeWhere(predicate) {
    let revoked = 0;
    for (const [tokenId, token] of this._tokens) {
      if (predicate(token)) { this._tokens.delete(tokenId); revoked += 1; }
    }
    return revoked;
  }

  revokeInvocation(invocationId) { return this.revokeWhere((token) => token.invocation_id === invocationId); }
  revokeGeneration(generationId) { return this.revokeWhere((token) => token.generation_id === generationId); }
  clear() { const count = this._tokens.size; this._tokens.clear(); return count; }
  snapshot() { return { active_tokens: this._tokens.size, eviction_count: this._evictionCount }; }
}

module.exports = {
  MAX_TOKENS, MAX_LIFETIME_MS, MAX_USES, REQUIRED_BINDINGS,
  validAuthority, RestrictedTokenService,
};
