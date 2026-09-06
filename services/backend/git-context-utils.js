/**
 * Git workspace context utilities for chat context injection.
 *
 * Provides lightweight git diff/status retrieval for the active
 * workspace root, suitable for injection into chat context assembly.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const GIT_TIMEOUT_MS = 5000;
const MAX_DIFF_CHARS = 4000;
const MAX_BUFFER_BYTES = 512 * 1024;

function gitExec(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { maxBuffer: MAX_BUFFER_BYTES, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const message = String(stderr || error.message || '').trim();
          if (message.includes('not a git repository')) {
            resolve('');
            return;
          }
          reject(new Error(message || 'git command failed'));
          return;
        }
        resolve(String(stdout || ''));
      }
    );
  });
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
    gitResults = await Promise.all([
      gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot),
      gitExec(['status', '--porcelain', '--untracked-files=normal'], workspaceRoot),
      gitExec(['diff', '--stat', 'HEAD'], workspaceRoot),
      gitExec(['diff', 'HEAD'], workspaceRoot),
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
