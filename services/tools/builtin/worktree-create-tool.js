'use strict';

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { normalizeString } = require('../../shared/normalize');

function serviceUnavailable() {
  return {
    content: 'Worktree service is unavailable.',
    summary: 'Worktree create unavailable',
    isError: true,
    errorCode: TOOL_ERROR_CODES.DISABLED,
    metadata: {
      result_kind: 'worktree_create',
      unavailable: true,
    },
  };
}

module.exports = {
  name: 'worktree_create',
  description: 'Create a local Git worktree in the configured parent without fetching remotes or changing the active tools workspace root.',
  category: 'builtin',
  readOnly: false,
  workspaceRequired: true,
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Human-readable worktree name. Used to derive the target folder and default jenny/<slug> branch.',
      },
      branch: {
        type: 'string',
        description: 'Optional new local branch name. Defaults to jenny/<slug-from-name>.',
      },
      base_ref: {
        type: 'string',
        description: 'Optional local base ref for git worktree add. Defaults to HEAD.',
      },
    },
    required: ['name'],
  },

  summarize(input) {
    return `Create worktree ${normalizeString(input?.name || input?.branch || '')}`.trim();
  },

  async execute(input, context) {
    if (!context.worktreeService || typeof context.worktreeService.createWorktree !== 'function') {
      return serviceUnavailable();
    }
    const request = {
      workspaceRoot: context.workingDirectory,
      name: normalizeString(input?.name),
      branch: normalizeString(input?.branch),
      baseRef: normalizeString(input?.base_ref || input?.baseRef),
      parentPath: '',
      owner: {
        session_id: normalizeString(context.sessionId),
        task_id: normalizeString(context.callId),
      },
    };
    if (context.abortSignal) {
      request.signal = context.abortSignal;
    }
    const result = await context.worktreeService.createWorktree(request);
    if (!result.success) {
      return {
        content: result.message || 'Worktree create failed.',
        summary: 'Worktree create failed',
        isError: true,
        errorCode: result.error_code || TOOL_ERROR_CODES.EXECUTION_FAILED,
        metadata: {
          result_kind: 'worktree_create',
          reason: result.reason || 'execution_failed',
        },
      };
    }
    const worktree = result.worktree || {};
    const registryNote = result.registry_persisted === false
      ? ' Registry persistence failed; the worktree was still created.'
      : '';
    return {
      content: `Created worktree "${worktree.branch}" (${worktree.id || 'unregistered'}). Active workspace root unchanged.${registryNote}`,
      summary: `Created worktree ${worktree.branch}`,
      isError: false,
      metadata: {
        result_kind: 'worktree_create',
        active_root_changed: result.active_root_changed === true,
        registry_persisted: result.registry_persisted === true,
        worktree,
      },
    };
  },
};
