'use strict';

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const {
  normalizeComparablePath,
} = require('../../worktree-path-policy');
const {
  getToolsWorkspaceRoot,
  getWorkspaceRootCoordinator,
  getWorkspaceRootTransitionBroker,
  transitionToolsWorkspaceRoot,
} = require('./worktree-root-config');
const { normalizeString } = require('../../shared/normalize');

function serviceUnavailable() {
  return {
    content: 'Worktree service is unavailable.',
    summary: 'Worktree delete unavailable',
    isError: true,
    errorCode: TOOL_ERROR_CODES.DISABLED,
    metadata: {
      result_kind: 'worktree_delete',
      reason: 'unavailable',
    },
  };
}

module.exports = {
  name: 'worktree_delete',
  description: 'Delete a clean registry-owned Git worktree, refusing dirty or path-ambiguous targets.',
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
    return `Delete worktree ${normalizeString(input?.worktree_id || input?.worktreeId)}`.trim();
  },

  async execute(input, context) {
    if (!context.worktreeService || typeof context.worktreeService.deleteWorktree !== 'function') {
      return serviceUnavailable();
    }
    const configService = context.configService || context.backendService?.configService || null;
    const workspaceRootCoordinator = getWorkspaceRootCoordinator(context);
    const workspaceRootTransitionBroker = getWorkspaceRootTransitionBroker(context);
    if (!workspaceRootCoordinator || !workspaceRootTransitionBroker) {
      return serviceUnavailable();
    }
    const activeRoot = getToolsWorkspaceRoot(configService, workspaceRootCoordinator);
    const worktreeId = normalizeString(input?.worktree_id || input?.worktreeId);
    const request = {
      workspaceRoot: context.workingDirectory,
      worktreeId,
    };
    if (context.abortSignal) {
      request.signal = context.abortSignal;
    }
    let clearedBeforeDelete = false;
    if (typeof context.worktreeService.resolveSelectableWorktree === 'function') {
      const resolved = await context.worktreeService.resolveSelectableWorktree(request);
      const resolvedComparable = resolved?.success
        ? normalizeComparablePath(normalizeString(resolved.worktree_path))
        : '';
      if (
        activeRoot
        &&
        resolvedComparable
        && normalizeComparablePath(activeRoot) === resolvedComparable
      ) {
        const clearTransition = await transitionToolsWorkspaceRoot(
          workspaceRootCoordinator,
          workspaceRootTransitionBroker,
          '',
          { mode: 'worktree_delete_clear', signal: context.abortSignal || null }
        );
        if (clearTransition?.committed !== true) {
          return {
            content: 'Active worktree deletion was blocked before filesystem mutation.',
            summary: 'Worktree delete blocked',
            isError: true,
            errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
            metadata: {
              result_kind: 'worktree_delete',
              reason: clearTransition?.code || 'root_transition_failed',
              active_root_unchanged: true,
              blockers: clearTransition?.blockers || undefined,
            },
          };
        }
        clearedBeforeDelete = clearTransition.changed === true;
      }
    }

    const result = await context.worktreeService.deleteWorktree(request);
    if (!result.success) {
      const restored = clearedBeforeDelete
        ? await transitionToolsWorkspaceRoot(
          workspaceRootCoordinator,
          workspaceRootTransitionBroker,
          activeRoot,
          { mode: 'worktree_delete_restore' }
        )
        : null;
      return {
        content: result.message || 'Worktree delete failed.',
        summary: 'Worktree delete failed',
        isError: true,
        errorCode: result.error_code || TOOL_ERROR_CODES.EXECUTION_FAILED,
        metadata: {
          result_kind: 'worktree_delete',
          reason: result.reason || 'execution_failed',
          dirty_summary: result.dirty_summary || undefined,
          rollback: result.rollback || undefined,
          active_root_unchanged: !clearedBeforeDelete || restored?.committed === true,
          active_root_rollback_failed:
            clearedBeforeDelete && restored?.committed !== true ? true : undefined,
        },
      };
    }
    const worktree = result.worktree || {};
    const status = result.status || 'deleted';
    const deletedRoot = normalizeString(worktree.worktree_path);
    const activeRootComparable = activeRoot ? normalizeComparablePath(activeRoot) : '';
    const deletedRootComparable = deletedRoot ? normalizeComparablePath(deletedRoot) : '';
    const deletedActiveRoot = Boolean(
      activeRootComparable
      && deletedRootComparable
      && activeRootComparable === deletedRootComparable
    );
    let activeRootCleared = clearedBeforeDelete;
    let activeRootClearFailed = false;
    if (deletedActiveRoot) {
      try {
        const clearTransition = await transitionToolsWorkspaceRoot(
          workspaceRootCoordinator,
          workspaceRootTransitionBroker,
          '',
          { mode: 'worktree_delete_clear', signal: context.abortSignal || null }
        );
        activeRootCleared = clearTransition?.committed === true;
        activeRootClearFailed = !activeRootCleared;
      } catch (error) {
        activeRootClearFailed = true;
        context.logger?.('WARN', 'worktree.delete_active_root_clear_failed', {
          message: error?.message || String(error),
        });
      }
    }
    let activeRootNote = '';
    if (activeRootClearFailed) {
      activeRootNote = ' Active workspace root could not be cleared.';
    } else if (activeRootCleared) {
      activeRootNote = ' Active workspace root was cleared.';
    }
    let summary = 'Deleted worktree';
    if (status === 'pruned_missing') {
      summary = 'Pruned missing worktree';
    }
    return {
      content: status === 'pruned_missing'
        ? `Pruned missing worktree registry entry "${worktree.id || ''}".${activeRootNote}`
        : `Deleted worktree "${worktree.branch || worktree.id || ''}".${activeRootNote}`,
      summary,
      isError: false,
      metadata: {
        result_kind: 'worktree_delete',
        status,
        reason: result.reason || '',
        registry_persisted: result.registry_persisted === true,
        active_root_cleared: activeRootCleared,
        active_root_clear_failed: activeRootClearFailed || undefined,
        rollback: result.rollback || undefined,
        worktree,
      },
    };
  },
};
