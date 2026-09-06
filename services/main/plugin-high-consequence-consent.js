'use strict';

const crypto = require('node:crypto');

const MAX_OUTSTANDING_RECEIPTS = 64;

function fingerprint(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

class PluginHighConsequenceConsent {
  constructor({ openPrompt, now = Date.now, timeoutMs = 120_000 } = {}) {
    this._open = openPrompt;
    this._now = now;
    this._timeout = timeoutMs;
    this._pending = null;
    this._receipts = new Map();
  }

  _pruneExpiredReceipts() {
    const now = this._now();
    for (const [receiptId, receipt] of this._receipts) {
      if (now >= receipt.expiresAt) this._receipts.delete(receiptId);
    }
  }

  async request({ operation, authority, contribution, artifact, session = null }) {
    this._pruneExpiredReceipts();
    if (this._pending) return { ok: false, reason: 'consent_busy' };
    if (this._receipts.size >= MAX_OUTSTANDING_RECEIPTS) {
      return { ok: false, reason: 'consent_busy' };
    }
    const canonical = { operation, authority, contribution, artifact, session };
    const requestFingerprint = fingerprint(canonical);
    const expiresAt = this._now() + this._timeout;
    const pending = { requestFingerprint, expiresAt };
    this._pending = pending;
    try {
      const decision = await this._open({
        title: operation === 'secret_value_delivery' ? 'Share a secret value?' : `Allow ${contribution.display_name} to run with your account permissions?`,
        operation, publisher: contribution.publisher_id, packageVersion: artifact.version,
        contribution: contribution.contribution_id, executableDigest: artifact.executable_digest,
        containment: contribution.containment_label, limits: contribution.limit_label,
      });
      if (this._pending !== pending || this._now() >= expiresAt || decision?.approved !== true
        || decision?.acknowledged !== true) return { ok: false, reason: 'consent_denied' };
      this._pruneExpiredReceipts();
      if (this._receipts.size >= MAX_OUTSTANDING_RECEIPTS) {
        return { ok: false, reason: 'consent_busy' };
      }
      const receiptId = crypto.randomBytes(16).toString('hex');
      this._receipts.set(receiptId, { requestFingerprint, expiresAt });
      return { ok: true, receipt_id: receiptId, request_fingerprint: requestFingerprint };
    } finally {
      if (this._pending === pending) this._pending = null;
    }
  }

  consume(receiptId, canonicalRequest) {
    this._pruneExpiredReceipts();
    const receipt = this._receipts.get(receiptId);
    if (!receipt || this._now() >= receipt.expiresAt
      || receipt.requestFingerprint !== fingerprint(canonicalRequest)) {
      return { ok: false, reason: 'consent_receipt_invalid' };
    }
    this._receipts.delete(receiptId);
    return { ok: true };
  }

  cancel() { this._pending = null; this._receipts.clear(); }
}

module.exports = { fingerprint, PluginHighConsequenceConsent };
