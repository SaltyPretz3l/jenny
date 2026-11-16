'use strict';

const { validateCommand, hostFailure } = require('./api-contract');
const { createAccessCheck, createIdentityCheck } = require('./command-router-identity');
const { createControlHandlers } = require('./command-router-control');
const { createDecisionHandlers } = require('./command-router-decisions');
const { createSessionList } = require('./command-router-session-list');
const { createDecisionAdapter } = require('./decision-adapter');
const { CancellationRegistry, SessionMutationQueue } = require('./command-router-concurrency');
const { buildSessionSnapshot } = require('./session-snapshots');
const { memberAuthor } = require('../services/backend/message-author');
const { preferencesFor } = require('./command-router-preferences');
const {
  PROJECT_LEASE_OPERATIONS, PROJECT_MUTATIONS, PROJECT_OPERATIONS,
  createProjectCommandDispatcher,
} = require('../services/host/project-commands');

const { RUNTIME_LEASE_OPERATIONS, RUNTIME_GLOBAL_MUTATIONS, RUNTIME_OPERATIONS,
  createRuntimeCommandDispatcher, submissionKey } = require('../services/host/runtime-commands');
const { SUGGESTED_MUTATIONS, SUGGESTED_OPERATIONS,
  createSuggestedChangesCommandDispatcher } = require('../services/host/suggested-changes-commands');

const LEASE_OPERATIONS = new Set([
  ...RUNTIME_LEASE_OPERATIONS,
  'sessions.rename', 'sessions.delete', 'sessions.preferences', 'chat.send',
  'chat.cancel', 'approval.resolve', 'questions.answer', 'questions.decline',
  ...PROJECT_LEASE_OPERATIONS, ...SUGGESTED_MUTATIONS,
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
  if (/^project_[A-Za-z0-9_-]{1,128}$/u.test(value.project_id || '')) {
    result.project_id = value.project_id;
  }
  return result;
}

function cleanupOutcome(value) {
  const errors = isRecord(value) && Array.isArray(value.cleanup_errors) ? value.cleanup_errors : [];
  return {
    cleanup_status: isRecord(value) && value.cleanup_status === 'degraded' ? 'degraded' : 'complete',
    cleanup_errors: errors.filter(isRecord).slice(0, 16)
      .map((entry) => ({ step: text(entry.step, 32), code: text(entry.code, 32) })),
  };
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
  backend, clients, leases, receipts, bootEpoch, eventStream, resolveAttachments, canAdmit = () => true,
  canAdmitDeletion = () => true, authorize, teamCommands = null, approvals = null,
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

  // Team commands exist only on a team host, which is built with its authorize function.
  if (teamCommands && typeof authorize !== 'function') {
    throw new TypeError('Command router team commands require an authorize function.');
  }

  const disposed = { value: false };
  const identity = createIdentityCheck({ clients, bootEpoch, disposed, authorize });
  // Slice 3-2: the per-row check behind the list and runtime filters, through the same function.
  const allows = createAccessCheck({ authorize });
  const teamHost = typeof authorize === 'function';
  // Slice 3-5: a team host (built with `authorize`) names the actor as a user message's author (null, refused, without
  // a valid member id); the single-owner host's constant owner actor is never an author.
  const trustedAuthor = teamHost ? (context) => memberAuthor(context?.actor?.member_id) : () => undefined;
  const decisionAdapter = createDecisionAdapter({ backend });
  const revisions = new Map();
  const mutationQueue = new SessionMutationQueue({ capacity: MAX_SESSIONS });
  const projectMutationQueue = new SessionMutationQueue({ capacity: 1 });
  const cancellations = new CancellationRegistry();
  let creatingSession = false;
  const listeners = [];
  const projectDispatcher = createProjectCommandDispatcher({
    applicationService: backend.projectApplicationService,
    authorization: { identity, allows, mutationGuard, assertMutationAuthority, assertPostAwaitAuthority },
    transaction: { runReceipt },
    result: { safeSession, bumpRevision, publish, captureScope: (id) => eventStream.captureScope?.(id) },
    // Slice 3-9: a team host's list rows carry the caller's stored role and no host path.
    team: { teamHost, listExtras: teamCommands?.projectListExtras ?? null },
  });

  const runtimeDispatcher = createRuntimeCommandDispatcher({
    applicationService: backend.runtimeApplicationService,
    authorization: { identity, allows, teamHost, mutationGuard, assertMutationAuthority, assertPostAwaitAuthority,
      assertPostAwaitIdentity, trustedAuthor },
    transaction: { runReceipt }, result: { bumpRevision, publish, trustedChatOptions },
  });
  const suggestedDispatcher = createSuggestedChangesCommandDispatcher({ getService: () => backend.suggestedChanges || null,
    authorization: { identity, mutationGuard, assertMutationAuthority, assertPostAwaitAuthority },
    transaction: { runReceipt }, result: { bumpRevision, publish } });

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

  function publish(type, payload = {}, options = undefined) {
    // Best effort; a refused audience is dropped here, never retried as a broadcast.
    try { eventStream.publish(type, payload, options); } catch (_error) { /* transport is best effort */ }
  }

  function onBackendStream(event) {
    const sessionId = text(event?.sessionId, 128);
    const streamId = text(event?.streamId, 128);
    const type = text(event?.type, 80).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    if (!sessionId || !streamId || !type) return;
    if (TERMINAL_STREAM_TYPES.has(type)) {
      cancellations.markTerminal(sessionId, streamId);
      bumpRevision(sessionId);
    }
  }

  // BackendEvents owns canonical chat DTO publication and live projection.
  // The router observes only identity and terminal status for revision fences
  // only; it never republishes provider payloads.
  if (typeof backend.on === 'function') {
    backend.on('chat-stream', onBackendStream);
    listeners.push(['chat-stream', onBackendStream]);
  }

  function revisionAndLease(command, context, { expectedRevision = true, requireSession = true, recheck = true } = {}) {
    const authFailure = recheck ? identity(command, context) : null;
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

  function mutationGuard(command, context) { return revisionAndLease(command, context); }

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
        if (LEASE_OPERATIONS.has(command.operation)) {
          return await mutationQueue.run(command.session_id, execute);
        }
        return (PROJECT_MUTATIONS.has(command.operation) || RUNTIME_GLOBAL_MUTATIONS.has(command.operation))
          ? await projectMutationQueue.run('project_registry', execute)
          : await execute();
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

  const listSessions = createSessionList({ backend, identity, allows, safeSession, safeBackendError });
  const control = createControlHandlers({ leases, identity, allows, teamHost, trustedAuthor, backend, hasSession, publish });
  // Slice 3-6b. The existence check of the decisions and `session.view` is cache-neutral (no transcript load).
  const sessionExists = (id) => (typeof backend.sessionStore?.peekSessionSummary === 'function'
    ? backend.sessionStore.peekSessionSummary(id) != null : hasSession(id));
  const decisions = createDecisionHandlers({ decisionAdapter, identity, teamHost, approvals, trustedAuthor, mutationGuard,
    runReceipt, assertMutationAuthority, assertPostAwaitAuthority, sessionExists, bumpRevision, publish });
  // A team host's snapshot names each pending decision's prompter (the running turn's starter).
  const prompterOf = teamHost ? (approvals?.prompterOf ?? (() => null)) : undefined;

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
      const value = await backend.createSession({ title: command.params.title, projectId: command.params.project_id });
      assertPostAwaitIdentity(command, context);
      const session = safeSession(unwrapData(value));
      if (!session) return hostFailure('persistence', 'session_create_failed', command.request_id);
      const revision = bumpRevision(session.session_id);
      publish('session_changed', { session_id: session.session_id, revision, reason: 'created' });
      return { ok: true, session, revision };
      } finally { creatingSession = false; }
    });
  }

  async function snapshot(command, options = {}, context) {
    const value = buildSessionSnapshot({
      backend, eventStream, decisionAdapter, sessionId: command.session_id,
      revision: currentRevision(command.session_id),
      options: { ...options, boot_epoch: bootEpoch }, prompterOf,
    });
    if (!value) return hostFailure('conflict', 'session_not_found', command.request_id);
    if (value.ok === false) return hostFailure('invalid', value.reason, command.request_id);
    value.control = leases.get(command.session_id);
    decisions.noteSnapshot(command.session_id, context);
    return { ok: true, snapshot: value };
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
      const value = await backend.setSessionPreferences(command.session_id, preferencesFor(command, teamHost));
      assertPostAwaitAuthority(command, context);
      const session = safeSession(unwrapData(value));
      if (!session) return hostFailure('persistence', 'session_preferences_failed', command.request_id);
      const revision = bumpRevision(command.session_id);
      publish('session_changed', { session_id: command.session_id, revision, reason: 'preferences' });
      return { ok: true, session, revision };
    });
  }

  const sessionBusy = (id) => Boolean(backend.sessionTurnActors?.hasActiveLifecycle?.(id) || backend.sessionStore?.getActiveTurn?.(id));
  // Every conversation delete (also the team project delete, which holds no lease): null during a turn;
  // the scope is taken before the delete; `afterDelete` (the caller's post-await check) runs before the
  // revision entry is dropped and `session_changed` goes to that scope.
  async function removeSession(sessionId, afterDelete = () => {}) {
    if (sessionBusy(sessionId)) return null;
    const scope = eventStream.captureScope?.(sessionId); // the project, before the conversation is gone
    const value = await backend.deleteSession(sessionId);
    afterDelete();
    const deleted = value === true || value?.deleted === true;
    if (deleted) { revisions.delete(sessionId); publish('session_changed', { session_id: sessionId, state: 'deleted' }, scope); }
    return { deleted, cleanup: cleanupOutcome(value) };
  }

  async function deleteSession(command, context) {
    const failure = mutationGuard(command, context); if (failure) return failure;
    return runReceipt(command, context, async () => {
      assertMutationAuthority(command, context);
      // A committed delete keeps the lease check; identity would read the gone conversation as General (3-3 limit).
      const removed = await removeSession(command.session_id,
        () => assertPostAwaitAuthority(command, context, { requireSession: false, recheck: false }));
      if (!removed) return hostFailure('conflict', 'session_active', command.request_id);
      if (!removed.deleted) return hostFailure('persistence', 'session_delete_failed', command.request_id);
      return { ok: true, session_id: command.session_id, deleted: true, ...removed.cleanup };
    });
  }

  function trustedChatOptions(command) {
    const session = backend.sessionStore?.getSession?.(command.session_id) || {};
    return {
      preferredModel: text(backend.options?.modelEndpoint?.model || session.preferred_model || session.last_model_used, 240),
      reasoningEffort: text(session.reasoning_effort, 80),
      planMode: session.plan_mode === true,
      contextPreferences: isRecord(session.context_preferences) ? structuredClone(session.context_preferences) : undefined,
      ...(isRecord(session.tool_category_overrides) || isRecord(session.tool_connection_overrides) ? {
        toolPreferences: {
          ...(isRecord(session.tool_category_overrides) ? { families: structuredClone(session.tool_category_overrides) } : {}),
          ...(isRecord(session.tool_connection_overrides) ? { connections: structuredClone(session.tool_connection_overrides) } : {}),
        },
      } : {}),
      approvalMode: 'prompt',
    };
  }

  async function sendChat(command, context) {
    const failure = mutationGuard(command, context); if (failure) return failure;
    if (trustedAuthor(context) === null) return hostFailure('forbidden', 'member_author_required', command.request_id);
    return runReceipt(command, context, async () => {
      assertMutationAuthority(command, context);
      if (!backend.runtimeApplicationService?.submit) return hostFailure('unavailable', 'runtime_unavailable', command.request_id);
      const ids = command.params.attachment_ids || [];
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
      // Row 151 T5: a board id is accepted only by the team host's board hook, as (this conversation's project,
      // board id) for a sender who may read that project's boards. Any other host has no boards to send from.
      let board = null;
      if (command.params.board_id !== undefined) {
        board = typeof teamCommands?.admitChatBoard === 'function' ? await teamCommands.admitChatBoard(command, context) : null;
        if (board?.ok !== true) return hostFailure('forbidden', board?.error?.reason ?? 'team_board_not_found', command.request_id);
        assertMutationAuthority(command, context);
      }
      const options = trustedChatOptions(command);
      const saved = await backend.runtimeApplicationService.submit({
        session_id: command.session_id, prompt: command.params.prompt, visible_prompt: command.params.prompt,
        ...(board ? { board_id: board.boardId } : {}),
        idempotency_key: submissionKey(context.deviceId, command.request_id), attachments,
        preferred_model: options.preferredModel, reasoning_effort: options.reasoningEffort,
        plan_mode: options.planMode, context_preferences: options.contextPreferences,
        tool_preferences: options.toolPreferences, approval_mode: options.approvalMode,
      }, { beforeCommit: () => assertMutationAuthority(command, context), author: trustedAuthor(context) });
      assertPostAwaitAuthority(command, context);
      if (!saved?.ok) return hostFailure(saved?.error?.reason === 'idempotency_conflict' ? 'conflict' : 'unavailable',
        saved?.error?.reason || 'runtime_submission_refused', command.request_id);
      const revision = bumpRevision(command.session_id);
      publish('session_changed', { session_id: command.session_id, revision, reason: 'chat_saved' });
      return { ok: true, accepted: true, durable: true, session_id: saved.session_id,
        work_id: saved.work_id, turn_id: saved.turn_id, work_revision: saved.revision, status: saved.status, revision };
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
      const activeTurn = backend.sessionStore?.getActiveTurn?.(command.session_id);
      if (!activeTurn || (activeTurn.stream_id || activeTurn.request_id) !== command.params.stream_id
        || !backend.activeStreams?.has(command.params.stream_id)) {
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

  async function dispatch(rawCommand, context = {}) {
    const checked = validateCommand(rawCommand);
    if (!checked.ok) return hostFailure('invalid', checked.reason, rawCommand?.request_id);
    const command = checked.value;
    const authFailure = identity(command, context);
    if (authFailure) return authFailure;
    try {
      if (teamCommands && command.operation.startsWith('team.')) {
        return await teamCommands.dispatch(command, context, { runReceipt, canAdmit, publish });
      }
      // A committed exact retry returns its durable receipt even after its own
      // mutation advanced the revision. New work still checks the live lease.
      if (LEASE_OPERATIONS.has(command.operation) || PROJECT_MUTATIONS.has(command.operation)
        || RUNTIME_GLOBAL_MUTATIONS.has(command.operation) || command.operation === 'sessions.create') {
        const previous = receipts.lookup(command, context.deviceId);
        if (previous.found) return previous.result;
      }
      if (['sessions.create', 'sessions.rename', 'chat.send',
        'projects.create', 'projects.rename', 'projects.bindRoot',
        'projects.assignSession', 'permissionReview.resolve', 'sessionRuntime.start',
        'sessionRuntime.updatePending', 'sessionRuntime.updateLimits'].includes(command.operation)
        && !canAdmit()) return hostFailure('unavailable', 'disk_pressure', command.request_id, true);
      if (command.operation === 'sessions.delete' && !canAdmitDeletion()) {
        return hostFailure('unavailable', 'disk_pressure', command.request_id, true);
      }
      if (RUNTIME_OPERATIONS.has(command.operation)) return runtimeDispatcher.dispatch(command, context);
      if (PROJECT_OPERATIONS.has(command.operation)) return projectDispatcher.dispatch(command, context);
      if (SUGGESTED_OPERATIONS.has(command.operation)) return suggestedDispatcher.dispatch(command, context);
      switch (command.operation) {
        case 'sessions.list': return listSessions(command, context);
        case 'requests.status': return receipts.status(command.params.request_id, context.deviceId);
        case 'sessions.create': return createSession(command, context);
        case 'sessions.snapshot': return snapshot(command, command.params, context);
        case 'session.view': return decisions.view(command, context);
        case 'control.acquire': return control.acquire(command, context);
        case 'control.heartbeat': return control.heartbeat(command, context);
        case 'control.release': return control.release(command, context);
        case 'sessions.rename': return renameSession(command, context);
        case 'sessions.preferences': return setPreferences(command, context);
        case 'sessions.delete': return deleteSession(command, context);
        case 'chat.send': return sendChat(command, context);
        case 'chat.cancel': return cancelChat(command, context);
        case 'approval.resolve':
        case 'questions.answer':
        case 'questions.decline': return decisions.decision(command, context);
        default: return hostFailure('invalid', 'unsupported_operation', command.request_id);
      }
    } catch (_error) {
      return hostFailure('unavailable', 'router_dispatch_failed', command.request_id);
    }
  }

  function getSnapshot(sessionId, options = {}) {
    const value = buildSessionSnapshot({ backend, eventStream, decisionAdapter, sessionId,
      revision: currentRevision(sessionId), options: { ...options, boot_epoch: bootEpoch }, prompterOf });
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
    // A browser disconnect never cancels accepted durable work.
    cancellations.clear();
  }

  // The team project delete (no lease): an index-only busy read for its pre-check, the admission
  // `sessions.delete` passes, and each delete inside that conversation's mutation queue (never queued twice).
  const projectDeletes = Object.freeze({ admit: () => Boolean(canAdmitDeletion()), remove: (id) => mutationQueue.run(id, () => removeSession(id)),
    busy: (id) => Boolean(backend.sessionTurnActors?.hasActiveLifecycle?.(id) || backend.sessionStore?.peekActiveTurn?.(id)) });
  return Object.freeze({ dispatch, snapshot: getSnapshot, dispose, projectDeletes });
}

module.exports = { createCommandRouter };
