'use strict';

const crypto = require('node:crypto');

const DEFAULT_RESPONSE_TIMEOUT_MS = 45_000;
const MAX_ID_LENGTH = 128;
const MAX_BLOCKERS = 16;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, maxLength = MAX_ID_LENGTH) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function readField(value, camelName, snakeName) {
  if (!isRecord(value)) return undefined;
  return value[camelName] !== undefined ? value[camelName] : value[snakeName];
}

function normalizeContext(value) {
  if (!isRecord(value)) return null;
  const generation = Number(value.generation);
  const phase = boundedString(value.phase, 32) || 'ready';
  const rootPath = boundedString(readField(value, 'rootPath', 'root_path'), 4096);
  const rawRootId = readField(value, 'rootId', 'root_id');
  const rootId = rawRootId === null ? null : boundedString(rawRootId, 256) || null;
  if (!Number.isSafeInteger(generation) || generation < 0) return null;
  if (!['ready', 'transitioning', 'error'].includes(phase)) return null;
  if (rootPath && !rootId) return null;
  if (!rootPath && rootId) return null;
  return { rootPath, rootId, generation, phase };
}

function contextToWire(value) {
  const context = normalizeContext(value);
  if (!context) return null;
  return {
    root_path: context.rootPath,
    root_id: context.rootId,
    generation: context.generation,
    phase: context.phase,
  };
}

function normalizePrepared(value) {
  if (!isRecord(value) || value.prepared !== true) return null;
  const transitionId = boundedString(readField(value, 'transitionId', 'transition_id'));
  const previous = normalizeContext(value.previous);
  const candidate = normalizeContext(value.candidate);
  if (!transitionId || !previous || !candidate || candidate.generation <= previous.generation) {
    return null;
  }
  return { transitionId, previous, candidate };
}

function normalizeBlockers(value) {
  return (Array.isArray(value) ? value : []).slice(0, MAX_BLOCKERS).map((entry) => ({
    id: boundedString(entry?.id, 64),
    reason: boundedString(entry?.reason, 64),
  })).filter((entry) => entry.id || entry.reason);
}

function normalizeCancelResult(value) {
  if (!isRecord(value)) return null;
  return {
    canceled: value.canceled === true,
    changed: value.changed === true,
    code: boundedString(value.code, 80),
  };
}

function normalizeOutcome(value) {
  if (!isRecord(value)) return null;
  const context = normalizeContext(value.context);
  const cancelResult = normalizeCancelResult(readField(value, 'cancelResult', 'cancel_result'));
  const blockers = normalizeBlockers(value.blockers);
  const outcome = {
    committed: value.committed === true,
    changed: value.changed === true,
    canceled: value.canceled === true,
    blocked: value.blocked === true,
    rolledBack: readField(value, 'rolledBack', 'rolled_back') === true,
    degraded: value.degraded === true,
    code: boundedString(value.code, 80),
    ...(context ? { context } : {}),
    ...(blockers.length ? { blockers } : {}),
    ...(readField(value, 'rollbackIncomplete', 'rollback_incomplete') === true
      ? { rollbackIncomplete: true }
      : {}),
    ...(cancelResult ? { cancelResult } : {}),
  };
  if (outcome.committed && (!outcome.changed || !context)) return null;
  return outcome;
}

function matchesCommittedCandidate(context, candidate) {
  return Boolean(context && candidate
    && context.rootPath === candidate.rootPath
    && context.rootId === candidate.rootId
    && context.generation === candidate.generation
    && context.phase === 'ready');
}

function refusal(code, extra = {}) {
  return {
    committed: false,
    changed: false,
    canceled: code === 'external_transition_canceled',
    blocked: true,
    rolledBack: false,
    code,
    ...extra,
  };
}

class WorkspaceRootExternalTransitionBroker {
  constructor({
    sendRequest,
    cancelTransition,
    logger = null,
    responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
    requestIdFactory = () => crypto.randomUUID(),
    now = () => Date.now(),
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {}) {
    if (typeof sendRequest !== 'function') {
      throw new TypeError('WorkspaceRootExternalTransitionBroker requires sendRequest');
    }
    if (typeof cancelTransition !== 'function') {
      throw new TypeError('WorkspaceRootExternalTransitionBroker requires cancelTransition');
    }
    if (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs <= 0) {
      throw new TypeError('responseTimeoutMs must be a positive safe integer');
    }
    this._sendRequest = sendRequest;
    this._cancelTransition = cancelTransition;
    this._logger = typeof logger === 'function' ? logger : null;
    this._responseTimeoutMs = responseTimeoutMs;
    this._requestIdFactory = requestIdFactory;
    this._now = now;
    this._setTimeout = setTimeoutImpl;
    this._clearTimeout = clearTimeoutImpl;
    this._pending = null;
    this._disposed = false;
  }

  _log(level, event, details = {}) {
    if (!this._logger) return;
    try {
      this._logger(level, event, details);
    } catch (_error) {
      /* diagnostics never change the transition outcome */
    }
  }

  _cleanup(entry) {
    if (this._pending === entry) this._pending = null;
    if (entry.timer != null) this._clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener('abort', entry.abortListener);
    }
    entry.abortListener = null;
  }

  _resolve(entry, result) {
    if (!entry || entry.settled) return false;
    entry.settled = true;
    this._cleanup(entry);
    entry.resolve(result);
    return true;
  }

  async _cancel(transitionId) {
    try {
      return normalizeCancelResult(await this._cancelTransition({ transitionId })) || {
        canceled: false, changed: false, code: 'invalid_cancel_response',
      };
    } catch (error) {
      return {
        canceled: false,
        changed: false,
        code: boundedString(error?.code, 80) || 'cancel_failed',
      };
    }
  }

  async _refuse(entry, code) {
    if (!entry || entry.settled) return;
    entry.settled = true;
    this._cleanup(entry);
    const cancelResult = await this._cancel(entry.prepared.transitionId);
    const uncertain = cancelResult.canceled !== true || cancelResult.changed === true;
    this._log(uncertain ? 'WARN' : 'INFO', 'workspace_root.external_transition_refused', {
      code,
      cancel_code: cancelResult.code,
      uncertain,
    });
    entry.resolve(refusal(code, { cancelResult, uncertain }));
  }

  async _refuseDetached(prepared, code) {
    const cancelResult = await this._cancel(prepared.transitionId);
    return refusal(code, {
      cancelResult,
      uncertain: cancelResult.canceled !== true || cancelResult.changed === true,
    });
  }

  requestPreparedTransition({
    prepared: rawPrepared,
    mode = 'external',
    signal = null,
  } = {}) {
    const prepared = normalizePrepared(rawPrepared);
    if (!prepared) return Promise.resolve(refusal('external_transition_invalid_prepared'));
    if (this._disposed) return this._refuseDetached(prepared, 'external_transition_broker_disposed');
    if (this._pending) return this._refuseDetached(prepared, 'external_transition_in_progress');
    if (signal?.aborted === true) return this._refuseDetached(prepared, 'external_transition_canceled');

    let requestId = boundedString(this._requestIdFactory());
    if (!requestId) requestId = crypto.randomUUID();
    const deadlineMs = this._now() + this._responseTimeoutMs;
    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const entry = {
      requestId,
      prepared,
      resolve: resolvePromise,
      settled: false,
      timer: null,
      signal: signal && typeof signal.addEventListener === 'function' ? signal : null,
      abortListener: null,
    };
    this._pending = entry;
    entry.timer = this._setTimeout(() => {
      void this._refuse(entry, 'external_transition_timeout');
    }, this._responseTimeoutMs);
    entry.timer?.unref?.();
    if (entry.signal) {
      entry.abortListener = () => {
        void this._refuse(entry, 'external_transition_canceled');
      };
      entry.signal.addEventListener('abort', entry.abortListener, { once: true });
    }

    const wirePayload = {
      request_id: requestId,
      transition_id: prepared.transitionId,
      mode: boundedString(mode, 64) || 'external',
      terminate_processes: false,
      deadline_ms: deadlineMs,
      previous: contextToWire(prepared.previous),
      candidate: contextToWire(prepared.candidate),
    };
    try {
      if (this._sendRequest(wirePayload) === false) {
        void this._refuse(entry, 'external_transition_renderer_unavailable');
      }
    } catch (error) {
      this._log('WARN', 'workspace_root.external_transition_send_failed', {
        code: boundedString(error?.code, 80) || 'send_failed',
      });
      void this._refuse(entry, 'external_transition_renderer_unavailable');
    }
    return promise;
  }

  async respond(payload = {}) {
    const requestId = boundedString(payload.request_id);
    const transitionId = boundedString(payload.transition_id);
    const entry = this._pending;
    if (!entry || requestId !== entry.requestId) {
      return { accepted: false, code: 'external_transition_request_unknown' };
    }
    if (transitionId !== entry.prepared.transitionId) {
      return { accepted: false, code: 'external_transition_response_mismatch' };
    }
    const outcome = normalizeOutcome(payload.outcome);
    if (!outcome) {
      await this._refuse(entry, 'external_transition_response_invalid');
      return { accepted: false, code: 'external_transition_response_invalid' };
    }
    if (outcome.committed && !matchesCommittedCandidate(outcome.context, entry.prepared.candidate)) {
      await this._refuse(entry, 'external_transition_response_invalid');
      return { accepted: false, code: 'external_transition_response_invalid' };
    }
    if (outcome.committed && outcome.degraded) {
      this._resolve(entry, {
        ...outcome,
        committed: false,
        backendCommitted: true,
        code: 'renderer_rehydrate_failed',
      });
      return { accepted: true };
    }
    if (!outcome.committed && !outcome.rolledBack && outcome.cancelResult?.canceled !== true) {
      entry.settled = true;
      this._cleanup(entry);
      const cancelResult = await this._cancel(entry.prepared.transitionId);
      const uncertain = cancelResult.canceled !== true || cancelResult.changed === true;
      entry.resolve({ ...outcome, cancelResult, uncertain });
      return { accepted: true };
    }
    this._resolve(entry, outcome);
    return { accepted: true };
  }

  async dispose() {
    this._disposed = true;
    if (this._pending) await this._refuse(this._pending, 'external_transition_broker_disposed');
  }
}

module.exports = {
  DEFAULT_RESPONSE_TIMEOUT_MS,
  WorkspaceRootExternalTransitionBroker,
  contextToWire,
  normalizeContext,
  matchesCommittedCandidate,
  normalizeOutcome,
  normalizePrepared,
};
