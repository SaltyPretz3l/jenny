'use strict';

/**
 * Row 75: resolve a merge conflict by deleting the file. Built for
 * WorkspaceGitService.resolveDelete's buildArgs, so it runs inside the same
 * serialized mutation lease and root/repo guard as every other write.
 *
 * Only paths that are unmerged right now qualify; anything else is refused,
 * so this can never act as a general file delete. A file still on disk goes
 * to the OS recycle bin (recoverable, like Discard on an untracked file),
 * then `git add --all` records the deletion, which clears the conflict. `git
 * rm` is never used: the write-verb guard keeps it forbidden.
 */

const nodePath = require('path');
const { WORKSPACE_GIT_ERROR_CODES } = require('./workspace-git-errors');
const { buildPathspecCommand } = require('./workspace-git-executor');
const { parseUnmergedPaths } = require('./workspace-git-parsers');

const OP = 'resolveDelete';

function failure(reason, message) {
  return {
    skipExec: true,
    result: {
      ok: false,
      available: true,
      isRepo: true,
      op: OP,
      error_code: WORKSPACE_GIT_ERROR_CODES.GIT_COMMAND_FAILED,
      reason,
      ...(message ? { message } : {}),
    },
  };
}

// lstat, not stat: a link (even a dangling one) is present and goes to the
// recycle bin as the link itself; null means nothing is at the path.
async function entryAt(fs, absolute) {
  try {
    return await fs.lstat(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * @returns {Promise<object>} a git argv command, or { skipExec, result } on refusal.
 */
async function buildResolveDeleteCommand({ exec, execFailure, fs, trashItemImpl, root, safePaths, signal }) {
  const listed = await exec(root, ['ls-files', '-u', '-z'], { signal });
  if (!listed.success) return { skipExec: true, result: execFailure(OP, listed) };
  const unmerged = parseUnmergedPaths(listed.stdout);
  if (safePaths.some((relPath) => !unmerged.has(relPath))) {
    return failure('not_conflicted', 'Only files with a merge conflict can be resolved by deleting them.');
  }
  const targets = [];
  for (const relPath of safePaths) {
    const absolute = nodePath.resolve(root, relPath);
    const entry = await entryAt(fs, absolute);
    if (!entry) continue;
    // A file/directory conflict can leave a directory at the unmerged path;
    // the recycle bin would take the whole folder (same rule as discardFile).
    if (entry.isDirectory()) {
      return failure('directory_unsupported', 'A folder sits at this conflicted path. Resolve it from your file manager instead.');
    }
    targets.push(absolute);
  }
  // Every path is checked before anything moves, so a refusal trashes nothing.
  for (const absolute of targets) {
    if (!trashItemImpl) {
      return failure('trash_unavailable', "The recycle bin isn't reachable in this shell mode. Delete the file from your file manager, then mark it resolved.");
    }
    try {
      await trashItemImpl(absolute);
    } catch {
      if (await entryAt(fs, absolute)) {
        return failure('trash_failed', "The file couldn't be moved to the recycle bin. Delete it from your file manager, then mark it resolved.");
      }
    }
  }
  return buildPathspecCommand(['add', '--all'], safePaths);
}

module.exports = { buildResolveDeleteCommand };
