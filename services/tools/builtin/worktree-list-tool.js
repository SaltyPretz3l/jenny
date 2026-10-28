'use strict';

const { manifestSchema, serviceFailure, serviceUnavailable } = require('./tool-result');

const RESULT_KIND = 'worktree_list';

function renderWorktree(entry) {
  const branch = entry.branch || (entry.detached ? 'detached' : 'unknown branch');
  const status = entry.status || 'unknown';
  const source = entry.source || 'unknown';
  const identity = entry.registry_id ? `, id ${entry.registry_id}` : '';
  return `- ${branch} (${status}, ${source}${identity})`;
}

module.exports = {
  name: 'worktree_list',
  ...manifestSchema('worktree_list'),
  category: 'builtin',
  readOnly: true,
  workspaceRequired: true,

  summarize() {
    return 'List worktrees';
  },

  async execute(_input, context) {
    if (!context.worktreeService || typeof context.worktreeService.listWorktrees !== 'function') {
      return serviceUnavailable(RESULT_KIND, {
        label: 'Worktree list',
        content: 'Worktree service is unavailable.',
      });
    }
    const request = {
      workspaceRoot: context.workingDirectory,
    };
    if (context.abortSignal) {
      request.signal = context.abortSignal;
    }
    const result = await context.worktreeService.listWorktrees(request);
    if (!result.success) {
      return serviceFailure(RESULT_KIND, result, { label: 'Worktree list' });
    }
    const worktrees = Array.isArray(result.worktrees) ? result.worktrees : [];
    return {
      content: worktrees.length
        ? `Found ${worktrees.length} worktree(s):\n${worktrees.map(renderWorktree).join('\n')}`
        : 'No worktrees found.',
      summary: `List ${worktrees.length} worktree(s)`,
      isError: false,
      metadata: {
        result_kind: RESULT_KIND,
        repository_root: result.repository_root,
        registry_path: result.registry_path,
        count: worktrees.length,
        worktrees,
      },
    };
  },
};
