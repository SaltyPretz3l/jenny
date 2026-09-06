'use strict';

const crypto = require('node:crypto');
const { validate } = require('../contracts/generated-plugin-contracts');

function sourceFingerprint(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 16); }

class SecretValueDelivery {
  constructor({ secureStore, grantStore, deliver, terminateSession, now = Date.now,
    ttlMs = 30_000, maximumBytes = 65_536,
    captureAuthority = () => null, guardAuthority = () => ({ ok: true }) } = {}) {
    this._store = secureStore;
    this._deliver = deliver;
    this._terminate = terminateSession;
    this._now = now;
    this._ttlMs = ttlMs;
    this._maximumBytes = maximumBytes;
    this._grants = grantStore;
    this._captureAuthority = captureAuthority;
    this._guardAuthority = guardAuthority;
  }

  async prepare(grant) {
    const token = this._captureAuthority();
    const gated = this._guardAuthority(token);
    if (!gated?.ok) return gated;
    const checked = validate('PluginSecretDeliveryGrantV6', grant);
    if (!checked.ok || checked.value.one_shot !== true || checked.value.spent !== false) {
      return { ok: false, reason: 'secret_grant_invalid' };
    }
    const value = checked.value;
    if (Date.parse(value.expires_at) - this._now() > this._ttlMs || Date.parse(value.expires_at) <= this._now()) {
      return { ok: false, reason: 'secret_grant_expiry_invalid' };
    }
    if (!this._grants || typeof this._grants.prepare !== 'function') {
      return { ok: false, reason: 'secret_grant_store_unavailable' };
    }
    const result = await this._grants.prepare(value);
    return this._guardAuthority(token)?.ok ? result
      : { ok: false, reason: 'managed_policy_authority_stale' };
  }

  async consumeAndDeliver({ grantId, binding }) {
    const token = this._captureAuthority();
    const gated = this._guardAuthority(token);
    if (!gated?.ok) return gated;
    if (!this._grants || typeof this._grants.spend !== 'function') {
      return { ok: false, reason: 'secret_grant_store_unavailable' };
    }
    // This durable compare-and-spend completes before safeStorage is opened.
    // A crash or lost response can therefore never disclose the same grant twice.
    const spent = await this._grants.spend(grantId, binding);
    if (!spent?.ok) return spent;
    if (!this._guardAuthority(token)?.ok) {
      return { ok: false, reason: 'managed_policy_authority_stale' };
    }
    const grant = spent.grant;
    const secret = await this._store.getPluginFullHostSecret(grant.source_id_digest);
    if (!this._guardAuthority(token)?.ok) {
      return { ok: false, reason: 'managed_policy_authority_stale' };
    }
    if (!secret || sourceFingerprint(secret) !== grant.source_fingerprint
      || Buffer.byteLength(secret, 'utf8') > this._maximumBytes) {
      return { ok: false, reason: 'secret_source_mismatch' };
    }
    try {
      const result = await this._deliver({ grant, secret });
      if (!this._guardAuthority(token)?.ok) {
        return { ok: false, reason: 'managed_policy_authority_stale' };
      }
      return result?.ok ? { ok: true, receipt_id: result.receipt_id }
        : { ok: false, reason: 'secret_delivery_failed' };
    } catch (_error) {
      await this._terminate?.(binding.session_id, 'secret_delivery_ambiguous');
      return { ok: false, reason: 'secret_delivery_ambiguous' };
    }
  }

  revokeSession(sessionId) {
    return this._grants?.revokeSession?.(sessionId)
      || Promise.resolve({ ok: false, reason: 'secret_grant_store_unavailable' });
  }

  revokeAll() {
    return this._grants?.revokeAll?.()
      || Promise.resolve({ ok: false, reason: 'secret_grant_store_unavailable' });
  }
}

module.exports = { sourceFingerprint, SecretValueDelivery };
