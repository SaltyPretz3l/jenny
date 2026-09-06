'use strict';

const path = require('path');
const fs = require('fs/promises');

const DEFAULT_WINDOWS_MAX_PATH_LENGTH = 240;
const DEFAULT_POSIX_MAX_PATH_LENGTH = 4096;

function normalizePathText(value) {
  return String(value || '').trim();
}

function policyError(message, code = 'WORKTREE_PATH_POLICY') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isInsidePath(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeComparablePath(value) {
  const resolved = path.resolve(normalizePathText(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function defaultWorktreeParent(repositoryRoot) {
  const resolved = path.resolve(repositoryRoot);
  return path.join(path.dirname(resolved), `${path.basename(resolved)}-worktrees`);
}

function splitRelativePath(relativePath) {
  return relativePath
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function hasTraversalSegment(value) {
  return splitRelativePath(value).some((part) => part === '..' || part === '.');
}

async function pathExists(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

class WorktreePathPolicy {
  constructor({
    maxPathLength = process.platform === 'win32'
      ? DEFAULT_WINDOWS_MAX_PATH_LENGTH
      : DEFAULT_POSIX_MAX_PATH_LENGTH,
  } = {}) {
    const parsed = Number(maxPathLength);
    this._maxPathLength = Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : (process.platform === 'win32' ? DEFAULT_WINDOWS_MAX_PATH_LENGTH : DEFAULT_POSIX_MAX_PATH_LENGTH);
  }

  async resolveTarget({ repositoryRoot, parentPath = '', name }) {
    const repoRootText = normalizePathText(repositoryRoot);
    if (!repoRootText) {
      throw policyError('A repository root is required for worktree path resolution.');
    }
    const repoRoot = path.resolve(repoRootText);
    const rawName = normalizePathText(name);
    if (!rawName || rawName.includes('\0')) {
      throw policyError('A non-empty worktree name is required.');
    }
    if (path.isAbsolute(rawName) || /^[a-z]:/iu.test(rawName)) {
      throw policyError('Worktree names must be relative to the worktree parent.');
    }
    if (hasTraversalSegment(rawName)) {
      throw policyError('Worktree names must not contain traversal segments.');
    }

    const parentRoot = path.resolve(normalizePathText(parentPath) || defaultWorktreeParent(repoRoot));
    await fs.mkdir(parentRoot, { recursive: true });
    const parentRealPath = await fs.realpath(parentRoot);
    if (normalizeComparablePath(parentRealPath) !== normalizeComparablePath(parentRoot)) {
      throw policyError('Worktree parent path must not be a symbolic link or junction.');
    }
    const targetPath = path.resolve(parentRoot, rawName);

    if (!isInsidePath(targetPath, parentRoot)) {
      throw policyError('Worktree target is outside the worktree parent.');
    }
    if (targetPath.length > this._maxPathLength) {
      throw policyError('Worktree target path is too long for the current platform.');
    }

    const relativePath = path.relative(parentRoot, targetPath);
    const segments = splitRelativePath(relativePath);
    let currentPath = parentRoot;
    for (const segment of segments) {
      currentPath = path.join(currentPath, segment);
      const stat = await pathExists(currentPath);
      if (!stat) {
        break;
      }
      const realCurrentPath = await fs.realpath(currentPath);
      if (!isInsidePath(realCurrentPath, parentRealPath)) {
        throw policyError('Worktree linked path escapes the configured parent.');
      }
    }

    return {
      repositoryRoot: repoRoot,
      parentRoot,
      parentRealPath,
      targetPath,
      relativePath,
    };
  }

  async validateExistingWorktreePath({ repositoryRoot, parentPath = '', worktreePath, worktreeStat = null }) {
    const repoRootText = normalizePathText(repositoryRoot);
    if (!repoRootText) {
      throw policyError('A repository root is required for worktree path validation.');
    }
    const repoRoot = path.resolve(repoRootText);
    const rawWorktreePath = normalizePathText(worktreePath);
    if (!rawWorktreePath || rawWorktreePath.includes('\0')) {
      throw policyError('A non-empty worktree path is required.');
    }

    const parentRoot = path.resolve(normalizePathText(parentPath) || defaultWorktreeParent(repoRoot));
    const parentRealPath = await fs.realpath(parentRoot);
    if (normalizeComparablePath(parentRealPath) !== normalizeComparablePath(parentRoot)) {
      throw policyError('Worktree parent path must not be a symbolic link or junction.');
    }

    const targetPath = path.resolve(rawWorktreePath);
    if (!isInsidePath(targetPath, parentRoot)) {
      throw policyError('Worktree path is outside the worktree parent.');
    }
    const targetStat = worktreeStat || await pathExists(targetPath);
    if (!targetStat) {
      throw policyError('Worktree path does not exist.', 'WORKTREE_MISSING');
    }
    if (!targetStat.isDirectory()) {
      throw policyError('Worktree path is not a directory.');
    }
    const targetRealPath = await fs.realpath(targetPath);
    if (!isInsidePath(targetRealPath, parentRealPath)) {
      throw policyError('Worktree linked path escapes the configured parent.');
    }
    if (targetRealPath.length > this._maxPathLength) {
      throw policyError('Worktree target path is too long for the current platform.');
    }

    return {
      repositoryRoot: repoRoot,
      parentRoot,
      parentRealPath,
      targetPath,
      targetRealPath,
    };
  }
}

module.exports = {
  WorktreePathPolicy,
  normalizeComparablePath,
};
