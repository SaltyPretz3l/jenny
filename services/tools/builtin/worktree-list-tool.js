'use strict';

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');

function serviceUnavailable() {
  return {
    content: 'Worktree service is unavailable.',
    summary: 'Worktree list unavailable',
    isError: true,
    errorCode: TOOL_ERROR_CODES.DISABLED,
    metadata: {
      result_kind: 'worktree_list',
      unavailable: true,
    },
  };
}

function renderWorktree(entry) {
  const branch = entry.branch || (entry.detached ? 'detached' : 'unknown branch');
  const status = entry.status || 'unknown';
  const source = entry.source || 'unknown';
  const identity = entry.registry_id ? `, id ${entry.registry_id}` : '';
  return `- ${branch} (${status}, ${source}${identity})`;
}

module.exports = {
  name: 'worktree_list',
  description: 'List Git worktrees for the configured workspace root, combining Git-discovered state with Jenny registry entries.',
  category: 'builtin',
  readOnly: true,
  workspaceRequired: true,
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },

  summarize() {
    return 'List worktrees';
  },

  async execute(_input, context) {
    if (!context.worktreeService || typeof context.worktreeService.listWorktrees !== 'function') {
      return serviceUnavailable();
    }
    const request = {
      workspaceRoot: context.workingDirectory,
    };
    if (context.abortSignal) {
      request.signal = context.abortSignal;
    }
    const result = await context.worktreeService.listWorktrees(request);
    if (!result.success) {
      return {
        content: result.message || 'Worktree list failed.',
        summary: 'Worktree list failed',
        isError: true,
        errorCode: result.error_code || TOOL_ERROR_CODES.EXECUTION_FAILED,
        metadata: {
          result_kind: 'worktree_list',
          reason: result.reason || 'execution_failed',
        },
      };
    }
    const worktrees = Array.isArray(result.worktrees) ? result.worktrees : [];
    return {
      content: worktrees.length
        ? `Found ${worktrees.length} worktree(s):\n${worktrees.map(renderWorktree).join('\n')}`
        : 'No worktrees found.',
      summary: `List ${worktrees.length} worktree(s)`,
      isError: false,
      metadata: {
        result_kind: 'worktree_list',
        repository_root: result.repository_root,
        registry_path: result.registry_path,
        count: worktrees.length,
        worktrees,
      },
    };
  },
};
