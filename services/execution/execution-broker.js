'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { workerError, UUID, validateCommand } = require('./worker-protocol');
const { HOST_ERROR_CODES } = require('../backend/error-codes');

// Application-owned admission and reconciliation. Never executes commands or
// accesses the Docker daemon. Only the separate worker may launch a job.
class ExecutionBroker {
  constructor({ userDataPath, request, readReceiptImpl,
    writeReceiptImpl, wait = delay, now = Date.now, cleanupTimeoutMs = 45_000,
    logger = () => {} }) {
    this.filePath = path.join(userDataPath, 'sandbox-admission.json');
    this.request = request;
    this.writeReceipt = writeReceiptImpl;
    this.wait = wait;
    this.now = now;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.logger = logger;
    this.receipt = readReceiptImpl(this.filePath);
    this.active = null;
    this.ready = false;
    this.closing = false;
    this.blocked = Boolean(this.receipt.pending);
  }
  _log(event, fields = {}) {
    try { this.logger('INFO', event, fields); } catch { /* no authority in logs */ }
  }
  _persist(pending) {
    // On an uncertain write keep the conservative pending state in memory.
    if (pending) this.receipt = { schema_version: 1, pending };
    this.writeReceipt(this.filePath, { schema_version: 1, pending });
    this.receipt = { schema_version: 1, pending };
  }
  async _statusUntil(predicate, timeoutMs = this.cleanupTimeoutMs, signal = null) {
    const deadline = this.now() + timeoutMs;
    do {
      if (signal?.aborted) throw workerError('sandbox_cancelled_before_admission');
      let status;
      try { status = await this.request('status'); }
      catch (error) {
        if (['worker_authentication_failed', 'worker_response_invalid', 'worker_status_invalid',
          'worker_result_invalid', 'worker_control_permissions_invalid', 'worker_key_invalid'].includes(error.reason)) throw error;
      }
      if (status) {
        const result = predicate(status);
        if (result) return result;
      }
      if (this.now() >= deadline) break;
      await this.wait(250);
    } while (this.now() <= deadline);
    throw workerError('sandbox_cleanup_unconfirmed');
  }
  async _cancel(pending) {
    try { await this.request('cancel', pending); }
    catch (error) {
      // A recycled incarnation rejects stale cancellation. Reconciliation,
      // never that rejection alone, proves the old namespace is gone.
      this._log('host.sandbox_cancel_reconcile', { reason: error.reason || 'worker_transport_unavailable' });
    }
  }
  async _settled(pending, timeoutMs = this.cleanupTimeoutMs) {
    return this._statusUntil((status) => {
      if (status.incarnation === pending.incarnation || status.phase !== 'ready' || status.job_id !== null) return null;
      const result = status.previous_result;
      if (!result || result.job_id !== pending.job_id || result.incarnation !== pending.incarnation) {
        throw workerError('sandbox_receipt_mismatch');
      }
      return result;
    }, timeoutMs);
  }
  async prepare() {
    if (this.closing) throw workerError('sandbox_closed');
    this.ready = false;
    const pending = this.receipt.pending;
    if (pending) {
      await this._cancel(pending);
      await this._settled(pending);
      this._persist(null);
      this._log('host.sandbox_recovered', { job_id: pending.job_id });
    }
    await this._statusUntil((status) => status.phase === 'ready' && status.job_id === null ? status : null);
    this.blocked = false;
    this.ready = true;
    return { ready: true };
  }
  status() {
    return { enabled: true, available: this.ready && !this.blocked && !this.closing,
      busy: Boolean(this.active), workspace: 'disposable_copy', network: 'none' };
  }
  execute(input, { signal = null, sessionId = '', streamId = '', jobId = null, expectedIncarnation = null } = {}) {
    const args = validateCommand(input);
    if ((jobId !== null && !UUID.test(jobId)) || (expectedIncarnation !== null && !UUID.test(expectedIncarnation))) {
      return Promise.reject(workerError('sandbox_identity_invalid'));
    }
    if (this.closing || this.blocked || !this.ready) return Promise.reject(workerError('sandbox_unavailable'));
    if (this.active) return Promise.reject(workerError('sandbox_busy', HOST_ERROR_CODES.CONFLICT));
    if (signal?.aborted) return Promise.reject(workerError('sandbox_cancelled_before_admission'));
    const operation = { streamId, sessionId, jobId, expectedIncarnation, promise: null, pending: null };
    this.active = operation;
    operation.promise = this._execute(args, signal, operation).finally(() => {
      if (this.active === operation) this.active = null;
    });
    return operation.promise;
  }
  async _execute(args, signal, operation) {
    let cancelRequested = false;
    const abort = () => {
      cancelRequested = true;
      if (operation.pending) void this._cancel(operation.pending);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const status = await this._statusUntil((value) => value.phase === 'ready' && value.job_id === null ? value : null, this.cleanupTimeoutMs, signal);
      if (signal?.aborted || this.closing) throw workerError('sandbox_cancelled_before_admission');
      if (operation.expectedIncarnation && operation.expectedIncarnation !== status.incarnation) throw workerError('sandbox_stale_incarnation');
      const pending = { job_id: operation.jobId || randomUUID(), incarnation: status.incarnation };
      operation.pending = pending;
      this._persist(pending);
      this._log('host.sandbox_admitted', { job_id: pending.job_id, stream_id: operation.streamId });
      try {
        await this.request('submit', { ...pending, command: args.command, cwd: args.cwd,
          timeout_seconds: args.timeoutSeconds });
      } catch {
        // The request may have crossed admission. Consume the incarnation even
        // if its current status looks idle; a delayed request cannot run later.
        cancelRequested = true;
        await this._cancel(pending);
      }
      if (signal?.aborted || this.closing || cancelRequested) await this._cancel(pending);
      const result = await this._settled(pending, args.timeoutSeconds * 1000 + this.cleanupTimeoutMs);
      this._persist(null);
      this._log('host.sandbox_settled', { job_id: pending.job_id, status: result.status });
      return { ...result, success: result.status === 'completed' && args.expectedExitCodes.includes(result.exit_code),
        workspace: 'disposable_copy', cleanup_confirmed: true };
    } catch (error) {
      if (this.receipt.pending) {
        this.blocked = true;
        this.ready = false;
        this._log('host.sandbox_blocked', { reason: error.reason || 'sandbox_persistence_failed' });
      }
      throw error;
    } finally { signal?.removeEventListener('abort', abort); }
  }
  async drainStream(streamId) {
    const operation = this.active;
    if (operation?.streamId === streamId) {
      try { await operation.promise; } catch { /* outcome is distinct from confirmed cleanup */ }
    }
    if (this.receipt.pending || this.blocked) throw workerError('sandbox_cleanup_unconfirmed');
  }
  async close() {
    this.closing = true;
    const operation = this.active;
    if (operation?.pending) await this._cancel(operation.pending);
    if (operation) {
      try { await operation.promise; } catch (error) { if (this.receipt.pending) throw error; }
    }
    if (this.receipt.pending) throw workerError('sandbox_cleanup_unconfirmed');
    this.ready = false;
  }
}

module.exports = { ExecutionBroker, validateCommand };
