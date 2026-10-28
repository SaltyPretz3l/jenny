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
const {
  invalidArguments,
  manifestSchema,
  readStringArgument,
  serviceUnavailable,
  summaryArgument,
} = require('./tool-result');

const RESULT_KIND = 'worktree_delete';
const LABEL = 'Worktree delete';
const MAX_WORKTREE_ID_CHARS = 128;
const BLOCKED_MESSAGE = 'Active worktree deletion was blocked before filesystem mutation.';

function comparable(value) {
  const text = normalizeString(value);
  return text ? normalizeComparablePath(text) : '';
}

function blockedResult(transition) {
  return {
    content: BLOCKED_MESSAGE,
    summary: 'Worktree delete blocked',
    isError: true,
    errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
    metadata: {
      result_kind: RESULT_KIND,
      reason: transition?.code || 'root_transition_failed',
      active_root_unchanged: true,
      blockers: transition?.blockers || undefined,
    },
  };
}

module.exports = {
  name: 'worktree_delete',
  ...manifestSchema('worktree_delete'),
  category: 'builtin',
  readOnly: false,
  workspaceRequired: true,

  summarize(input) {
    return `Delete worktree ${summaryArgument(input, 'worktree_id', MAX_WORKTREE_ID_CHARS)}`.trim();
  },

  async execute(input, context) {
    const unavailable = () => serviceUnavailable(RESULT_KIND, {
      label: LABEL,
      content: 'Worktree service is unavailable.',
    });
    if (!context.worktreeService || typeof context.worktreeService.deleteWorktree !== 'function') {
      return unavailable();
    }
    const configService = context.configService || context.backendService?.configService || null;
    const workspaceRootCoordinator = getWorkspaceRootCoordinator(context);
    const workspaceRootTransitionBroker = getWorkspaceRootTransitionBroker(context);
    if (!workspaceRootCoordinator || !workspaceRootTransitionBroker) {
      return unavailable();
    }
    const idArgument = readStringArgument(input, 'worktree_id', {
      required: true,
      maxLength: MAX_WORKTREE_ID_CHARS,
    });
    if (idArgument.error) {
      return invalidArguments(RESULT_KIND, { label: LABEL, content: idArgument.error });
    }
    const transitionRoot = (target, mode, signal) => transitionToolsWorkspaceRoot(
      workspaceRootCoordinator,
      workspaceRootTransitionBroker,
      target,
      { mode, signal }
    );
    const activeRoot = getToolsWorkspaceRoot(configService, workspaceRootCoordinator);
    const activeRootComparable = comparable(activeRoot);

    // The service calls this only after ownership, path-policy and dirty
    // checks pass, so a refusal never moves the active root at all.
    let beforeRemoveRan = false;
    let clearedBeforeDelete = false;
    let blockedTransition = null;
    const beforeRemove = async ({ worktree_path: worktreePath }) => {
      beforeRemoveRan = true;
      if (!activeRootComparable || comparable(worktreePath) !== activeRootComparable) {
        return { proceed: true };
      }
      const clearTransition = await transitionRoot(
        '',
        'worktree_delete_clear',
        context.abortSignal || null
      );
      if (clearTransition?.committed !== true) {
        blockedTransition = clearTransition || {};
        return {
          proceed: false,
          reason: clearTransition?.code || 'root_transition_failed',
          message: BLOCKED_MESSAGE,
        };
      }
      clearedBeforeDelete = clearTransition.changed === true;
      return { proceed: true };
    };

    const request = {
      workspaceRoot: context.workingDirectory,
      worktreeId: idArgument.value,
      beforeRemove,
    };
    if (context.abortSignal) {
      request.signal = context.abortSignal;
    }

    const result = await context.worktreeService.deleteWorktree(request);
    if (!result.success) {
      if (blockedTransition) {
        return blockedResult(blockedTransition);
      }
      // Integrity rollback is not canceled with the original request.
      const restored = clearedBeforeDelete
        ? await transitionRoot(activeRoot, 'worktree_delete_restore', null)
        : null;
      return {
        content: result.message || 'Worktree delete failed.',
        summary: 'Worktree delete failed',
        isError: true,
        errorCode: result.error_code || TOOL_ERROR_CODES.EXECUTION_FAILED,
        metadata: {
          result_kind: RESULT_KIND,
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
    const deletedActiveRoot = Boolean(
      activeRootComparable && comparable(worktree.worktree_path) === activeRootComparable
    );
    let activeRootCleared = clearedBeforeDelete;
    let activeRootClearFailed = false;
    // A pruned-missing or already-deleted entry never reached beforeRemove;
    // clear a root that still points at it.
    if (deletedActiveRoot && !beforeRemoveRan) {
      try {
        const clearTransition = await transitionRoot(
          '',
          'worktree_delete_clear',
          context.abortSignal || null
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
    const pruned = status === 'pruned_missing';
    return {
      content: pruned
        ? `Pruned missing worktree registry entry "${worktree.id || ''}".${activeRootNote}`
        : `Deleted worktree "${worktree.branch || worktree.id || ''}".${activeRootNote}`,
      summary: pruned ? 'Pruned missing worktree' : 'Deleted worktree',
      isError: false,
      metadata: {
        result_kind: RESULT_KIND,
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
