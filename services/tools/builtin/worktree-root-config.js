'use strict';

const { normalizeString } = require('../../shared/normalize');

function getWorkspaceRootCoordinator(context = {}) {
  const coordinator = context.workspaceRootCoordinator
    || context.backendService?.workspaceRootCoordinator
    || null;
  return coordinator
    && typeof coordinator.prepareTarget === 'function'
    && typeof coordinator.commit === 'function'
    ? coordinator
    : null;
}

function getWorkspaceRootTransitionBroker(context = {}) {
  const broker = context.workspaceRootTransitionBroker
    || context.backendService?.workspaceRootTransitionBroker
    || null;
  return broker && typeof broker.requestPreparedTransition === 'function' ? broker : null;
}

function getToolsWorkspaceRoot(configService, coordinator = null) {
  const coordinatedRoot = coordinator?.captureContext?.()?.rootPath;
  if (coordinatedRoot != null) return normalizeString(coordinatedRoot);
  if (!configService) return '';
  if (typeof configService.getToolsWorkspaceRoot === 'function') {
    return normalizeString(configService.getToolsWorkspaceRoot());
  }
  if (typeof configService.getState === 'function') {
    return normalizeString(configService.getState()?.toolsWorkspaceRoot);
  }
  return '';
}

async function transitionToolsWorkspaceRoot(
  coordinator,
  broker,
  rootPath,
  { mode = 'external', signal = null } = {}
) {
  if (!coordinator || !broker) {
    return {
      committed: false,
      changed: false,
      blocked: true,
      code: !coordinator
        ? 'workspace_root_coordinator_unavailable'
        : 'workspace_root_transition_broker_unavailable',
    };
  }
  let prepared;
  try {
    prepared = await coordinator.prepareTarget(normalizeString(rootPath));
  } catch (error) {
    return {
      committed: false,
      changed: false,
      blocked: true,
      code: String(error?.code || 'workspace_root_prepare_failed').slice(0, 80),
    };
  }
  if (prepared?.noop === true) {
    return { committed: true, changed: false, noop: true, context: prepared.context };
  }
  if (prepared?.prepared !== true || !prepared.transitionId) return prepared;
  let result;
  try {
    result = await broker.requestPreparedTransition({
      prepared,
      mode,
      signal,
    });
  } catch (error) {
    let cancelResult;
    try {
      cancelResult = await coordinator.cancel?.({ transitionId: prepared.transitionId }) ?? null;
    } catch (_cancelError) {
      cancelResult = null;
    }
    return {
      committed: false,
      changed: false,
      blocked: true,
      code: String(error?.code || 'external_transition_broker_failed').slice(0, 80),
      cancelResult,
      uncertain: cancelResult?.canceled !== true,
    };
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    let cancelResult;
    try {
      cancelResult = await coordinator.cancel?.({ transitionId: prepared.transitionId }) ?? null;
    } catch (_cancelError) {
      cancelResult = null;
    }
    return {
      committed: false,
      changed: false,
      blocked: true,
      code: 'external_transition_response_invalid',
      cancelResult,
      uncertain: cancelResult?.canceled !== true,
    };
  }
  return result;
}

module.exports = {
  getToolsWorkspaceRoot,
  getWorkspaceRootCoordinator,
  getWorkspaceRootTransitionBroker,
  transitionToolsWorkspaceRoot,
};
