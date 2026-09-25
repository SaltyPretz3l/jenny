'use strict';

const { hostFailure } = require('../../server/api-contract');
const { PROJECT_ERROR_CODES, TOOL_ERROR_CODES } = require('../backend/error-codes');

const PROJECT_LEASE_OPERATIONS = new Set(['projects.assignSession']);
const PROJECT_OPERATIONS = new Set([
  'projects.list', 'projects.create', 'projects.rename', 'projects.bindRoot',
  'projects.assignSession', 'permissionReview.getState', 'permissionReview.resolve',
]);
const PROJECT_MUTATIONS = new Set([
  'projects.create', 'projects.rename', 'projects.bindRoot',
  'projects.assignSession', 'permissionReview.resolve',
]);

function projectRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = typeof value.id === 'string' ? value.id : '';
  const name = typeof value.name === 'string' ? value.name : '';
  const rootPath = value.root_path;
  if (!/^project_[A-Za-z0-9_-]{1,128}$/u.test(id) || !name || name.length > 80
    || (rootPath !== null && (typeof rootPath !== 'string' || rootPath.length > 4096))
    || !Number.isSafeInteger(value.root_revision) || value.root_revision < 0) return null;
  return {
    id,
    name,
    root_path: rootPath,
    root_revision: value.root_revision,
    authority_key: /^authority_[a-f0-9]{64}$/u.test(value.authority_key || '')
      ? value.authority_key
      : '',
  };
}

function applicationFailure(result, requestId) {
  const error = result?.error || {};
  const reason = typeof error.reason === 'string' ? error.reason : 'project_service_unavailable';
  if (error.code === PROJECT_ERROR_CODES.INVALID || reason.endsWith('_invalid')) {
    return hostFailure('invalid', reason, requestId);
  }
  if (error.code === PROJECT_ERROR_CODES.NOT_FOUND || error.code === PROJECT_ERROR_CODES.STALE
    || reason.endsWith('_not_found') || reason.includes('stale')) {
    return hostFailure('conflict', reason, requestId, reason.includes('stale'));
  }
  if (error.code === TOOL_ERROR_CODES.EXECUTION_FAILED || reason.includes('persist') || reason.includes('store_')) {
    return hostFailure('persistence', reason, requestId);
  }
  return hostFailure('unavailable', reason, requestId, true);
}

function createProjectCommands({ applicationService } = {}) {
  function unavailable(requestId) {
    return hostFailure('unavailable', 'project_service_unavailable', requestId, true);
  }

  function execute(operation, params, { sessionId = '', requestId = '' } = {}) {
    if (!applicationService) return unavailable(requestId);
    let result;
    switch (operation) {
      case 'projects.list':
        result = applicationService.listProjects();
        if (!result?.ok) return applicationFailure(result, requestId);
        return {
          ok: true,
          projects: (result.projects || []).map(projectRow).filter(Boolean),
          storage: {
            read_only: result.storage?.read_only === true,
            reason: typeof result.storage?.reason === 'string' ? result.storage.reason.slice(0, 80) : null,
          },
        };
      case 'projects.create':
        result = applicationService.createProject(params);
        break;
      case 'projects.rename':
        result = applicationService.renameProject(params);
        break;
      case 'projects.bindRoot':
        result = applicationService.bindProjectRoot(params);
        break;
      case 'projects.assignSession':
        result = applicationService.assignSessionProject({
          session_id: sessionId,
          project_id: params.project_id,
        });
        break;
      case 'permissionReview.getState':
        result = applicationService.getPermissionReviewState();
        return result?.ok === false
          ? applicationFailure(result, requestId)
          : { ok: true, ...result };
      case 'permissionReview.resolve':
        result = applicationService.resolvePermissionReview(params);
        if (!result?.ok) return applicationFailure(result, requestId);
        return {
          ok: true,
          resolved: true,
          review_id: params.review_id,
          decision: params.decision,
        };
      default:
        return hostFailure('invalid', 'unsupported_operation', requestId);
    }
    if (!result?.ok) return applicationFailure(result, requestId);
    if (operation === 'projects.assignSession') {
      return { ok: true, session: result.session, unchanged: result.unchanged === true };
    }
    const project = projectRow(result.project);
    return project
      ? { ok: true, project, unchanged: result.unchanged === true }
      : hostFailure('unavailable', 'project_projection_invalid', requestId);
  }

  return Object.freeze({ execute });
}

function createProjectCommandDispatcher({
  applicationService,
  authorization = {},
  transaction = {},
  result = {},
} = {}) {
  const { identity, mutationGuard, assertMutationAuthority, assertPostAwaitAuthority } = authorization;
  const { runReceipt } = transaction;
  const { safeSession, bumpRevision, publish } = result;
  const commands = createProjectCommands({ applicationService });
  async function dispatch(command, context) {
    const initialAuthFailure = identity(command, context);
    if (initialAuthFailure) return initialAuthFailure;
    if (command.operation === 'projects.assignSession') {
      const failure = mutationGuard(command, context); if (failure) return failure;
      return runReceipt(command, context, async () => {
        assertMutationAuthority(command, context);
        const value = commands.execute(command.operation, command.params, {
          sessionId: command.session_id, requestId: command.request_id,
        });
        assertPostAwaitAuthority(command, context);
        if (!value?.ok) return value;
        const session = safeSession(value.session);
        if (!session) {
          return hostFailure('persistence', 'session_project_assignment_failed', command.request_id);
        }
        const revision = bumpRevision(command.session_id);
        publish('session_changed', {
          session_id: command.session_id, revision, reason: 'project_assigned',
        });
        return { ...value, session, revision };
      });
    }
    if (PROJECT_MUTATIONS.has(command.operation)) {
      return runReceipt(command, context, async () => {
        const currentAuthFailure = identity(command, context);
        if (currentAuthFailure) return currentAuthFailure;
        return commands.execute(command.operation, command.params, {
          requestId: command.request_id,
        });
      });
    }
    return commands.execute(command.operation, command.params, {
      requestId: command.request_id,
    });
  }
  return Object.freeze({ dispatch });
}

module.exports = {
  PROJECT_LEASE_OPERATIONS,
  PROJECT_MUTATIONS,
  PROJECT_OPERATIONS,
  createProjectCommandDispatcher,
  createProjectCommands,
  projectRow,
};
