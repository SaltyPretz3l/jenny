'use strict';

const { normalizeString } = require('../../shared/normalize');
const {
  invalidArguments,
  manifestSchema,
  readStringArgument,
  serviceFailure,
  serviceUnavailable,
  summaryArgument,
} = require('./tool-result');

const RESULT_KIND = 'worktree_create';
const LABEL = 'Worktree create';
// Matches the service's ref bounds; the name only seeds a slug and branch.
const MAX_REF_ARGUMENT_CHARS = 200;

function readCreateArguments(input) {
  const out = {};
  for (const [key, required] of [['name', true], ['branch', false], ['base_ref', false]]) {
    const read = readStringArgument(input, key, { required, maxLength: MAX_REF_ARGUMENT_CHARS });
    if (read.error) return { error: read.error };
    out[key] = read.value;
  }
  return out;
}

module.exports = {
  name: 'worktree_create',
  ...manifestSchema('worktree_create'),
  category: 'builtin',
  readOnly: false,
  workspaceRequired: true,

  summarize(input) {
    return `Create worktree ${summaryArgument(input, 'name', MAX_REF_ARGUMENT_CHARS)}`.trim();
  },

  async execute(input, context) {
    if (!context.worktreeService || typeof context.worktreeService.createWorktree !== 'function') {
      return serviceUnavailable(RESULT_KIND, { label: LABEL, content: 'Worktree service is unavailable.' });
    }
    const args = readCreateArguments(input);
    if (args.error) {
      return invalidArguments(RESULT_KIND, { label: LABEL, content: args.error });
    }
    const request = {
      workspaceRoot: context.workingDirectory,
      name: args.name,
      branch: args.branch,
      baseRef: args.base_ref,
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
      return serviceFailure(RESULT_KIND, result, { label: LABEL });
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
        result_kind: RESULT_KIND,
        active_root_changed: result.active_root_changed === true,
        registry_persisted: result.registry_persisted === true,
        worktree,
      },
    };
  },
};
