'use strict';

const { validateCommand, hostFailure } = require('./api-contract');
const { createDecisionAdapter } = require('./decision-adapter');
const { CancellationRegistry, SessionMutationQueue } = require('./command-router-concurrency');
const { buildSessionSnapshot } = require('./session-snapshots');

const LEASE_OPERATIONS = new Set([
  'sessions.rename', 'sessions.delete', 'sessions.preferences', 'chat.send',
  'chat.cancel', 'approval.resolve', 'questions.answer', 'questions.decline',
]);
const MAX_SESSIONS = 10_000;
const TERMINAL_STREAM_TYPES = new Set(['complete', 'error', 'cancelled', 'canceled', 'failed']);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, limit = 500) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function safeSession(value) {
  if (!isRecord(value)) return null;
  const id = text(value.id || value.session_id, 128);
  if (!id) return null;
  const result = { session_id: id, title: text(value.title, 240) };
  for (const [source, target, limit] of [
    ['session_type', 'session_type', 32], ['created_at', 'created_at', 80],
    ['updated_at', 'updated_at', 80], ['last_model_used', 'last_model_used', 240],
    ['preferred_model', 'preferred_model', 240], ['reasoning_effort', 'reasoning_effort', 80],
    ['run_mode', 'run_mode', 32],
  ]) {
    if (typeof value[source] === 'string') result[target] = text(value[source], limit);
  }
  if (typeof value.plan_mode === 'boolean') result.plan_mode = value.plan_mode;
  if (Number.isSafeInteger(value.message_count) && value.message_count >= 0) {
    result.message_count = value.message_count;
  }
  return result;
}

function safeBackendError(error, requestId) {
  const code = text(error?.code || error?.reason, 80).toLowerCase();
  if (code.includes('persist') || code.includes('storage') || code === 'cmp-host-0006') {
    return hostFailure('persistence', 'backend_persistence_failed', requestId);
  }
  if (code.includes('busy')) return hostFailure('conflict', 'backend_busy', requestId, true);
  return hostFailure('unavailable', 'backend_unavailable', requestId, true);
}

function createCommandRouter({
  backend,
  clients,
  leases,
  receipts,
  bootEpoch,
  eventStream,
  resolveAttachments,
  canAdmit = () => true,
} = {}) {
  if (!isRecord(backend)) throw new TypeError('Command router requires backend.');
  if (!isRecord(clients) || typeof clients.authorize !== 'function') {
    throw new TypeError('Command router requires client registry.');
  }
  if (!isRecord(leases) || typeof leases.owns !== 'function') {
    throw new TypeError('Command router requires control leases.');
  }
  if (!isRecord(receipts) || typeof receipts.run !== 'function') {
    throw new TypeError('Command router requires command receipts.');
  }
  if (!validId(bootEpoch)) throw new TypeError('Command router requires valid boot epoch.');
  if (!isRecord(eventStream) || typeof eventStream.publish !== 'function') {
    throw new TypeError('Command router requires event stream.');
  }

  const decisionAdapter = createDecisionAdapter({ backend });
  const revisions = new Map();
  const mutationQueue = new SessionMutationQueue({ capacity: MAX_SESSIONS });
  const cancellations = new CancellationRegistry();
  let creatingSession = false;
  const activeForeground = { value: null };
  const disposed = { value: false };
  const listeners = [];

  function currentRevision(sessionId) {
    const value = revisions.get(sessionId);
    return `${bootEpoch}:${value || 0}`;
  }

  function hasSession(sessionId) {
    return Boolean(backend.sessionStore?.getSession?.(sessionId)
      || backend.getSession?.(sessionId));
  }

  function bumpRevision(sessionId) {
    if (!sessionId || !hasSession(sessionId)) return currentRevision(sessionId);
    if (!revisions.has(sessionId) && revisions.size >= MAX_SESSIONS) {
      throw new Error('revision_capacity');
    }
    const next = (revisions.get(sessionId) || 0) + 1;
    revisions.set(sessionId, next);
    return currentRevision(sessionId);
  }

  function publish(type, payload = {}) {
    try { eventStream.publish(type, payload); } catch (_error) { /* transport is best effort */ }
  }

  function releaseForeground(streamId = '', reason = '') {
    const current = activeForeground.value;
    if (!current || (streamId && current.streamId && current.streamId !== streamId)) return;
    activeForeground.value = null;
    if (reason) publish('foreground_changed', { state: 'idle', reason });
  }

  function onBackendStream(event) {
    const sessionId = text(event?.sessionId, 128);
    const streamId = text(event?.streamId, 128);
    const type = text(event?.type, 80).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    if (!sessionId || !streamId || !type) return;
    if (TERMINAL_STREAM_TYPES.has(type)) {
      cancellations.markTerminal(sessionId, streamId);
      bumpRevision(sessionId);
      releaseForeground(streamId, type);
    }
  }

  // BackendEvents owns canonical chat DTO publication and live projection.
  // The router observes only identity and terminal status for revision fences
  // and foreground release; it never republishes provider payloads.
  if (typeof backend.on === 'function') {
    backend.on('chat-stream', onBackendStream);
    listeners.push(['chat-stream', onBackendStream]);
  }

  function identity(command, context) {
    if (disposed.value) return hostFailure('unavailable', 'router_disposed', command.request_id);
    let authenticated;
    try {
      authenticated = typeof context?.isAuthenticated === 'function'
        ? context.isAuthenticated() === true : context?.isAuthenticated === true;
    } catch (_error) { authenticated = false; }
    if (!context || !authenticated
      || typeof context.deviceId !== 'string' || !context.deviceId
      || !clients.authorize(command.client_id, context.clientToken, context.deviceId)) {
      return hostFailure('unauthorized', 'client_unauthorized', command.request_id);
    }
    if (command.boot_epoch !== bootEpoch) return hostFailure('conflict', 'boot_epoch_mismatch', command.request_id, true);
    return null;
  }

  function revisionAndLease(command, context, { expectedRevision = true, requireSession = true } = {}) {
    const authFailure = identity(command, context);
    if (authFailure) return authFailure;
    if (!LEASE_OPERATIONS.has(command.operation)) return null;
    if (!Number.isSafeInteger(command.control_generation)) {
      return hostFailure('forbidden', 'control_generation_required', command.request_id);
    }
    if (expectedRevision && typeof command.expected_revision !== 'string') {
      return hostFailure('conflict', 'expected_revision_required', command.request_id);
    }
    const sessionId = command.session_id;
    if (requireSession && !hasSession(sessionId)) return hostFailure('conflict', 'session_not_found', command.request_id);
    if (!revisions.has(sessionId) && revisions.size >= MAX_SESSIONS) {
      return hostFailure('limit', 'revision_capacity', command.request_id);
    }
    if (!leases.owns(sessionId, command.client_id, context.deviceId, command.control_generation)) {
      return hostFailure('forbidden', 'control_lease_required', command.request_id);
    }
    if (expectedRevision && command.expected_revision !== currentRevision(sessionId)) {
      return hostFailure('conflict', 'revision_conflict', command.request_id, true);
    }
    return null;
  }

  function mutationGuard(command, context) {
    return revisionAndLease(command, context);
  }

  function assertMutationAuthority(command, context) {
    const failure = mutationGuard(command, context);
    if (failure) {
      const error = new Error(failure.error.reason);
      error.routerFailure = failure;
      throw error;
    }
  }

  function assertPostAwaitAuthority(command, context, options = {}) {
    const failure = revisionAndLease(command, context, { ...options, expectedRevision: false });
    if (!failure) return;
    // The awaited backend call may already have committed. Advance the local
    // revision fence before returning indeterminate so the next controller
    // cannot write using the stale expected revision.
    bumpRevision(command.session_id);
    const error = new Error(failure.error.reason);
    error.indeterminate = true;
    throw error;
  }

  function assertPostAwaitIdentity(command, context) {
    const failure = identity(command, context);
    if (!failure) return;
    const error = new Error(failure.error.reason);
    error.indeterminate = true;
    throw error;
  }

  function authorityFailure(error, command) {
    if (error?.routerFailure) return error.routerFailure;
    if (error?.indeterminate) return hostFailure('conflict', 'operation_indeterminate', command.request_id, true);
    return safeBackendError(error, command.request_id);
  }

  async function runReceipt(command, context, execute) {
    return receipts.run(command, context.deviceId, async () => {
      try {
        // The chat lock covers admission only; the backend's pending stream
        // promise is deliberately not awaited here.
        return LEASE_OPERATIONS.has(command.operation)
          ? await mutationQueue.run(command.session_id, execute) : await execute();
      }
      catch (error) {
        if (error.indeterminate) throw error;
        return authorityFailure(error, command);
      }
    });
  }

  function unwrapData(value) {
    if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'data')) return value.data;
    return value;
  }

  async function listSessions(command) {
    try {
      const value = await backend.listSessions();
      const data = Array.isArray(value?.data) ? value.data : (Array.isArray(value) ? value : []);
      return { ok: true, sessions: data.map(safeSession).filter(Boolean), total: data.length };
    } catch (error) { return safeBackendError(error, command.request_id); }
  }

  async function createSession(command, context) {
    return runReceipt(command, context, async () => {
      const initialFailure = identity(command, context);
      if (initialFailure) {
        const error = new Error(initialFailure.error.reason);
        error.routerFailure = initialFailure;
        throw error;
      }
      if (creatingSession) return hostFailure('conflict', 'session_create_busy', command.request_id, true);
      creatingSession = true;
      try {
      const listed = await backend.listSessions();
      assertPostAwaitIdentity(command, context);
      const rows = Array.isArray(listed) ? listed : listed?.data;
      if (!Array.isArray(rows)) return hostFailure('unavailable', 'sessions_unavailable', command.request_id);
      if (rows.length >= MAX_SESSIONS) return hostFailure('limit', 'session_capacity', command.request_id);
      const value = await backend.createSession({ title: command.params.title });
      assertPostAwaitIdentity(command, context);
      const session = safeSession(unwrapData(value));
      if (!session) return hostFailure('persistence', 'session_create_failed', command.request_id);
      const revision = bumpRevision(session.session_id);
      publish('session_changed', { session_id: session.session_id, revision, reason: 'created' });
      return { ok: true, session, revision };
      } finally { creatingSession = false; }
    });
  }

  async function snapshot(command, options = {}) {
    const value = buildSessionSnapshot({
      backend, eventStream, decisionAdapter, sessionId: command.session_id,
      revision: currentRevision(command.session_id),
      options: { ...options, boot_epoch: bootEpoch },
    });
    if (!value) return hostFailure('conflict', 'session_not_found', command.request_id);
    if (value.ok === false) return hostFailure('invalid', value.reason, command.request_id);
    value.control = leases.get(command.session_id);
    return { ok: true, snapshot: value };
  }

  async function controlAcquire(command, context) {
    const authFailure = identity(command, context);
    if (authFailure) return authFailure;
    if (!hasSession(command.session_id)) return hostFailure('conflict', 'session_not_found', command.request_id);
    const lease = leases.acquire(command.session_id, command.client_id, context.deviceId, command.params.takeover === true);
    if (!lease) return hostFailure('conflict', 'control_lease_unavailable', command.request_id, true);
    publish('control_changed', {
      session_id: command.session_id,
      client_id: lease.client_id,
      generation: lease.generation,
      expires_at: lease.expires_at,
    });
    return { ok: true, lease };
  }

  async function controlHeartbeat(command, context) {
    const authFailure = identity(command, context);
    if (authFailure) return authFailure;
    if (!Number.isSafeInteger(command.control_generation)) {
      return hostFailure('forbidden', 'control_generation_required', command.request_id);
    }
    const lease = leases.heartbeat(command.session_id, command.client_id, context.deviceId, command.control_generation);
    if (!lease) return hostFailure('forbidden', 'control_lease_required', command.request_id);
    return { ok: true, lease };
  }

  async function controlRelease(command, context) {
    const authFailure = identity(command, context);
    if (authFailure) return authFailure;
    if (!Number.isSafeInteger(command.control_generation)) {
      return hostFailure('forbidden', 'control_generation_required', command.request_id);
    }
    if (!leases.release(command.session_id, command.client_id, context.deviceId, command.control_generation)) {
      return hostFailure('forbidden', 'control_lease_required', command.request_id);
    }
    publish('control_changed', { session_id: command.session_id, state: 'released' });
    return { ok: true, released: true };
  }

  async function renameSession(command, context) {
    const failure = mutationGuard(command, context); if (failure) return failure;
    return runReceipt(command, context, async () => {
      assertMutationAuthority(command, context);
      const value = await backend.renameSession(command.session_id, command.params.title);
      assertPostAwaitAuthority(command, context);
      const session = safeSession(unwrapData(value));
      if (!session) return hostFailure('persistence', 'session_rename_failed', command.request_id);
      const revision = bumpRevision(command.session_id);
      publish('session_changed', { session_id: command.session_id, revision, reason: 'renamed' });
      return { ok: true, session, revision };

    });
  }

  async function setPreferences(command, context) {
    const failure = mutationGuard(command, context); if (failure) return failure;
    return runReceipt(command, context, async () => {
      assertMutationAuthority(command, context);
      const value = await backend.setSessionPreferences(command.session_id, { plan_mode: command.params.plan_mode });
      assertPostAwaitAuthority(command, context);
      const session = safeSession(unwrapData(value));
      if (!session) return hostFailure('persistence', 'session_preferences_failed', command.request_id);
      const revision = bumpRevision(command.session_id);
      publish('session_changed', { session_id: command.session_id, revision, reason: 'preferences' });
      return { ok: true, session, revision };

    });
  }

  async function deleteSession(command, context) {
    const failure = mutationGuard(command, context); if (failure) return failure;
    return runReceipt(command, context, async () => {
      assertMutationAuthority(command, context);
      if (activeForeground.value?.sessionId === command.session_id) {
        return hostFailure('conflict', 'session_active', command.request_id);
      }
      const value = await backend.deleteSession(command.session_id);
      assertPostAwaitAuthority(command, context, { requireSession: false });
      const deleted = value === true || value?.deleted === true;
      if (!deleted) return hostFailure('persistence', 'session_delete_failed', command.request_id);
      revisions.delete(command.session_id);
      publish('session_changed', { session_id: command.session_id, state: 'deleted' });
      return { ok: true, session_id: command.session_id, deleted: true };
    });
  }

  function trustedChatOptions(command) {
    const session = backend.sessionStore?.getSession?.(command.session_id) || {};
    return {
      preferredModel: text(backend.options?.modelEndpoint?.model || session.preferred_model || session.last_model_used, 240),
      reasoningEffort: text(session.reasoning_effort, 80),
      planMode: session.plan_mode === true,
      contextPreferences: isRecord(session.context_preferences) ? structuredClone(session.context_preferences) : undefined,
      toolPreferences: isRecord(session.tool_category_overrides) ? structuredClone(session.tool_category_overrides) : undefined,
      approvalMode: 'prompt',
    };
  }

  async function sendChat(command, context) {
    const failure = mutationGuard(command, context); if (failure) return failure;
    const requestKey = `${context.deviceId}:${command.request_id}`;
    const current = activeForeground.value;
    if (current && current.requestKey !== requestKey) return hostFailure('conflict', 'foreground_busy', command.request_id, true);
    if (!current) {
      activeForeground.value = { requestKey, sessionId: command.session_id, streamId: '' };
      publish('foreground_changed', { state: 'busy', session_id: command.session_id });
    }
    let admittedStreamId = '';
    return runReceipt(command, context, async () => {
      try {
        assertMutationAuthority(command, context);
        const ids = Array.isArray(command.params.attachment_ids) ? command.params.attachment_ids : [];
        let attachments = [];
        if (ids.length) {
          if (typeof resolveAttachments !== 'function') return hostFailure('invalid', 'attachment_resolver_required', command.request_id);
          attachments = await resolveAttachments(ids, { sessionId: command.session_id, deviceId: context.deviceId });
          if (attachments?.ok === false) return hostFailure(attachments.error.kind, attachments.error.reason, command.request_id);
          if (attachments?.ok === true) attachments = attachments.attachments;
          assertMutationAuthority(command, context);
          if (!Array.isArray(attachments) || attachments.length !== ids.length) {
            return hostFailure('invalid', 'attachment_resolution_failed', command.request_id);
          }
        }
        const options = trustedChatOptions(command);
        const handle = await backend.startChatStream({
          sessionId: command.session_id,
          prompt: command.params.prompt,
          visiblePrompt: command.params.prompt,
          traceId: command.request_id,
          attachments,
          ...options,
        });
        const streamId = text(handle?.streamId || handle?.stream_id, 128);
        if (streamId) admittedStreamId = streamId;
        if (activeForeground.value?.requestKey === requestKey) activeForeground.value.streamId = streamId;
        const pending = handle?._pendingPromise || handle?.pendingPromise
          || backend.activeStreams?.get?.(streamId)?._pendingPromise;
        if (pending && typeof pending.then === 'function') {
          Promise.resolve(pending).then(() => releaseForeground(streamId, 'terminal'))
            .catch(() => releaseForeground(streamId, 'error'));
        }
        assertPostAwaitAuthority(command, context);
        if (!streamId) return hostFailure('unavailable', 'stream_admission_failed', command.request_id, true);
        const revision = bumpRevision(command.session_id);
        publish('session_changed', { session_id: command.session_id, revision, reason: 'chat_started' });
        return { ok: true, accepted: true, session_id: command.session_id, stream_id: streamId,
          revision };
      } catch (error) {
        if (!admittedStreamId) releaseForeground('', 'admission_failed');
        if (error.indeterminate) throw error;
        return authorityFailure(error, command);
      }
    }).then((result) => {
      if (result?.ok === false && activeForeground.value?.requestKey === requestKey
        && !activeForeground.value.streamId) {
        releaseForeground('', 'admission_failed');
      }
      return result;
    });
  }

  async function cancelChat(command, context) {
    const prior = cancellations.find(command, context.deviceId);
    if (prior) {
      const authority = revisionAndLease(command, context, { expectedRevision: false });
      return authority || { ok: true, accepted: true, cancelled: true,
        stream_id: prior.streamId, awaiting_settlement: !prior.terminal };
    }
    const failure = mutationGuard(command, context); if (failure) return failure;
    return runReceipt(command, context, async () => {
      const queuedPrior = cancellations.find(command, context.deviceId);
      if (queuedPrior) {
        const authority = revisionAndLease(command, context, { expectedRevision: false });
        return authority || { ok: true, accepted: true, cancelled: true,
          stream_id: queuedPrior.streamId, awaiting_settlement: !queuedPrior.terminal };
      }
      assertMutationAuthority(command, context);
      const foreground = activeForeground.value;
      if (!foreground || foreground.sessionId !== command.session_id
        || foreground.streamId !== command.params.stream_id) {
        return hostFailure('forbidden', 'stream_session_mismatch', command.request_id);
      }
      const cancellation = cancellations.remember(command, context.deviceId);
      let cancelled;
      try { cancelled = backend.cancelChatStream?.(command.params.stream_id, 'host_command') === true; }
      catch (error) { cancellations.forget(cancellation); throw error; }
      assertPostAwaitAuthority(command, context);
      if (!cancelled && !cancellation.terminal) {
        cancellations.forget(cancellation);
        return hostFailure('conflict', 'stream_not_found', command.request_id);
      }
      return { ok: true, accepted: true, cancelled: true, stream_id: cancellation.streamId,
        awaiting_settlement: !cancellation.terminal };
    });
  }

  async function decision(command, context) {
    const failure = mutationGuard(command, context); if (failure) return failure;
    return runReceipt(command, context, async () => {
      assertMutationAuthority(command, context);
      let result;
      if (command.operation === 'approval.resolve') {
        result = decisionAdapter.resolveApproval({ sessionId: command.session_id, streamId: command.params.stream_id,
          approvalId: command.params.approval_id, decisionRevision: command.params.decision_revision,
          approved: command.params.approved });
      } else if (command.operation === 'questions.answer') {
        result = decisionAdapter.answerQuestions({ sessionId: command.session_id, streamId: command.params.stream_id,
          questionRef: command.params.question_ref, answers: command.params.answers });
      } else if (command.operation === 'questions.decline') {
        result = decisionAdapter.declineQuestions({ sessionId: command.session_id, streamId: command.params.stream_id,
          questionRef: command.params.question_ref });
      }
      assertPostAwaitAuthority(command, context);
      if (!result?.ok) return hostFailure('conflict', result?.reason || 'decision_stale', command.request_id);
      const revision = bumpRevision(command.session_id);
      publish('session_changed', { session_id: command.session_id, revision, reason: 'decision' });
      publish('decision_changed', {
        session_id: command.session_id,
        stream_id: command.params.stream_id,
        ...(command.operation === 'approval.resolve'
          ? { approval_id: command.params.approval_id }
          : { question_ref: command.params.question_ref }),
      });
      return { ...result, revision };
    });
  }

  async function dispatch(rawCommand, context = {}) {
    const checked = validateCommand(rawCommand);
    if (!checked.ok) return hostFailure('invalid', checked.reason, rawCommand?.request_id);
    const command = checked.value;
    const authFailure = identity(command, context);
    if (authFailure) return authFailure;
    try {
      // A committed exact retry returns its durable receipt even after its own
      // mutation advanced the revision. New work still checks the live lease.
      if (LEASE_OPERATIONS.has(command.operation) || command.operation === 'sessions.create') {
        const previous = receipts.lookup(command, context.deviceId);
        if (previous.found) return previous.result;
      }
      if (['sessions.create', 'sessions.rename', 'sessions.delete', 'chat.send'].includes(command.operation)
        && !canAdmit()) return hostFailure('unavailable', 'disk_pressure', command.request_id, true);
      switch (command.operation) {
        case 'sessions.list': return listSessions(command);
        case 'requests.status': return receipts.status(command.params.request_id, context.deviceId);
        case 'sessions.create': return createSession(command, context);
        case 'sessions.snapshot': return snapshot(command, command.params);
        case 'control.acquire': return controlAcquire(command, context);
        case 'control.heartbeat': return controlHeartbeat(command, context);
        case 'control.release': return controlRelease(command, context);
        case 'sessions.rename': return renameSession(command, context);
        case 'sessions.preferences': return setPreferences(command, context);
        case 'sessions.delete': return deleteSession(command, context);
        case 'chat.send': return sendChat(command, context);
        case 'chat.cancel': return cancelChat(command, context);
        case 'approval.resolve':
        case 'questions.answer':
        case 'questions.decline': return decision(command, context);
        default: return hostFailure('invalid', 'unsupported_operation', command.request_id);
      }
    } catch (_error) {
      return hostFailure('unavailable', 'router_dispatch_failed', command.request_id);
    }
  }

  function getSnapshot(sessionId, options = {}) {
    const value = buildSessionSnapshot({ backend, eventStream, decisionAdapter, sessionId,
      revision: currentRevision(sessionId), options: { ...options, boot_epoch: bootEpoch } });
    if (!value) return null;
    value.control = leases.get(sessionId);
    return value;
  }

  function dispose() {
    if (disposed.value) return;
    disposed.value = true;
    if (typeof backend.off === 'function') {
      for (const [type, listener] of listeners) backend.off(type, listener);
    }
    // A browser disconnect must not cancel the backend stream. Dropping the
    // admission marker is sufficient for this router instance's disposal.
    activeForeground.value = null;
    cancellations.clear();
  }

  return Object.freeze({ dispatch, snapshot: getSnapshot, dispose });
}

module.exports = { createCommandRouter };
