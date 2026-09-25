'use strict';

const { createHash } = require('node:crypto');
const toolManifest = require('../tools/tool-manifest.json');
const {
  MAX_RUNTIME_OPERATION_BYTES,
  getTrustedExecutionBinding,
} = require('../backend/session-execution-authority');
const { buildOperationResources } = require('./resource-broker');
const { stableJson } = require('./contracts');
const { createSandboxPreparation, assertSandboxPreparation } = require('./sandbox-resources');

const API_VERSION = '2026-08-17';
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const COMMON_KEYS = ['api_version', 'authority_revision', 'kind', 'operation_id', 'phase',
  'request_id', 'schema_version', 'session_id'];
const ADMIT_KEYS = [...COMMON_KEYS, 'arguments', 'tool_name'].sort().join(',');
const SETTLE_KEYS = [...COMMON_KEYS, 'cleanup', 'status'].sort().join(',');
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const CLEANUP = new Set(['confirmed', 'uncertain']);
const RESOURCE_FREE_CONTROLS = new Set([
  'check_background_job',
  'check_monitor',
  'stop_background_job',
]);
const descriptors = new Map(toolManifest.tools.map(tool => [tool.name, Object.freeze({
  family: String(tool.tool_family || ''),
})]));
const gateways = new WeakMap();
const gatewayBrands = new WeakSet();

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function response(operationId, status, reason = '') {
  return Object.freeze({ schema_version: 1, operation_id: String(operationId || '').slice(0, 256),
    status, ...(reason ? { reason: String(reason).slice(0, 200) } : {}) });
}

function policyReason(result) {
  return String(result?.error?.reason || result?.reason || 'tool_resource_policy_rejected');
}

function operationType(toolName) {
  if (toolName === 'verify') return 'test';
  if (descriptors.has(toolName) && RESOURCE_FREE_CONTROLS.has(toolName)) return 'control';
  const family = descriptors.get(toolName)?.family;
  if (family === 'git' || family === 'shell'
    || (descriptors.has(toolName) && toolName === 'workspace_manifest_read')) {
    return 'command';
  }
  return family === 'filesystem' ? 'filesystem' : 'tool';
}

function ownerId(requestId, operationId) {
  const digest = createHash('sha256').update(`${requestId}\0${operationId}`).digest('hex');
  return `tool-${digest}`;
}

function getToolResourceOperations(binding) {
  const gateway = gateways.get(binding);
  return gatewayBrands.has(gateway) ? gateway : null;
}

function getHeldToolResourceLease(binding, operationId) {
  return getToolResourceOperations(binding)?.getHeldOperationLease(operationId) || null;
}

class ToolResourceOperations {
  constructor({ broker, pathResolver, executionAuthority, binding, sandboxCommands = false,
    maxOperations = 256, onSettled = null, continuationEnabled = false } = {}) {
    const trusted = getTrustedExecutionBinding(binding);
    if (!broker || typeof broker.tryAcquire !== 'function' || typeof broker.release !== 'function'
      || typeof broker.confirmCleanup !== 'function' || !pathResolver
      || typeof pathResolver.resolve !== 'function' || !executionAuthority
      || typeof executionAuthority.checkRuntimeOperation !== 'function'
      || typeof executionAuthority.requireCurrent !== 'function' || !trusted
      || !Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > 4096
      || (onSettled !== null && typeof onSettled !== 'function')
      || typeof continuationEnabled !== 'boolean'
      || gateways.has(binding)) {
      throw new TypeError('tool_resource_operations_binding_invalid');
    }
    Object.assign(this, { broker, pathResolver, executionAuthority, binding, maxOperations, onSettled });
    this.sandboxCommands = sandboxCommands === true;
    this.continuationEnabled = continuationEnabled;
    this.identity = Object.freeze({ requestId: trusted.requestId, sessionId: trusted.sessionId,
      authorityRevision: trusted.authorityRevision, workspacePath: trusted.authority.root_path });
    this.operations = new Map();
    this.preparations = new Map();
    this.closed = false;
    gatewayBrands.add(this);
    gateways.set(binding, this);
  }

  enableContinuation() {
    if (this.closed || this.operations.size || this.preparations.size) {
      throw new Error('tool_resource_continuation_already_started');
    }
    this.executionAuthority.requireCurrent(this.binding);
    this.continuationEnabled = true;
    return true;
  }

  handle(params) {
    const id = typeof params?.operation_id === 'string' && TOKEN.test(params.operation_id)
      ? params.operation_id : '';
    const reject = reason => response(id, 'rejected', reason);
    if (!this._matchesCommon(params, id)) return reject('tool_resource_authority_mismatch');
    const keys = Object.keys(params).sort().join(',');
    if (params.phase === 'admit' && keys === ADMIT_KEYS
      && typeof params.tool_name === 'string' && TOKEN.test(params.tool_name)
      && plainRecord(params.arguments)) return this._admit(id, params);
    if (params.phase === 'settle' && keys === SETTLE_KEYS
      && TERMINAL.has(params.status) && CLEANUP.has(params.cleanup)) {
      return this._settle(id, params.status, params.cleanup);
    }
    return reject('tool_resource_operation_invalid');
  }

  _matchesCommon(params, id) {
    return Boolean(plainRecord(params) && params.api_version === API_VERSION
      && params.schema_version === 1 && params.kind === 'tool' && id
      && params.request_id === this.identity.requestId
      && params.session_id === this.identity.sessionId
      && params.authority_revision === this.identity.authorityRevision);
  }

  createSandboxPreparation(operationId, { signal, assertLive, argumentsValue, onWaiting } = {}) {
    if (this.closed || !this.sandboxCommands || !TOKEN.test(operationId)
      || typeof assertLive !== 'function' || this.preparations.has(operationId)
      || this.preparations.size >= this.maxOperations || this.operations.has(operationId)) {
      throw new Error('sandbox_preparation_invalid');
    }
    this.executionAuthority.requireCurrent(this.binding);
    const preparation = createSandboxPreparation({ gateway: this, broker: this.broker,
      pathResolver: this.pathResolver, operationId, workspacePath: this.identity.workspacePath,
      assertCurrent: () => this.executionAuthority.requireCurrent(this.binding), signal, assertLive,
      onWaiting: (result, resources) => {
        if (!this.continuationEnabled || !plainRecord(argumentsValue) || typeof onWaiting !== 'function') return;
        this.operations.set(operationId, { toolName: 'run_command', state: 'waiting',
          lease: null, outcome: null, externalProducer: true, resources,
          argumentsDigest: createHash('sha256').update(stableJson(argumentsValue)).digest('hex'),
          resourceWait: Object.freeze({ resource_class: result.resource_class, dependency_id: null }) });
        onWaiting(result);
      },
      onSettled: () => {
        this._notify({ operation_id: operationId, status: null, cleanup: 'confirmed' });
        this._maybeUnregister();
      } });
    this.preparations.set(operationId, preparation);
    return preparation;
  }

  admitPrepared(params, preparation, workerBinding) {
    const id = params?.operation_id;
    if (!this._matchesCommon(params, id) || Object.keys(params).sort().join(',') !== ADMIT_KEYS
      || params.phase !== 'admit' || params.tool_name !== 'run_command'
      || !plainRecord(params.arguments) || !this.sandboxCommands) {
      return response(id, 'rejected', 'sandbox_preparation_invalid');
    }
    const validatePreparation = () => assertSandboxPreparation(preparation, {
      gateway: this, operationId: id, binding: workerBinding,
    });
    try { validatePreparation(); } catch (_error) {
      return response(id, 'rejected', 'sandbox_preparation_invalid');
    }
    return this._admit(id, params, validatePreparation, true);
  }

  admitNode(params) {
    const id = params?.operation_id;
    if (!this._matchesCommon(params, id) || Object.keys(params).sort().join(',') !== ADMIT_KEYS
      || params.phase !== 'admit' || typeof params.tool_name !== 'string'
      || !TOKEN.test(params.tool_name) || !plainRecord(params.arguments)) {
      return response(id, 'rejected', 'tool_resource_operation_invalid');
    }
    return this._admit(id, params, null, true);
  }

  settleNode(params) {
    const id = params?.operation_id;
    if (!this._matchesCommon(params, id) || Object.keys(params).sort().join(',') !== SETTLE_KEYS
      || params.phase !== 'settle' || !TERMINAL.has(params.status) || !CLEANUP.has(params.cleanup)) {
      return response(id, 'rejected', 'tool_resource_operation_invalid');
    }
    return this._settle(id, params.status, params.cleanup, true);
  }

  _policyCheck(params) {
    return this.executionAuthority.checkRuntimeOperation(this.binding, {
      api_version: params.api_version, schema_version: params.schema_version,
      request_id: params.request_id, session_id: params.session_id,
      authority_revision: params.authority_revision, operation_id: params.operation_id,
      phase: 'check', tool_name: params.tool_name, arguments: params.arguments,
    });
  }

  _admit(id, params, validatePreparation = null, externalProducer = false) {
    if (this.closed) return response(id, 'rejected', 'tool_resource_request_closed');
    if (this.operations.has(id)) return response(id, 'rejected', 'tool_resource_operation_duplicate');
    if (this.operations.size >= this.maxOperations) {
      return response(id, 'rejected', 'tool_resource_operation_capacity');
    }
    try {
      if (Buffer.byteLength(JSON.stringify(params), 'utf8') > MAX_RUNTIME_OPERATION_BYTES) {
        return response(id, 'rejected', 'tool_resource_request_too_large');
      }
    } catch (_error) {
      return response(id, 'rejected', 'tool_resource_request_not_serializable');
    }
    const record = { toolName: params.tool_name, state: 'checking', lease: null,
      resources: null, outcome: null, resourceFree: false, externalProducer,
      argumentsDigest: this.continuationEnabled
        ? createHash('sha256').update(stableJson(params.arguments)).digest('hex') : null };
    this.operations.set(id, record);
    let policy;
    try { policy = this._policyCheck(params); } catch (_error) {
      policy = null;
    }
    if (policy?.status !== 'granted') {
      record.state = 'rejected';
      return response(id, 'rejected', policyReason(policy));
    }
    let resources;
    try {
      resources = buildOperationResources({ operationType: operationType(params.tool_name),
        workspacePath: this.identity.workspacePath || '',
        sandboxCommands: this.sandboxCommands && params.tool_name === 'run_command',
        pathResolver: this.pathResolver });
      if (validatePreparation) resources = Object.freeze(resources.filter(resource => (
        resource.type !== 'capacity' || !['native_processes', 'sandbox_commands'].includes(resource.key)
      )));
    } catch (_error) {
      record.state = 'rejected';
      return response(id, 'rejected', 'tool_resource_identity_invalid');
    }
    if (!resources.length) {
      let revalidation = null;
      let current;
      try {
        revalidation = this._policyCheck(params);
        current = revalidation?.status === 'granted' && !this.closed
          && this.executionAuthority.requireCurrent(this.binding) != null;
      } catch (_error) { current = false; }
      if (!current) {
        record.state = 'rejected';
        const reason = revalidation?.status === 'rejected' ? policyReason(revalidation)
          : (this.closed ? 'tool_resource_request_closed' : 'project_authority_stale');
        return response(id, 'rejected', reason);
      }
      record.resources = resources;
      record.resourceFree = true;
      record.state = 'active';
      return response(id, 'granted');
    }
    let revalidation = null;
    const admission = this.broker.tryAcquire({ ownerId: ownerId(this.identity.requestId, id), resources,
      includeWaitingResource: this.continuationEnabled,
      validate: () => {
        validatePreparation?.();
        try { revalidation = this._policyCheck(params); } catch (_error) { revalidation = null; }
        return revalidation?.status === 'granted';
      } });
    if (admission.status !== 'granted') {
      record.state = admission.status;
      if (admission.status === 'waiting' && this.continuationEnabled && admission.resource_class) {
        // A pause checkpoint settles only while this request has nothing
        // quarantined (settlePause). Waiting behind its own unconfirmed
        // cleanup (a timed-out read holding the workspace lock) published a
        // checkpoint that could never settle (2026-09-22): fail the call so
        // the model gets a tool error and the turn continues.
        if (this.snapshot().quarantined > 0) {
          record.state = 'rejected';
          return response(id, 'rejected', 'tool_resource_own_cleanup_unconfirmed');
        }
        record.resources = resources;
        record.resourceWait = Object.freeze({ resource_class: admission.resource_class, dependency_id: null });
        return Object.freeze({ ...response(id, 'waiting', admission.reason), ...record.resourceWait });
      }
      return response(id, admission.status,
        revalidation?.status === 'rejected' ? policyReason(revalidation) : admission.reason);
    }
    let current;
    try {
      current = !this.closed && this.executionAuthority.requireCurrent(this.binding) != null;
    } catch (_error) { current = false; }
    if (!current) {
      this.broker.release(admission.lease, { producerSettled: true });
      record.state = 'rejected';
      return response(id, 'rejected', this.closed
        ? 'tool_resource_request_closed' : 'project_authority_stale');
    }
    record.lease = admission.lease;
    record.resources = resources;
    record.state = 'active';
    return response(id, 'granted');
  }

  getResourceWait(operationId) {
    const record = this.operations.get(operationId);
    return !this.closed && record?.state === 'waiting' ? record.resourceWait || null : null;
  }

  getWaitResources(operationId) {
    const record = this.operations.get(operationId);
    if (!this.getResourceWait(operationId) || !record.resources) return null;
    try {
      this.executionAuthority.requireCurrent(this.binding);
      return record.resources;
    } catch (_error) { return null; }
  }

  confirmUnstartedNodeWait(operationId, toolName, argumentsValue) {
    const record = this.operations.get(operationId);
    if (!record?.externalProducer || record.state !== 'waiting' || record.lease || record.outcome
      || record.toolName !== toolName || !plainRecord(argumentsValue)
      || [...this.preparations.values()].some(item => { const state = item.snapshot(); return state.active || state.quarantined; })) return false;
    try {
      this.executionAuthority.requireCurrent(this.binding);
      if (createHash('sha256').update(stableJson(argumentsValue)).digest('hex') !== record.argumentsDigest) return false;
      record.unstartedConfirmed = true;
      return true;
    } catch (_error) { return false; }
  }

  validateResourceWait(operationId, toolName, argumentsValue) {
    const record = this.operations.get(operationId);
    const wait = this.getResourceWait(operationId);
    if (!wait || (record.externalProducer && record.unstartedConfirmed !== true) || record.toolName !== toolName || !plainRecord(argumentsValue)) return null;
    try {
      this.executionAuthority.requireCurrent(this.binding);
      const digest = createHash('sha256').update(stableJson(argumentsValue)).digest('hex');
      return digest === record.argumentsDigest ? wait : null;
    } catch (_error) { return null; }
  }

  _settle(id, status, cleanup, externalProducer = false) {
    const record = this.operations.get(id);
    if (record?.externalProducer !== externalProducer) {
      return response(id, 'rejected', 'tool_resource_settlement_owner_mismatch');
    }
    if ((!record?.lease && record?.resourceFree !== true)
      || !['active', 'quarantined', 'settled'].includes(record?.state)) {
      return response(id, 'rejected', 'tool_resource_operation_unknown');
    }
    const prior = record.outcome;
    if (prior !== null && (prior.status !== status
      || (prior.cleanup === 'confirmed' && cleanup !== 'confirmed'))) {
      return response(id, 'rejected', 'tool_resource_settlement_conflict');
    }
    const advancesCleanup = cleanup === 'confirmed' && prior?.cleanup === 'uncertain';
    if (prior === null || advancesCleanup) {
      record.outcome = Object.freeze({ status, cleanup });
      if (cleanup === 'confirmed') {
        const needsRelease = record.state !== 'settled';
        record.state = 'settled';
        if (needsRelease && record.lease
          && !this.broker.release(record.lease, { producerSettled: true })) {
          return response(id, 'rejected', 'tool_resource_cleanup_missing');
        }
      } else {
        record.state = 'quarantined';
        if (record.lease) this.broker.release(record.lease, { producerSettled: false });
      }
    }
    const result = response(id, 'settled');
    this._notify({ operation_id: id, status, cleanup });
    this._maybeUnregister();
    return result;
  }

  getHeldOperationLease(operationId) {
    const id = typeof operationId === 'string' && TOKEN.test(operationId) ? operationId : '';
    const record = id ? this.operations.get(id) : null;
    if (!record?.lease || !['active', 'quarantined'].includes(record.state)) return null;
    return Object.freeze({ operation_id: id, tool_name: record.toolName, status: record.state,
      resources: record.resources });
  }

  close({ producerSettled = false } = {}) {
    this.closed = true;
    for (const preparation of this.preparations.values()) preparation.close();
    for (const [id, record] of this.operations) {
      if (record.state === 'settled') continue;
      if (record.resourceFree) {
        record.state = 'settled';
        this._notify({ operation_id: id, status: record.outcome?.status || null,
          cleanup: 'confirmed' });
        continue;
      }
      if (!record.lease) continue;
      if (producerSettled === true && !record.externalProducer) {
        record.state = 'settled';
        if (record.outcome?.cleanup === 'uncertain') {
          record.outcome = Object.freeze({ status: record.outcome.status, cleanup: 'confirmed' });
        }
        this.broker.confirmCleanup(record.lease);
        this._notify({ operation_id: id, status: record.outcome?.status || null,
          cleanup: 'confirmed' });
      } else {
        record.state = 'quarantined';
        this.broker.release(record.lease, { producerSettled: false });
      }
    }
    this._maybeUnregister();
    return this.snapshot();
  }

  snapshot() {
    const counts = { closed: this.closed, operations: this.operations.size, active: 0,
      waiting: 0, rejected: 0, quarantined: 0, settled: 0 };
    for (const record of this.operations.values()) {
      if (Object.hasOwn(counts, record.state)) counts[record.state] += 1;
    }
    for (const preparation of this.preparations.values()) {
      const state = preparation.snapshot();
      if (state.quarantined) counts.quarantined += 1;
      else if (state.active) counts.active += 1;
    }
    return Object.freeze(counts);
  }

  _notify(event) {
    try { this.onSettled?.(Object.freeze({ ...event })); } catch (_error) {
      // Settlement observers cannot change resource ownership.
    }
  }

  _maybeUnregister() {
    const pending = [...this.operations.values()].some(record => (
      record.state === 'active' || record.state === 'quarantined'
    ));
    const prepared = [...this.preparations.values()].some(item => {
      const state = item.snapshot();
      return state.active || state.quarantined;
    });
    if (this.closed && !pending && !prepared && gateways.get(this.binding) === this) gateways.delete(this.binding);
  }
}

module.exports = {
  ToolResourceOperations,
  getHeldToolResourceLease,
  getToolResourceOperations,
};
