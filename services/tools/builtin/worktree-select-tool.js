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
const {
  invalidArguments,
  manifestSchema,
  readStringArgument,
  serviceFailure,
  serviceUnavailable,
  summaryArgument,
} = require('./tool-result');

const RESULT_KIND = 'worktree_select';
const LABEL = 'Worktree select';
const MAX_WORKTREE_ID_CHARS = 128;

function unavailable(content) {
  return serviceUnavailable(RESULT_KIND, { label: LABEL, content, metadata: { status: 'failed' } });
}

module.exports = {
  name: 'worktree_select',
  ...manifestSchema('worktree_select'),
  category: 'builtin',
  readOnly: false,
  workspaceRequired: true,

  summarize(input) {
    return `Select worktree ${summaryArgument(input, 'worktree_id', MAX_WORKTREE_ID_CHARS)}`.trim();
  },

  async execute(input, context) {
    if (
      !context.worktreeService
      || typeof context.worktreeService.resolveSelectableWorktree !== 'function'
    ) {
      return unavailable('Worktree service is unavailable.');
    }
    const configService = context.configService || context.backendService?.configService || null;
    const workspaceRootCoordinator = getWorkspaceRootCoordinator(context);
    const workspaceRootTransitionBroker = getWorkspaceRootTransitionBroker(context);
    if (!workspaceRootCoordinator || !workspaceRootTransitionBroker) {
      return unavailable('Transactional workspace root switching is unavailable.');
    }

    const idArgument = readStringArgument(input, 'worktree_id', {
      required: true,
      maxLength: MAX_WORKTREE_ID_CHARS,
    });
    if (idArgument.error) {
      return invalidArguments(RESULT_KIND, {
        label: LABEL,
        content: idArgument.error,
        metadata: { status: 'failed', active_root_unchanged: true },
      });
    }
    const worktreeId = idArgument.value;
    const request = {
      workspaceRoot: context.workingDirectory,
      worktreeId,
    };
    if (context.abortSignal) {
      request.signal = context.abortSignal;
    }
    const selected = await context.worktreeService.resolveSelectableWorktree(request);
    if (!selected.success) {
      return serviceFailure(RESULT_KIND, selected, {
        label: LABEL,
        metadata: { status: 'failed', active_root_unchanged: true },
      });
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
          result_kind: RESULT_KIND,
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
        result_kind: RESULT_KIND,
        status: 'selected',
        active_root_changed: activeRootChanged,
        worktree: selected.worktree,
      },
    };
  },
};
