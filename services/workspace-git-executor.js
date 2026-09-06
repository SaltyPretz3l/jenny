'use strict';

/**
 * workspace-git-executor — the single chokepoint for every Workspace-IDE SCM
 * subprocess. Wraps the neutral git-runner primitive with the workspace
 * policy: always scrub JENNY_* and credential env from the child, mask any
 * token-shaped substrings out of the surfaced error message, and apply the IDE
 * timeout / output-buffer budget. WorkspaceGitService injects this as its
 * `exec`, so tests can swap a spy in without reaching into git-runner.
 */

const { runGit, runGitStreamed } = require('./git-runner');
const { maskTokensInText } = require('./backend/sanitize-spawn-env');
const { WORKSPACE_GIT_ERROR_CODES, workspaceGitError } = require('./workspace-git-errors');

const WORKSPACE_GIT_TIMEOUT_MS = 10000;
// getDiff/getLog can be large; bound generously here and char-truncate in the
// service rather than risk an ENOBUFS on a big working-tree diff.
const WORKSPACE_GIT_MAXBUFFER_BYTES = 8 * 1024 * 1024;
const MAX_PATHSPEC_COUNT = 10_000;
const MAX_PATHSPEC_BYTES = 1024 * 1024;
const MAX_COMMIT_MESSAGE_CHARS = 10_000;
const MAX_STASH_MESSAGE_CHARS = 1000;

function buildPathspecCommand(args, paths) {
  const list = Array.isArray(paths) ? paths : [];
  if (list.length > MAX_PATHSPEC_COUNT) {
    throw workspaceGitError(
      WORKSPACE_GIT_ERROR_CODES.PATH_INVALID,
      'Too many paths were selected for one Git operation.'
    );
  }
  const chunks = [];
  let inputBytes = 0;
  for (const path of list) {
    const value = String(path || '');
    if (value.includes('\0')) {
      throw workspaceGitError(WORKSPACE_GIT_ERROR_CODES.PATH_INVALID, 'Git paths must not contain NUL bytes.');
    }
    inputBytes += Buffer.byteLength(value, 'utf8') + 1;
    if (inputBytes > MAX_PATHSPEC_BYTES) {
      throw workspaceGitError(WORKSPACE_GIT_ERROR_CODES.PATH_INVALID, 'The selected Git paths are too large.');
    }
    chunks.push(value);
  }
  return {
    args: [...args, '--pathspec-from-file=-', '--pathspec-file-nul'],
    input: chunks.length ? `${chunks.join('\0')}\0` : '',
  };
}

function classifyExpectedOutcome(op, result) {
  const text = `${result?.stdout || ''}\n${result?.stderr || ''}\n${result?.message || ''}`.slice(0, 16_000);
  if (op === 'commit' && /nothing to commit|no changes added|nothing added to commit/i.test(text)) {
    return 'nothing_to_commit';
  }
  if (op === 'stash' && /no local changes to save/i.test(text)) return 'nothing_to_stash';
  if (op === 'stash' && /no stash entries|no stash found/i.test(text)) return 'nothing_to_pop';
  if (op === 'undoLastCommit'
    && /unknown revision|ambiguous argument|bad revision|invalid object name/i.test(text)) {
    return 'no_prior_commit';
  }
  return '';
}

async function runWorkspaceGit(cwd, args, {
  signal = null,
  timeoutMs = WORKSPACE_GIT_TIMEOUT_MS,
  execFileImpl = null,
  input = null,
  streamOutput = false,
  spawnImpl = null,
  maxOutputBytes = WORKSPACE_GIT_MAXBUFFER_BYTES,
} = {}) {
  const runner = streamOutput ? runGitStreamed : runGit;
  const result = await runner(cwd, args, {
    signal,
    timeoutMs,
    ...(streamOutput ? { maxOutputBytes } : { maxBuffer: WORKSPACE_GIT_MAXBUFFER_BYTES }),
    scrubEnv: true,
    input,
    ...(execFileImpl ? { execFileImpl } : {}),
    ...(spawnImpl ? { spawnImpl } : {}),
  });
  // Mask any token-shaped substring a remote URL / auth error might echo
  // before the message reaches the renderer.
  return { ...result, message: maskTokensInText(result.message) };
}

module.exports = {
  runWorkspaceGit,
  MAX_COMMIT_MESSAGE_CHARS,
  MAX_STASH_MESSAGE_CHARS,
  buildPathspecCommand,
  classifyExpectedOutcome,
};
