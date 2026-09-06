'use strict';

class CleanupReconciler {
  constructor({ reconcileReceipt, persistReceipt, diagnostics } = {}) {
    this._reconcile = reconcileReceipt;
    this._persist = persistReceipt;
    this._diagnostics = diagnostics;
    this._status = 'not_required';
  }

  async reconcile(receipts = []) {
    const candidates = Array.isArray(receipts) ? receipts : [];
    this._status = candidates.length > 0 ? 'settling' : 'not_required';
    const outcomes = [];
    for (const receipt of candidates) {
      try {
        const result = await this._reconcile(receipt);
        if (result?.terminated === true && result?.tree_empty === true) await this._persist(receipt);
        else this._diagnostics?.record('WARN', 'termination_unproven', receipt);
        outcomes.push(result || { ok: false, reason: 'reconciliation_empty' });
      } catch (_error) {
        outcomes.push({ ok: false, reason: 'reconciliation_failed' });
      }
    }
    const pendingRestart = outcomes.some((item) => item?.cleanup_status === 'pending_restart');
    const terminationFailed = outcomes.some((item) => item?.ok === false
      || item?.terminated !== true || item?.tree_empty !== true);
    this._status = pendingRestart ? 'pending_restart'
      : (terminationFailed ? 'termination_failed' : (outcomes.length ? 'complete' : 'not_required'));
    return { ok: !terminationFailed, cleanup_status: this._status, outcomes };
  }

  state() { return { cleanup_status: this._status }; }
}

module.exports = { CleanupReconciler };
