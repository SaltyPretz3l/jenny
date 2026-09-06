'use strict';

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const {
  getToolsWorkspaceRoot,
  getWorkspaceRootCoordinator,
  getWorkspaceRootTransitionBroker,
  transitionToolsWorkspaceRoot,
} = require('./worktree-root-config');
const { normalizeString } = require('../../shared/normalize');
const { normalizeComparablePath } = require('../../worktree-path-policy');

function serviceUnavailable(message = 'Worktree select is unavailable.') {
  return {
    content: message,
    summary: 'Worktree select unavailable',
    isError: true,
    errorCode: TOOL_ERROR_CODES.DISABLED,
    metadata: {
      result_kind: 'worktree_select',
      status: 'failed',
      reason: 'unavailable',
    },
  };
}

module.exports = {
  name: 'worktree_select',
  description: 'Select a registered Git worktree as the active tools workspace root after validation.',
  category: 'builtin',
  readOnly: false,
  workspaceRequired: true,
  parameters: {
    type: 'object',
    properties: {
      worktree_id: {
        type: 'string',
        description: 'Registry id returned by worktree_list or worktree_create.',
      },
    },
    required: ['worktree_id'],
  },

  summarize(input) {
    return `Select worktree ${normalizeString(input?.worktree_id || input?.worktreeId)}`.trim();
  },

  async execute(input, context) {
    if (
      !context.worktreeService
      || typeof context.worktreeService.resolveSelectableWorktree !== 'function'
    ) {
      return serviceUnavailable('Worktree service is unavailable.');
    }
    const configService = context.configService || context.backendService?.configService || null;
    const workspaceRootCoordinator = getWorkspaceRootCoordinator(context);
    const workspaceRootTransitionBroker = getWorkspaceRootTransitionBroker(context);
    if (!workspaceRootCoordinator || !workspaceRootTransitionBroker) {
      return serviceUnavailable('Transactional workspace root switching is unavailable.');
    }

    const worktreeId = normalizeString(input?.worktree_id || input?.worktreeId);
    const request = {
      workspaceRoot: context.workingDirectory,
      worktreeId,
    };
    if (context.abortSignal) {
      request.signal = context.abortSignal;
    }
    const selected = await context.worktreeService.resolveSelectableWorktree(request);
    if (!selected.success) {
      return {
        content: selected.message || 'Worktree select failed.',
        summary: 'Worktree select failed',
        isError: true,
        errorCode: selected.error_code || TOOL_ERROR_CODES.EXECUTION_FAILED,
        metadata: {
          result_kind: 'worktree_select',
          status: 'failed',
          reason: selected.reason || 'execution_failed',
          active_root_unchanged: true,
        },
      };
    }

    const previousRoot = getToolsWorkspaceRoot(configService, workspaceRootCoordinator);
    const nextRoot = normalizeString(selected.worktree_path);
    const transition = await transitionToolsWorkspaceRoot(
      workspaceRootCoordinator,
      workspaceRootTransitionBroker,
      nextRoot,
      { mode: 'worktree_select', signal: context.abortSignal || null }
    );
    if (transition?.committed !== true) {
      return {
        content: transition?.rolledBack === true
          ? 'Worktree select failed; active workspace root was restored.'
          : 'Worktree select was blocked before the active workspace root changed.',
        summary: 'Worktree select failed',
        isError: true,
        errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
        metadata: {
          result_kind: 'worktree_select',
          status: 'failed',
          reason: transition?.code || 'root_transition_failed',
          active_root_unchanged: transition?.changed !== true,
          active_root_rollback_failed: transition?.rollbackIncomplete === true || undefined,
          blockers: transition?.blockers || undefined,
        },
      };
    }

    const activeRootChanged = transition?.noop === true
      ? false
      : typeof transition?.changed === 'boolean'
        ? transition.changed
        : normalizeComparablePath(previousRoot) !== normalizeComparablePath(nextRoot);

    return {
      content: `Selected worktree "${selected.worktree?.branch || selected.worktree?.id || worktreeId}".`,
      summary: 'Selected worktree',
      isError: false,
      metadata: {
        result_kind: 'worktree_select',
        status: 'selected',
        active_root_changed: activeRootChanged,
        worktree: selected.worktree,
      },
    };
  },
};
