'use strict';

const { createHash } = require('node:crypto');
const { hostFailure } = require('../../server/api-contract');
const RUNTIME_LEASE_OPERATIONS = new Set(['sessionRuntime.start', 'sessionRuntime.pause',
  'sessionRuntime.resume', 'sessionRuntime.cancel', 'sessionRuntime.updatePending']);
const RUNTIME_GLOBAL_MUTATIONS = new Set(['sessionRuntime.updateLimits']);
const RUNTIME_OPERATIONS = new Set([...RUNTIME_LEASE_OPERATIONS, ...RUNTIME_GLOBAL_MUTATIONS,
  'sessionRuntime.getSnapshot', 'sessionRuntime.getWork', 'sessionRuntime.getResult']);

function submissionKey(deviceId, requestId) {
  return `host_${createHash('sha256').update(JSON.stringify([deviceId, requestId])).digest('hex')}`;
}
function applicationFailure(value, command) {
  const reason = value?.error?.reason || 'runtime_unavailable';
  return hostFailure(reason.endsWith('_invalid') ? 'invalid' : reason.endsWith('_forbidden') ? 'forbidden'
    : /stale|conflict|not_found/.test(reason) ? 'conflict' : 'unavailable', reason, command.request_id);
}
function createRuntimeCommandDispatcher({ applicationService: app, authorization, transaction, result } = {}) {
  // Slice 3-2: `allows` is the router's per-row check through the one authorize
  // function (a dispatcher built without it sees nothing); `teamHost` turns on
  // the read-path filters, which the single-owner host never runs.
  const { identity, mutationGuard, assertMutationAuthority, assertPostAwaitAuthority, assertPostAwaitIdentity,
    trustedAuthor = () => undefined, allows = () => false, teamHost = false } = authorization;
  const { runReceipt } = transaction;
  const { bumpRevision, publish, trustedChatOptions } = result;
  const sees = (command, context, sessionId) => allows(command, context, 'session.read',
    { kind: 'session', id: typeof sessionId === 'string' ? sessionId : '' });
  // Client-chosen scope ids in a snapshot request are checked like any other id.
  function snapshotScopeFailure(command, context) {
    const { session_id: sessionId, project_id: projectId } = command.params || {};
    if ((sessionId !== undefined && !sees(command, context, sessionId)) || (projectId !== undefined
      && !allows(command, context, 'project.read', { kind: 'project', id: typeof projectId === 'string' ? projectId : '' }))) {
      return hostFailure('forbidden', 'team_not_found', command.request_id);
    }
    return null;
  }
  // Team host: no id, title, count or state from work the caller cannot see. The
  // lane and resource counts are host-wide, so they go; an unscoped cursor's
  // offset and a Runs row's queue position count hidden rows, so they go.
  // `truncated` passes through: hidden rows may have used the window.
  function scopeSnapshot(value, command, context) {
    const rows = Array.isArray(value.work) ? value.work : [];
    const work = rows.filter((row) => sees(command, context, row?.session_id)).map((row) => {
      const blocking = row.admission_wait?.blocking_session_id;
      const shown = blocking && !sees(command, context, blocking)
        ? { ...row, admission_wait: { ...row.admission_wait, blocking_session_id: null } } : row;
      return Object.hasOwn(shown, 'queue_position') ? { ...shown, queue_position: null } : shown;
    });
    const scoped = typeof command.params?.session_id === 'string';
    return { ...value, lanes: { ...value.lanes, counts: null }, resources: { ...value.resources, counts: null }, work,
      next_cursor: scoped ? value.next_cursor ?? null : null };
  }
  // getWork and getResult: the work is read once and shared. On a team host,
  // work in a conversation the caller cannot see answers exactly as the runtime
  // answers work that does not exist.
  function inspectWork(method, command, context) {
    const detail = teamHost || command.session_id ? app.getWork({ work_id: command.params.work_id }) : null;
    if (teamHost && !sees(command, context, detail?.work?.session_id)) {
      return { ok: false, error: { reason: method === 'getWork' ? 'runtime_work_not_found' : 'runtime_result_unavailable' } };
    }
    if (command.session_id) ownedWork(command, detail);
    const sameRead = method === 'getWork' && detail && Object.keys(command.params).length === 1;
    return sameRead ? detail : app[method](command.params);
  }
  function ownedWork(command, detail = app.getWork({ work_id: command.params.work_id })) {
    if (detail?.work?.session_id !== command.session_id) {
      const error = new Error('runtime_work_session_mismatch');
      error.routerFailure = hostFailure('forbidden', 'runtime_work_session_mismatch', command.request_id);
      throw error;
    }
  }
  async function dispatch(command, context) {
    const authFailure = identity(command, context);
    if (authFailure) return authFailure;
    if (!app) return hostFailure('unavailable', 'runtime_unavailable', command.request_id);
    const method = command.operation.slice('sessionRuntime.'.length);
    if (!RUNTIME_LEASE_OPERATIONS.has(command.operation) && !RUNTIME_GLOBAL_MUTATIONS.has(command.operation)) {
      try {
        if (method === 'getSnapshot') {
          const hidden = snapshotScopeFailure(command, context);
          if (hidden) return hidden;
        }
        const value = method === 'getSnapshot' ? app.getSnapshot(command.params) : inspectWork(method, command, context);
        if (!value?.ok) return applicationFailure(value, command);
        return { ok: true, runtime: teamHost && method === 'getSnapshot' ? scopeSnapshot(value, command, context) : value };
      } catch (error) {
        return error.routerFailure || hostFailure('unavailable', 'runtime_inspection_unavailable', command.request_id);
      }
    }
    const global = RUNTIME_GLOBAL_MUTATIONS.has(command.operation);
    const initial = global ? identity(command, context) : mutationGuard(command, context);
    if (initial) return initial;
    // Slice 3-5: a team actor with no valid member id cannot start a turn (its words would have no author).
    if (method === 'start' && trustedAuthor(context) === null) return hostFailure('forbidden', 'member_author_required', command.request_id);
    return runReceipt(command, context, async () => {
      const beforeCommit = () => {
        if (global) {
          const failure = identity(command, context);
          if (failure) throw Object.assign(new Error(failure.error.reason), { routerFailure: failure });
        } else {
          assertMutationAuthority(command, context);
          if (method !== 'start') ownedWork(command);
        }
      };
      beforeCommit();
      let params = command.params;
      if (method === 'start') {
        const options = trustedChatOptions(command);
        params = { ...params, session_id: command.session_id,
          idempotency_key: submissionKey(context.deviceId, command.request_id),
          preferred_model: options.preferredModel, reasoning_effort: options.reasoningEffort,
          plan_mode: options.planMode, context_preferences: options.contextPreferences,
          tool_preferences: options.toolPreferences, approval_mode: options.approvalMode };
      }
      // Slice 3-5: the author (start) or editor (updatePending) is a trusted option from the actor, never a params field.
      const authored = method === 'start' || method === 'updatePending';
      const value = await app[method](params, { beforeCommit, ...(authored ? { author: trustedAuthor(context) } : {}) });
      if (!global) assertPostAwaitAuthority(command, context);
      else assertPostAwaitIdentity(command, context);
      if (!value?.ok) return applicationFailure(value, command);
      if (global) return { ok: true, runtime: value };
      const revision = bumpRevision(command.session_id);
      publish('session_changed', { session_id: command.session_id, revision, reason: 'runtime_changed' });
      return { ok: true, runtime: value, revision };
    });
  }
  return Object.freeze({ dispatch });
}
module.exports = { RUNTIME_LEASE_OPERATIONS, RUNTIME_GLOBAL_MUTATIONS, RUNTIME_OPERATIONS,
  createRuntimeCommandDispatcher, submissionKey };
