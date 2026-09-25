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
  return hostFailure(reason.endsWith('_invalid') ? 'invalid'
    : /stale|conflict|not_found/.test(reason) ? 'conflict' : 'unavailable', reason, command.request_id);
}
function createRuntimeCommandDispatcher({ applicationService: app, authorization, transaction, result } = {}) {
  const { identity, mutationGuard, assertMutationAuthority, assertPostAwaitAuthority, assertPostAwaitIdentity } = authorization;
  const { runReceipt } = transaction;
  const { bumpRevision, publish, trustedChatOptions } = result;
  function ownedWork(command) {
    const detail = app.getWork({ work_id: command.params.work_id });
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
        if (method !== 'getSnapshot' && command.session_id) ownedWork(command);
        const value = app[method](command.params);
        return value?.ok ? { ok: true, runtime: value } : applicationFailure(value, command);
      } catch (error) {
        return error.routerFailure || hostFailure('unavailable', 'runtime_inspection_unavailable', command.request_id);
      }
    }
    const global = RUNTIME_GLOBAL_MUTATIONS.has(command.operation);
    const initial = global ? identity(command, context) : mutationGuard(command, context);
    if (initial) return initial;
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
      const value = await app[method](params, { beforeCommit });
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
