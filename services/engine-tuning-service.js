'use strict';

/* services/engine-tuning-service.js - applies Advanced engine-tuning changes.
 *
 * Deliberately NOT an extension of ModelTuningService: that class is built
 * around a required modelId (guarded in four places) plus a VRAM preflight,
 * none of which applies to these global knobs. What IS copied is its
 * discipline - validate, snapshot, write, refresh, and roll the config back if
 * the running sidecar refuses the new value, so a bad number cannot wedge chat.
 */
const {
  ENGINE_TUNING_FIELDS,
  ENGINE_TUNING_GROUPS,
  getFieldDefinition,
  isEngineTuningValueInRange,
} = require('../renderer/shared/engine-tuning-schema');

const ENGINE_TUNING_REFRESH_TIMEOUT_MS = 30_000;

class EngineTuningService {
  constructor({ shellConfigService, backendService, log = null } = {}) {
    this.shellConfigService = shellConfigService || null;
    this.backendService = backendService || null;
    this.log = typeof log === 'function' ? log : null;
    this.pending = false;
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
  }

  _readValues() {
    const values = {};
    try {
      Object.assign(values, this.shellConfigService?.getEngineTuning?.() || {});
    } catch (_error) {
      this._emit('WARN', 'engine_tuning.state_read_failed', {
        status: 'degraded',
        reason: 'config_read_failed',
      });
      return { ok: false, values };
    }
    return { ok: true, values };
  }

  getState() {
    const { values } = this._readValues();
    return {
      values,
      fields: ENGINE_TUNING_FIELDS,
      groups: ENGINE_TUNING_GROUPS,
      pending: this.pending,
      // The UI disables the field set rather than letting the user discover the
      // refusal by trying, so it needs to know before it renders.
      activeStream: this._hasActiveStream(),
    };
  }

  _hasActiveStream() {
    try {
      return Boolean(this.backendService?.activeStreams?.size);
    } catch (_error) {
      return false;
    }
  }

  _emit(level, event, details = {}) {
    const bounded = {
      event,
      key: String(details.key || '').slice(0, 80),
      status: String(details.status || '').slice(0, 32),
      reason: String(details.reason || '').slice(0, 80),
      scope: String(details.scope || '').slice(0, 16),
      changed: Number.isFinite(Number(details.changed)) ? Number(details.changed) : null,
    };
    try {
      if (this.backendService && typeof this.backendService._emitServiceLog === 'function') {
        this.backendService._emitServiceLog(level, event, bounded);
      } else if (this.log) {
        this.log(level, event, bounded);
      }
    } catch (_error) {
      // Diagnostics must never change the tuning result contract.
    }
  }

  /* Resolves { deferred } - true when the config was written but no running
   * managed sidecar was there to receive it. refreshManagedConfig resolves null
   * in exactly that case (no managed mode, or no sidecar process yet/any more):
   * the value is persisted and the next sidecar start reads it, so rolling it
   * back would leave the user unable to change ANY limit while the engine is
   * down - including the timeout that may be why it is down. A missing backend
   * service is different: that is a wiring fault, and still throws. */
  async _refreshOrThrow(reason) {
    if (!this.backendService || typeof this.backendService.refreshManagedConfig !== 'function') {
      throw new Error('managed_runtime_unavailable');
    }
    const result = await this.backendService.refreshManagedConfig(reason, {
      inactivityTimeoutMs: ENGINE_TUNING_REFRESH_TIMEOUT_MS,
      absoluteTimeoutMs: ENGINE_TUNING_REFRESH_TIMEOUT_MS,
    });
    return { deferred: result == null };
  }

  /* Write one field's worth of change. `null` resets. */
  _persist(key, value) {
    this.shellConfigService.updateEngineTuning({ [key]: value });
  }

  /* Every transaction result carries a state snapshot taken AFTER the pending
   * flag is cleared: the renderer disables the whole field set while
   * `state.pending` is true, so a snapshot taken inside the transaction would
   * freeze the UI until something else happened to refresh it. */
  _finish(outcome) {
    this.pending = false;
    return { ...outcome, state: this.getState() };
  }

  async update({ key, value } = {}) {
    if (this.disposed) return { status: 'rejected', reason: 'disposed', state: this.getState() };
    if (this.pending) {
      return { status: 'rejected', reason: 'update_in_progress', state: this.getState() };
    }
    const field = getFieldDefinition(key);
    if (!field) return { status: 'rejected', reason: 'invalid_field', state: this.getState() };
    const isReset = value == null || value === '';
    if (!isReset && !isEngineTuningValueInRange(key, value)) {
      // Rejected rather than clamped: the sidecar would fall back to its default
      // for an out-of-range value, so silently storing a clamped one would leave
      // the UI and the engine disagreeing.
      return { status: 'rejected', reason: 'invalid_value', state: this.getState() };
    }
    // These knobs govern the very loop a running turn is executing; changing
    // them mid-stream would apply half to this turn and half to the next.
    if (this._hasActiveStream()) {
      return { status: 'rejected', reason: 'active_stream', state: this.getState() };
    }
    const previousRead = this._readValues();
    if (!previousRead.ok) {
      return { status: 'rejected', reason: 'config_read_failed', state: this.getState() };
    }
    const previous = previousRead.values;
    const hadPrevious = Object.prototype.hasOwnProperty.call(previous, key);
    const previousValue = hadPrevious ? previous[key] : null;

    this.pending = true;
    let applyStage = 'config_write';
    try {
      this._persist(key, isReset ? null : Number(value));
      applyStage = 'runtime_refresh';
      const { deferred } = await this._refreshOrThrow('engine_tuning_transaction');
      if (this.disposed) {
        return this._finish({ status: 'applied', reason: 'disposed_after_apply' });
      }
      this._emit('INFO', 'engine_tuning.applied', {
        key,
        status: 'applied',
        reason: deferred ? 'deferred' : (isReset ? 'reset' : 'set'),
      });
      return this._finish(deferred ? { status: 'applied', reason: 'deferred' } : { status: 'applied' });
    } catch (_error) {
      const reason = applyStage === 'runtime_refresh' ? 'runtime_refresh_failed' : 'config_write_failed';
      try {
        this._persist(key, previousValue);
      } catch (_rollbackError) {
        this._emit('ERROR', 'engine_tuning.rollback_failed', {
          key,
          status: 'degraded',
          reason: 'rollback_persistence_failed',
        });
        return this._finish({ status: 'degraded', reason: 'rollback_persistence_failed' });
      }
      try {
        await this._refreshOrThrow('engine_tuning_rollback');
      } catch (_rollbackError) {
        this._emit('ERROR', 'engine_tuning.rollback_failed', {
          key,
          status: 'degraded',
          reason: 'rollback_refresh_failed',
        });
        return this._finish({ status: 'degraded', reason: 'rollback_refresh_failed' });
      }
      this._emit('ERROR', 'engine_tuning.apply_failed', { key, status: 'rolled_back', reason });
      return this._finish({ status: 'rolled_back', reason });
    } finally {
      this.pending = false;
    }
  }

  /* Clear every override, or only one pane's. ONE config write and ONE refresh:
   * resetting field-by-field would reinitialise the sidecar ~25 times. */
  async reset({ scope = null } = {}) {
    if (this.disposed) return { status: 'rejected', reason: 'disposed', state: this.getState() };
    if (this.pending) {
      return { status: 'rejected', reason: 'update_in_progress', state: this.getState() };
    }
    const normalizedScope = String(scope || '').trim();
    if (normalizedScope && normalizedScope !== 'local' && normalizedScope !== 'cloud') {
      return { status: 'rejected', reason: 'invalid_scope', state: this.getState() };
    }
    if (this._hasActiveStream()) {
      return { status: 'rejected', reason: 'active_stream', state: this.getState() };
    }
    const previousRead = this._readValues();
    if (!previousRead.ok) {
      return { status: 'rejected', reason: 'config_read_failed', state: this.getState() };
    }
    const previous = previousRead.values;

    this.pending = true;
    let applyStage = 'config_write';
    try {
      this.shellConfigService.resetEngineTuning(normalizedScope || null);
      applyStage = 'runtime_refresh';
      const { deferred } = await this._refreshOrThrow('engine_tuning_reset');
      this._emit('INFO', 'engine_tuning.applied', {
        status: 'applied',
        reason: deferred ? 'deferred' : 'reset_all',
        scope: normalizedScope || 'all',
        changed: Object.keys(previous).length,
      });
      return this._finish(deferred ? { status: 'applied', reason: 'deferred' } : { status: 'applied' });
    } catch (_error) {
      const reason = applyStage === 'runtime_refresh' ? 'runtime_refresh_failed' : 'config_write_failed';
      try {
        // ONE write for the rollback too: updateEngineTuning takes a multi-key
        // patch, so restoring field-by-field would be N disk writes and N
        // 'changed' emits, with a half-restored block if one of them threw.
        this.shellConfigService.updateEngineTuning(previous);
      } catch (_rollbackError) {
        this._emit('ERROR', 'engine_tuning.rollback_failed', {
          status: 'degraded',
          reason: 'rollback_persistence_failed',
          scope: normalizedScope || 'all',
        });
        return this._finish({ status: 'degraded', reason: 'rollback_persistence_failed' });
      }
      try {
        await this._refreshOrThrow('engine_tuning_rollback');
      } catch (_rollbackError) {
        this._emit('ERROR', 'engine_tuning.rollback_failed', {
          status: 'degraded',
          reason: 'rollback_refresh_failed',
          scope: normalizedScope || 'all',
        });
        return this._finish({ status: 'degraded', reason: 'rollback_refresh_failed' });
      }
      this._emit('ERROR', 'engine_tuning.apply_failed', {
        status: 'rolled_back',
        reason,
        scope: normalizedScope || 'all',
      });
      return this._finish({ status: 'rolled_back', reason });
    } finally {
      this.pending = false;
    }
  }
}

module.exports = {
  EngineTuningService,
};
