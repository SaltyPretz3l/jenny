'use strict';

const { randomUUID } = require('node:crypto');
const { t } = require('../i18n-main');
const { InferenceOperations } = require('../session-runtime/inference-operations');
const { assertRuntimeInferenceProtocol } = require('../session-runtime/inference-protocol');
const { captureSessionRuntimeProviderRoute, assertSessionRuntimeProviderRouteCurrent } = require('./session-runtime-provider-route');
const { assertChatTurnAdmissible } = require('./chat-turn-admission');
const { assertSessionAdmissible } = require('./chat-stream-admission');
const { getTrustedExecutionBinding } = require('./session-execution-authority');
const { retainRuntimeSettlementHandler } = require('./sidecar-client-request-rpc');
const { RUNTIME_ERROR_CODES } = require('./error-codes');

const METHODS = new Set(['suggestions.generate', 'commit.generate_message', 'inline.complete', 'chat.compact']);
const unsettledRequests = new WeakMap();

function admissionError(reason) {
  const error = new Error(t('error.runtime.resourceLimitExceeded', 'Resource limit exceeded.'));
  error.code = RUNTIME_ERROR_CODES.RESOURCE_EXCEEDED;
  error.reason = reason;
  error.retryable = true;
  return error;
}

// Auxiliary requests consume inference capacity without manufacturing a session,
// project grant, transcript, or durable autonomous run.
async function requestRuntimeInference(service, method, params, {
  signal, timeoutMs, sessionId = null, consumeResult = value => value,
} = {}) {
  if (!METHODS.has(method)) throw new TypeError('runtime_auxiliary_method_invalid');
  const scoped = method === 'chat.compact';
  if (typeof consumeResult !== 'function' || (scoped
    ? typeof sessionId !== 'string' || !sessionId.trim() || params?.session_id !== sessionId
    : sessionId !== null)) throw new TypeError('runtime_auxiliary_scope_invalid');
  const runtime = service?.sessionRuntime;
  const client = service?.sidecarClient;
  if (!runtime) {
    if (Object.hasOwn(service?.featureFlags || {}, 'session_runtime')) {
      throw admissionError('runtime_unavailable');
    }
    // Embedded legacy adapters without application composition retain their
    // existing request contract. Production declares the flag, even when OFF.
    const result = scoped ? await client.chatCompact(sessionId, params.messages, { signal, timeoutMs })
      : await client.request(method, params, { signal, timeoutMs });
    return await consumeResult(result);
  }
  if (!(client?.runtimeOperationHandlers instanceof Map) || !client.process || !runtime.lanes) {
    throw admissionError('runtime_bridge_unavailable');
  }
  assertRuntimeInferenceProtocol(client);
  const pending = unsettledRequests.get(service) || new Map();
  unsettledRequests.set(service, pending);
  if (pending.size >= 64) throw admissionError('runtime_unresolved_capacity');
  // The only implemented FIM engine is Ollama, including the existing transient
  // fallback. A selected completion model never chooses its resource class.
  const route = captureSessionRuntimeProviderRoute(service,
    method === 'inline.complete' ? { engineType: 'ollama' } : {});
  const requestId = `aux_${randomUUID()}`;
  const sourceProcess = client.process;
  let binding;
  let trusted;
  let turnLease;
  let gateway;
  let unregister;
  let sessionIdentity;
  const readSessionIdentity = () => {
    const session = service.sessionStore?.getSession?.(sessionId);
    if (!session) throw admissionError('runtime_session_unavailable');
    return JSON.stringify([session.session_incarnation || '', session.created_at || '']);
  };
  const assertCurrent = () => {
    if (runtime.scheduler?.closing === true || runtime.shutdownRequest) throw admissionError('runtime_closing');
    if (signal?.aborted || client.process !== sourceProcess) throw admissionError('runtime_request_stale');
    assertRuntimeInferenceProtocol(client);
    assertSessionRuntimeProviderRouteCurrent(service, route);
    trusted?.assertCurrent();
    if (scoped && readSessionIdentity() !== sessionIdentity) throw admissionError('runtime_session_stale');
    assertChatTurnAdmissible(service, sessionId, route);
    if (scoped) assertSessionAdmissible(service, { sessionId, store: service.sessionStore });
  };
  const releaseConfirmed = () => {
    unregister?.();
    pending.delete(requestId);
    const lease = turnLease;
    turnLease = null;
    if (lease) runtime.lanes.release(lease, { producerSettled: true });
  };
  const handler = value => {
    const result = gateway.handle(value);
    const state = gateway.snapshot();
    if (state.closed && !state.active && !state.reserved && !state.quarantined) releaseConfirmed();
    return result;
  };
  try {
    if (scoped) {
      if (!service.sessionExecutionAuthority) throw admissionError('runtime_authority_unavailable');
      sessionIdentity = readSessionIdentity();
      binding = service.sessionExecutionAuthority.captureSession(sessionId, {
        requestId, signal, mode: 'chat', readOnly: true,
      });
      trusted = getTrustedExecutionBinding(binding);
      if (!trusted) throw admissionError('runtime_authority_unavailable');
      assertCurrent();
      const turn = runtime.lanes.tryAcquireTurn({ sessionId, route, signal });
      if (turn.status !== 'granted') throw admissionError(turn.reason);
      turnLease = turn.lease;
      assertCurrent();
    }
    const authorityRevision = trusted?.authorityRevision || randomUUID();
    gateway = new InferenceOperations({ lanes: runtime.lanes, route, requestId,
      sessionId, authorityRevision, assertCurrent });
    assertCurrent();
    const reservation = gateway.reserveInitial();
    if (reservation.status !== 'granted') throw admissionError(reservation.reason);
    const inferenceContext = Object.freeze({ schema_version: 1, request_id: requestId,
      session_id: sessionId, authority_revision: authorityRevision, engine_type: route.engine_type });
    unregister = retainRuntimeSettlementHandler(client, requestId, handler);
    client.runtimeOperationHandlers.set(requestId, handler);
    pending.set(requestId, gateway);
    assertCurrent();
    const result = await client.request(method, { ...params, request_id: requestId, inference_context: inferenceContext }, {
      signal, timeoutMs, requestKey: requestId,
    });
    assertCurrent();
    // Canonical compaction writes execute while this session's lane and captured
    // authority are still held; releasing capacity may invoke synchronous observers.
    if (scoped && (gateway.snapshot().active || gateway.snapshot().quarantined)) {
      throw admissionError('runtime_cleanup_uncertain');
    }
    return await consumeResult(result);
  } finally {
    if (client.runtimeOperationHandlers.get(requestId) === handler) client.runtimeOperationHandlers.delete(requestId);
    // A returned RPC is not proof that every provider reader has stopped.
    // Confirmed per-attempt settlements release capacity; unresolved leases stay.
    if (binding) service.sessionExecutionAuthority.close(binding);
    const outcome = gateway?.close();
    if (!outcome?.quarantined) {
      releaseConfirmed();
    } else {
      if (turnLease) runtime.lanes.release(turnLease, { producerSettled: false });
      service._emitServiceLog?.('ERROR', 'session_runtime.inference_cleanup_uncertain', {
        request_id: requestId, method, quarantined: outcome.quarantined,
      });
    }
  }
}

module.exports = { requestRuntimeInference };
