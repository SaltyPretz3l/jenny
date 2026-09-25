'use strict';

const { isRuntimeRoute } = require('./lanes');
const { isInferenceBudget } = require('./inference-budget');

const API_VERSION = '2026-08-17';
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const BASE_KEYS = ['api_version', 'authority_revision', 'kind', 'operation_id', 'phase',
  'request_id', 'schema_version', 'session_id'];
const ADMIT_KEYS = [...BASE_KEYS, 'engine_type'].sort().join(',');
const BUDGET_ADMIT_KEYS = [...BASE_KEYS, 'engine_type', 'maxima'].sort().join(',');
const SETTLE_KEYS = [...BASE_KEYS, 'charge_consumption', 'cleanup', 'consumption', 'status'].sort().join(',');

function response(operationId, status, reason) {
  return Object.freeze({ schema_version: 1, operation_id: operationId, status,
    ...(reason ? { reason } : {}) });
}

// Refusal reasons the sidecar surfaces verbatim: a budget code, or the execution
// authority's own run_mode_changed (the user's mode flip mid-request, kept so
// the terminal card can name it); anything else is a stale authority.
function refusalReason(error) {
  const code = String(error?.code || '');
  return code.startsWith('budget_') || code === 'run_mode_changed' ? code : 'inference_authority_stale';
}

// One gateway belongs to one admitted execution attempt. Route and authority are
// application capabilities; reverse RPC can name an operation but cannot route it.
class InferenceOperations {
  constructor({ lanes, route, requestId, sessionId, authorityRevision, assertCurrent,
    maxOperations = 256, budget = null, initialLease = null,
    fallbackRoutes = [], assertRouteCurrent = () => {} } = {}) {
    if (!lanes || typeof lanes.tryAcquireInference !== 'function'
      || typeof lanes.release !== 'function' || !isRuntimeRoute(route)
      || ![requestId, authorityRevision].every(value => typeof value === 'string' && TOKEN.test(value))
      || (sessionId !== null && (typeof sessionId !== 'string' || !TOKEN.test(sessionId)))
      || typeof assertCurrent !== 'function' || (budget !== null && (!isInferenceBudget(budget)
        || budget.providerId !== route.provider_id))
      || (initialLease !== null && lanes.ownsInferenceLease?.(initialLease, route) !== true)
      || !Array.isArray(fallbackRoutes) || fallbackRoutes.some(item => !isRuntimeRoute(item)
        || item.resource_class !== route.resource_class)
      || typeof assertRouteCurrent !== 'function'
      || !Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > 4096) {
      throw new TypeError('runtime_inference_binding_invalid');
    }
    Object.assign(this, { lanes, route, requestId, sessionId, authorityRevision, assertCurrent, maxOperations, budget });
    this.operations = new Map();
    this.routes = new Map([route, ...fallbackRoutes].map(item => [item.engine_type, item]));
    this.assertRouteCurrent = assertRouteCurrent;
    this.initialLease = initialLease;
    this.reserving = false;
    this.closed = false;
  }

  reserveInitial() {
    if (this.closed || this.operations.size || this.reserving) return response('', 'rejected', 'inference_request_closed');
    if (this.initialLease) return response('', 'granted');
    this.reserving = true;
    let lease;
    try {
      this.assertCurrent();
      const admission = this.lanes.tryAcquireInference({ ownerId: this.requestId, route: this.route });
      if (admission.status !== 'granted') return admission;
      lease = admission.lease;
      this.assertCurrent();
      if (this.closed) throw new Error('closed');
      this.initialLease = lease;
      return response('', 'granted');
    } catch (error) {
      if (lease) this.lanes.release(lease, { producerSettled: true });
      return response('', 'rejected', refusalReason(error));
    } finally { this.reserving = false; }
  }

  handle(params) {
    const id = typeof params?.operation_id === 'string' && TOKEN.test(params.operation_id)
      ? params.operation_id : '';
    const reject = reason => response(id, 'rejected', reason);
    if (!params || typeof params !== 'object' || Array.isArray(params)
      || params.api_version !== API_VERSION || params.schema_version !== 1
      || params.kind !== 'inference' || !id
      || params.request_id !== this.requestId || params.session_id !== this.sessionId
      || params.authority_revision !== this.authorityRevision) return reject('inference_authority_mismatch');
    const keys = Object.keys(params).sort().join(',');
    const admitKeys = this.budget?.requiresMaxima ? BUDGET_ADMIT_KEYS : ADMIT_KEYS;
    if (params.phase === 'admit' && keys === admitKeys) {
      if (typeof params.engine_type !== 'string' || !this.routes.has(params.engine_type)) {
        return reject('inference_provider_mismatch');
      }
      return this._admit(id, params.maxima, this.routes.get(params.engine_type));
    }
    if (params.phase === 'settle' && keys === SETTLE_KEYS
      && ['succeeded', 'failed', 'cancelled'].includes(params.status)
      && ['confirmed', 'uncertain'].includes(params.cleanup)
      && params.consumption === 'unknown' && params.charge_consumption === true) {
      return this._settle(id, params);
    }
    return reject('inference_operation_invalid');
  }

  _admit(id, maxima, route = this.route) {
    const reject = reason => response(id, 'rejected', reason);
    if (this.closed) return reject('inference_request_closed');
    if (this.operations.has(id)) return reject('inference_operation_duplicate');
    if (this.operations.size >= this.maxOperations) return reject('inference_operation_capacity');
    const record = { lease: null, state: 'admitting', outcome: null, budgetPending: false, budget: null };
    this.operations.set(id, record);
    try {
      this.assertCurrent();
      this.assertRouteCurrent(route);
      record.budget = this.budget && (route === this.route ? this.budget : this.budget.forProvider(route.provider_id));
      if (this.initialLease && route !== this.route) {
        this.lanes.release(this.initialLease, { producerSettled: true });
        this.initialLease = null;
      }
      const admission = this.initialLease ? { status: 'granted', lease: this.initialLease }
        : this.lanes.tryAcquireInference({ ownerId: this.requestId, route });
      if (admission.status !== 'granted') {
        this.operations.delete(id);
        return response(id, admission.status === 'waiting' ? 'waiting' : 'rejected', admission.reason);
      }
      record.lease = admission.lease;
      this.initialLease = null;
      // Lane observers may synchronously revoke authority or close this gateway.
      this.assertCurrent();
      this.assertRouteCurrent(route);
      if (this.closed) throw new Error('closed');
      if (record.budget) { record.budget.reserve(id, maxima); record.budgetPending = true; }
      this.assertCurrent();
      this.assertRouteCurrent(route);
      if (this.closed) throw new Error('closed');
      record.state = 'active';
      return response(id, 'granted');
    } catch (error) {
      if (record.budgetPending) {
        this._settleBudget(id, record);
        record.state = 'settled';
      } else this.operations.delete(id);
      if (record.lease) this.lanes.release(record.lease, { producerSettled: true });
      return reject(refusalReason(error));
    }
  }

  _settleBudget(id, record) {
    if (!record.budgetPending) return null;
    try {
      record.budget.settleUnknown(id);
      record.budgetPending = false;
      return null;
    } catch (_error) {
      // Durable reservation maxima remain charged. Ledger trouble cannot hide
      // physical cleanup or refund uncertain consumption.
      return 'inference_budget_settlement_pending';
    }
  }

  _settle(id, params) {
    const record = this.operations.get(id);
    if (!record?.lease) return response(id, 'rejected', 'inference_operation_unknown');
    const outcome = `${params.status}:${params.cleanup}:${params.consumption}`;
    if (record.outcome !== null && record.outcome !== outcome) {
      return response(id, 'rejected', 'inference_settlement_conflict');
    }
    // Settlement validates the original binding but deliberately does not require
    // current grants: revocation must stop dispatch while allowing producer cleanup.
    record.outcome = outcome;
    const budgetError = this._settleBudget(id, record);
    if (record.state !== 'settled') {
      const confirmed = params.cleanup === 'confirmed';
      record.state = confirmed ? 'settled' : 'quarantined';
      this.lanes.release(record.lease, { producerSettled: confirmed });
    }
    return response(id, budgetError ? 'rejected' : 'settled', budgetError);
  }

  close({ producerSettled = false } = {}) {
    this.closed = true;
    const initialLease = this.initialLease;
    this.initialLease = null;
    if (initialLease) this.lanes.release(initialLease, { producerSettled: true });
    for (const [id, record] of this.operations) {
      this._settleBudget(id, record);
      if (!record.lease || record.state === 'settled'
        || (record.state === 'quarantined' && producerSettled !== true)) continue;
      record.state = producerSettled === true ? 'settled' : 'quarantined';
      this.lanes.release(record.lease, { producerSettled: producerSettled === true });
    }
    return this.snapshot();
  }

  snapshot() {
    const counts = { closed: this.closed, reserved: this.initialLease ? 1 : 0, operations: this.operations.size, active: 0,
      quarantined: 0, settled: 0, unknown_consumption: 0 };
    for (const record of this.operations.values()) {
      if (Object.hasOwn(counts, record.state)) counts[record.state] += 1;
      if (record.lease) counts.unknown_consumption += 1;
    }
    if (this.budget) counts.budget_settlements_pending = [...this.operations.values()]
      .filter(record => record.budgetPending).length;
    return Object.freeze(counts);
  }
}

module.exports = { InferenceOperations };
