/**
 * Git workspace context utilities for chat context injection.
 *
 * Provides lightweight git diff/status retrieval for the active
 * workspace root, suitable for injection into chat context assembly.
 *
 * Runs through the hardened services/git-runner.js with a scrubbed env and
 * never executes configured helpers (fsmonitor, hooks, external diff, textconv,
 * clean/smudge/process filters).
 */

const fs = require('fs');
const path = require('path');
const { runGit } = require('../git-runner');

const GIT_TIMEOUT_MS = 5000;
const MAX_DIFF_CHARS = 4000;
const MAX_BUFFER_BYTES = 512 * 1024;
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

// This runs automatically on every chat turn with no tool approval, so every
// command is neutralized against configured helper programs: no fsmonitor hook,
// no git hooks, and (on the diffs) no external diff driver or textconv filter.
// The runner also scrubs the child env (GIT_EXTERNAL_DIFF, GIT_CONFIG_*, ...).
const SAFE_CONFIG_ARGS = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NULL_DEVICE}`];
const NO_HELPER_DIFF_ARGS = ['--no-ext-diff', '--no-textconv'];

// `git status` and `git diff HEAD` run a configured clean/process filter over
// working-tree files, and no command-line flag turns that off, so the configured
// driver keys are listed first and overridden per command. Same key set as
// sidecar/ai/tools/builtins/git_process.py `neutralizing_config_arguments`.
const HELPER_CONFIG_KEY = /^(?:filter\..+\.(?:clean|smudge|process|required)|diff\..+\.(?:command|textconv))$/i;
const MAX_HELPER_CONFIG_KEYS = 64;

// Resolves stdout; a "not a git repository" failure yields '' and any other
// failure rejects so the caller degrades to no context.
async function gitExec(args, cwd, configArgs = SAFE_CONFIG_ARGS) {
  const result = await runGit(cwd, [...configArgs, ...args], {
    scrubEnv: true,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
  });
  if (result.success) {
    return String(result.stdout || '');
  }
  const message = String(result.stderr || result.message || '').trim();
  if (message.includes('not a git repository')) {
    return '';
  }
  throw new Error(message || 'git command failed');
}

// SAFE_CONFIG_ARGS plus an override for every configured filter and diff driver
// key. Rejects (no context) when the config cannot be listed, a key cannot be
// overridden on the command line, or there are too many of them.
async function neutralizedConfigArgs(cwd) {
  const listing = await gitExec(['config', '--list', '--name-only'], cwd);
  const keys = [...new Set(listing.split(/\r?\n/).filter((key) => HELPER_CONFIG_KEY.test(key)))];
  if (keys.length > MAX_HELPER_CONFIG_KEYS || keys.some((key) => key.includes('='))) {
    throw new Error('git helper configuration cannot be neutralized');
  }
  const overrides = keys.flatMap((key) => (
    ['-c', /\.required$/i.test(key) ? `${key}=false` : `${key}=`]
  ));
  return [...SAFE_CONFIG_ARGS, ...overrides];
}

/**
 * Retrieve a compact git workspace context string suitable for
 * injection as a system message in chat context assembly.
 *
 * Returns null if:
 * - workspaceRoot is falsy or not a git repo
 * - there are no meaningful changes to report
 *
 * @param {string} workspaceRoot - Absolute path to the workspace root.
 * @returns {Promise<string|null>}
 */
async function getGitContextForChat(workspaceRoot) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    return null;
  }

  // Fast check: skip subprocess overhead for non-git workspaces.
  try {
    fs.accessSync(path.join(workspaceRoot, '.git'));
  } catch {
    return null;
  }

  let gitResults;
  try {
    const configArgs = await neutralizedConfigArgs(workspaceRoot);
    gitResults = await Promise.all([
      gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot, configArgs),
      gitExec(['status', '--porcelain', '--untracked-files=normal'], workspaceRoot, configArgs),
      gitExec(['diff', ...NO_HELPER_DIFF_ARGS, '--stat', 'HEAD'], workspaceRoot, configArgs),
      gitExec(['diff', ...NO_HELPER_DIFF_ARGS, 'HEAD'], workspaceRoot, configArgs),
    ]);
  } catch {
    return null;
  }

  const [branch, statusLines, diffStat, diffContent] = gitResults.map((value) => value.trim());

  if (!statusLines && !diffStat && !diffContent) {
    return null;
  }

  const sections = ['[Git workspace context]'];
  if (branch) {
    sections.push(`Branch: ${branch}`);
  }

  if (statusLines) {
    const lines = statusLines.split('\n');
    const staged = lines.filter((l) => /^[MADRC]/.test(l)).length;
    const unstaged = lines.filter((l) => /^.[MADRC]/.test(l)).length;
    const untracked = lines.filter((l) => l.startsWith('??')).length;
    const parts = [];
    if (staged) { parts.push(`${staged} staged`); }
    if (unstaged) { parts.push(`${unstaged} unstaged`); }
    if (untracked) { parts.push(`${untracked} untracked`); }
    if (parts.length) {
      sections.push(`Working tree: ${parts.join(', ')}`);
    }
  }

  if (diffStat) {
    sections.push(`\nDiff summary:\n${diffStat}`);
  }

  if (diffContent) {
    const truncated = diffContent.length > MAX_DIFF_CHARS
      ? `${diffContent.slice(0, MAX_DIFF_CHARS)}\n... (diff truncated at ${MAX_DIFF_CHARS} chars)`
      : diffContent;
    sections.push(`\nDiff:\n${truncated}`);
  }

  return sections.join('\n');
}

module.exports = {
  getGitContextForChat,
};
