'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { TOOL_ERROR_CODES } = require('./backend/error-codes');
const { runGit } = require('./git-runner');
const { normalizeString } = require('./shared/normalize');
const {
  WorktreePathPolicy,
  normalizeComparablePath,
} = require('./worktree-path-policy');

const DEFAULT_GIT_TIMEOUT_MS = 30000;
const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const MAX_ERROR_CHARS = 800;
const MAX_BRANCH_NAME_CHARS = 200;
const MAX_BASE_REF_CHARS = 200;
const SAFE_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_BASE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@-]*$/;

function clipText(value, limit = MAX_ERROR_CHARS) {
  const text = normalizeString(value).replace(/[\r\n]+/g, ' ');
  return text.length > limit ? `${text.slice(0, limit - 3).trim()}...` : text;
}

function slugify(value, fallback = 'worktree') {
  const slug = normalizeString(value)
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop();
  const normalized = normalizeString(slug || value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return normalized || fallback;
}

function normalizeBranchName({ branch, name }) {
  const explicit = normalizeString(branch);
  if (explicit) {
    return explicit;
  }
  return `jenny/${slugify(name, `worktree-${Date.now().toString(36)}`)}`;
}

function refNameHasSafeShape(value, { maxLength, pattern }) {
  const refName = normalizeString(value);
  if (!refName || refName.length > maxLength) {
    return false;
  }
  if (
    refName.includes('\0')
    || refName.startsWith('-')
    || refName.startsWith('/')
    || refName.endsWith('/')
    || refName.includes('\\')
    || refName.includes('..')
    || refName.includes('//')
    || refName.includes('@{')
    || refName.endsWith('.')
    || refName.endsWith('.lock')
  ) {
    return false;
  }
  if (!pattern.test(refName)) {
    return false;
  }
  return refName.split('/').every((part) => (
    part
    && part !== '.'
    && part !== '..'
    && !part.endsWith('.lock')
  ));
}

function branchNameIsSafe(value) {
  return refNameHasSafeShape(value, {
    maxLength: MAX_BRANCH_NAME_CHARS,
    pattern: SAFE_BRANCH_PATTERN,
  });
}

function baseRefIsSafe(value) {
  return refNameHasSafeShape(value, {
    maxLength: MAX_BASE_REF_CHARS,
    pattern: SAFE_BASE_REF_PATTERN,
  });
}

function normalizeBaseRef(value) {
  return normalizeString(value) || 'HEAD';
}

function worktreeId() {
  return `wt_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function registryOwner(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    session_id: normalizeString(source.session_id || source.sessionId) || null,
    task_id: normalizeString(source.task_id || source.taskId) || null,
  };
}

function parsePorcelainWorktreeList(output) {
  const entries = [];
  let current = null;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) {
        entries.push(current);
        current = null;
      }
      continue;
    }
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ').trim();
    if (key === 'worktree') {
      if (current) {
        entries.push(current);
      }
      current = {
        path: path.resolve(value),
        head: '',
        branch: '',
        detached: false,
        bare: false,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (key === 'HEAD') {
      current.head = value;
    } else if (key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//, '');
    } else if (key === 'detached') {
      current.detached = true;
    } else if (key === 'bare') {
      current.bare = true;
    }
  }
  if (current) {
    entries.push(current);
  }
  return entries;
}

function parseGitStatusPorcelainSummary(output) {
  const summary = {
    modified_count: 0,
    staged_count: 0,
    untracked_count: 0,
    ignored_count: 0,
  };
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    if (!rawLine) continue;
    const x = rawLine[0] || ' ';
    const y = rawLine[1] || ' ';
    if (x === '?' && y === '?') {
      summary.untracked_count += 1;
      continue;
    }
    if (x === '!' && y === '!') {
      summary.ignored_count += 1;
      continue;
    }
    if (x && x !== ' ') {
      summary.staged_count += 1;
    }
    if (y && y !== ' ') {
      summary.modified_count += 1;
    }
  }
  return summary;
}

function canonicalRepositoryRootFromWorktreeList(output, fallbackRoot) {
  const entries = parsePorcelainWorktreeList(output);
  const primary = entries.find((entry) => entry.path && !entry.bare) || entries[0] || null;
  return primary?.path ? path.resolve(primary.path) : path.resolve(fallbackRoot);
}

function dirtySummaryHasChanges(summary) {
  return Boolean(
    summary
    && (
      summary.modified_count > 0
      || summary.staged_count > 0
      || summary.untracked_count > 0
      || summary.ignored_count > 0
    )
  );
}

function normalizeAbortSignal({ signal = null, abortSignal = null } = {}) {
  return signal || abortSignal || null;
}

function gitResultWasAborted(result) {
  return result?.reason === 'aborted';
}

async function statOrNull(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function directoryIsEmpty(targetPath) {
  const entries = await fs.readdir(targetPath);
  return entries.length === 0;
}

class WorktreeService {
  constructor({
    registryService,
    pathPolicy = new WorktreePathPolicy(),
    gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS,
    logger = null,
  } = {}) {
    this._registryService = registryService || null;
    this._pathPolicy = pathPolicy;
    this._gitTimeoutMs = Number.isFinite(Number(gitTimeoutMs)) && Number(gitTimeoutMs) > 0
      ? Math.floor(Number(gitTimeoutMs))
      : DEFAULT_GIT_TIMEOUT_MS;
    this._logger = typeof logger === 'function' ? logger : () => {};
    this._deletePromisesByWorktreeId = new Map();
  }

  async listWorktrees({ workspaceRoot, signal = null, abortSignal = null } = {}) {
    const gitSignal = normalizeAbortSignal({ signal, abortSignal });
    const repo = await this._resolveRepositoryRoot(workspaceRoot, { signal: gitSignal });
    if (!repo.success) {
      return repo;
    }
    const gitList = repo.worktree_list_stdout
      ? {
        success: true,
        stdout: repo.worktree_list_stdout,
        stderr: '',
        message: '',
      }
      : await this._runGit(repo.repository_root, ['worktree', 'list', '--porcelain'], {
        signal: gitSignal,
      });
    if (!gitList.success) {
      return this._failure('git worktree list failed.', {
        reason: gitResultWasAborted(gitList) ? 'aborted' : 'git_list_failed',
        details: gitList.message,
      });
    }

    const now = new Date().toISOString();
    const allRegistryEntries = this._registryService
      && typeof this._registryService.listAll === 'function'
      ? this._registryService.listAll()
      : [];
    const normalizedRepo = normalizeComparablePath(repo.repository_root);
    const registryEntries = allRegistryEntries.filter(
      (entry) => normalizeComparablePath(entry.repository_root) === normalizedRepo
    );
    const registryByPath = new Map(
      registryEntries.map((entry) => [normalizeComparablePath(entry.worktree_path), entry])
    );
    const seenPaths = new Set();
    const worktrees = [];

    for (const row of parsePorcelainWorktreeList(gitList.stdout)) {
      const normalizedPath = normalizeComparablePath(row.path);
      seenPaths.add(normalizedPath);
      const registry = registryByPath.get(normalizedPath) || null;
      worktrees.push({
        path: path.resolve(row.path),
        branch: row.branch,
        head: row.head,
        detached: row.detached,
        bare: row.bare,
        status: 'available',
        source: 'git',
        registry_id: registry?.id || null,
        registry_status: registry?.status || null,
        last_checked_at: now,
      });
    }

    const registryOnlyWorktrees = await Promise.all(
      registryEntries
        .filter((entry) => !seenPaths.has(normalizeComparablePath(entry.worktree_path)))
        .map(async (entry) => {
          const exists = await statOrNull(entry.worktree_path);
          return {
            path: path.resolve(entry.worktree_path),
            branch: entry.branch,
            head: '',
            detached: false,
            bare: false,
            status: exists ? 'stale' : 'missing',
            source: 'registry',
            registry_id: entry.id,
            registry_status: entry.status,
            last_checked_at: now,
          };
        })
    );
    worktrees.push(...registryOnlyWorktrees);

    if (registryEntries.length && typeof this._registryService?.saveAll === 'function') {
      const reconciledStatusById = new Map(
        worktrees
          .filter((entry) => entry.registry_id)
          .map((entry) => [entry.registry_id, entry.status])
      );
      try {
        this._registryService.saveAll(allRegistryEntries.map((entry) => (
          reconciledStatusById.has(entry.id)
            ? {
              ...entry,
              status: reconciledStatusById.get(entry.id),
              last_checked_at: now,
            }
            : entry
        )));
      } catch (error) {
        this._logger('WARN', 'worktree.registry_reconcile_failed', {
          message: error?.message || String(error),
        });
      }
    }

    return {
      success: true,
      result_kind: 'worktree_list',
      repository_root: repo.repository_root,
      registry_path: this._registryService?.filePath || '',
      worktrees,
    };
  }

  async createWorktree({
    workspaceRoot,
    name,
    branch,
    baseRef,
    base_ref,
    parentPath,
    parent_path,
    owner,
    signal = null,
    abortSignal = null,
  } = {}) {
    const gitSignal = normalizeAbortSignal({ signal, abortSignal });
    const repo = await this._resolveRepositoryRoot(workspaceRoot, { signal: gitSignal });
    if (!repo.success) {
      return repo;
    }
    const resolvedBranch = normalizeBranchName({ branch, name });
    const branchCheck = await this._validateBranchName(repo.repository_root, resolvedBranch, {
      signal: gitSignal,
    });
    if (!branchCheck.success) {
      return branchCheck;
    }
    const base = normalizeBaseRef(baseRef || base_ref);
    const baseCheck = await this._validateBaseRef(repo.repository_root, base, {
      signal: gitSignal,
    });
    if (!baseCheck.success) {
      return baseCheck;
    }

    const targetName = slugify(name || resolvedBranch, 'worktree');
    let target;
    try {
      target = await this._pathPolicy.resolveTarget({
        repositoryRoot: repo.repository_root,
        parentPath: parentPath || parent_path || '',
        name: targetName,
      });
    } catch (error) {
      this._logger('WARN', 'worktree.path_policy_rejected', {
        reason: error?.code || 'WORKTREE_PATH_POLICY',
        message: error?.message || String(error),
      });
      return this._failure(error?.message || 'Worktree target path was rejected.', {
        reason: 'path_policy_rejected',
        errorCode: TOOL_ERROR_CODES.DISABLED,
      });
    }

    const collision = await this._checkTargetCollision(repo.repository_root, target.targetPath);
    if (!collision.success) {
      return collision;
    }

    const gitResult = await this._runGit(repo.repository_root, [
      'worktree',
      'add',
      '-b',
      resolvedBranch,
      target.targetPath,
      base,
    ], { signal: gitSignal });
    if (!gitResult.success) {
      const reconciliation = await this._runGit(
        repo.repository_root,
        ['worktree', 'list', '--porcelain'],
        { logFailure: false }
      );
      const effectCommitted = reconciliation.success && parsePorcelainWorktreeList(
        reconciliation.stdout
      ).some((row) => (
        normalizeComparablePath(row.path) === normalizeComparablePath(target.targetPath)
      ));
      return this._failure('git worktree add failed.', {
        reason: gitResultWasAborted(gitResult) ? 'aborted' : 'git_add_failed',
        details: gitResult.message,
        extra: effectCommitted ? {
          effect_committed: true,
          worktree_path: path.resolve(target.targetPath),
          recovery: 'Run worktree_list to inspect the partially created worktree.',
        } : {},
      });
    }

    const timestamp = new Date().toISOString();
    const entry = {
      id: worktreeId(),
      repository_root: repo.repository_root,
      worktree_path: path.resolve(target.targetPath),
      branch: resolvedBranch,
      base_ref: base,
      owner: registryOwner(owner),
      status: 'available',
      created_at: timestamp,
      last_checked_at: timestamp,
    };
    let persisted = false;
    try {
      if (this._registryService && typeof this._registryService.add === 'function') {
        this._registryService.add(entry);
        persisted = true;
      }
    } catch (error) {
      this._logger('WARN', 'worktree.registry_add_failed', {
        message: error?.message || String(error),
      });
      return this._failure('Worktree was created but its registry entry could not be saved.', {
        reason: 'registry_add_failed',
        details: error?.message || String(error),
        extra: {
          effect_committed: true,
          registry_persisted: false,
          active_root_changed: false,
          worktree: entry,
          recovery: 'Run worktree_list to inspect the created worktree before retrying.',
        },
      });
    }

    return {
      success: true,
      result_kind: 'worktree_create',
      active_root_changed: false,
      registry_persisted: persisted,
      worktree: entry,
      git: {
        stdout: clipText(gitResult.stdout),
        stderr: clipText(gitResult.stderr),
      },
    };
  }

  async resolveSelectableWorktree({ workspaceRoot, worktreeId, signal = null, abortSignal = null } = {}) {
    const repo = await this._resolveRepositoryRoot(workspaceRoot, {
      signal: normalizeAbortSignal({ signal, abortSignal }),
    });
    if (!repo.success) {
      return repo;
    }
    const normalizedId = normalizeString(worktreeId);
    if (!normalizedId) {
      return this._failure('A worktree id is required.', {
        reason: 'worktree_id_missing',
        errorCode: TOOL_ERROR_CODES.DISABLED,
      });
    }
    const entry = this._registryForRepository(repo.repository_root).find(
      (row) => row.id === normalizedId
    );
    if (!entry) {
      return this._failure('Worktree was not found in the registry.', {
        reason: 'worktree_not_found',
        errorCode: TOOL_ERROR_CODES.DISABLED,
      });
    }
    const stat = await statOrNull(entry.worktree_path);
    if (!stat) {
      return this._failure('Worktree path is missing.', {
        reason: 'worktree_missing',
        errorCode: TOOL_ERROR_CODES.DISABLED,
      });
    }
    try {
      await this._pathPolicy.validateExistingWorktreePath({
        repositoryRoot: repo.repository_root,
        worktreePath: entry.worktree_path,
        worktreeStat: stat,
      });
    } catch (error) {
      this._logger('WARN', 'worktree.select_path_policy_rejected', {
        reason: error?.code || 'WORKTREE_PATH_POLICY',
        message: error?.message || String(error),
      });
      return this._failure(error?.message || 'Worktree path was rejected.', {
        reason: 'path_policy_rejected',
        errorCode: TOOL_ERROR_CODES.DISABLED,
      });
    }
    return {
      success: true,
      result_kind: 'worktree_select',
      repository_root: repo.repository_root,
      worktree_path: path.resolve(entry.worktree_path),
      worktree: entry,
    };
  }

  async deleteWorktree({ workspaceRoot, worktreeId, signal = null, abortSignal = null } = {}) {
    const gitSignal = normalizeAbortSignal({ signal, abortSignal });
    const normalizedId = normalizeString(worktreeId);
    if (!normalizedId) {
      const repo = await this._resolveRepositoryRoot(workspaceRoot, { signal: gitSignal });
      if (!repo.success) {
        return repo;
      }
      return this._failure('A worktree id is required.', {
        reason: 'worktree_id_missing',
        errorCode: TOOL_ERROR_CODES.DISABLED,
      });
    }
    let inFlightDelete = this._deletePromisesByWorktreeId.get(normalizedId);
    while (inFlightDelete) {
      const completedDelete = await inFlightDelete;
      const registryEntries = this._registryService
        && typeof this._registryService.listAll === 'function'
        ? this._registryService.listAll()
        : [];
      const remainingEntry = registryEntries.find((row) => row.id === normalizedId);
      if (!remainingEntry && completedDelete.deleted) {
        return {
          success: true,
          result_kind: 'worktree_delete',
          status: 'already_deleted',
          reason: 'already_deleted',
          registry_persisted: true,
          worktree: completedDelete.worktree,
        };
      }
      inFlightDelete = this._deletePromisesByWorktreeId.get(normalizedId);
    }

    let releaseDelete;
    const deletePromise = new Promise((resolve) => {
      releaseDelete = resolve;
    });
    this._deletePromisesByWorktreeId.set(normalizedId, deletePromise);
    let deleteCompleted = false;
    let entry = null;
    try {
      const repo = await this._resolveRepositoryRoot(workspaceRoot, { signal: gitSignal });
      if (!repo.success) {
        return repo;
      }
      entry = this._registryForRepository(repo.repository_root).find(
        (row) => row.id === normalizedId
      );
      if (!entry) {
        return this._failure('Worktree was not found in the registry.', {
          reason: 'worktree_not_found',
          errorCode: TOOL_ERROR_CODES.DISABLED,
        });
      }

      const stat = await statOrNull(entry.worktree_path);
      if (!stat) {
        const registryRemoved = this._removeRegistryEntry(entry.id);
        if (!registryRemoved) {
          return this._failure('Worktree registry entry could not be removed.', {
            reason: 'registry_remove_failed',
          });
        }
        deleteCompleted = true;
        return {
          success: true,
          result_kind: 'worktree_delete',
          status: 'pruned_missing',
          reason: 'worktree_missing_pruned',
          registry_persisted: registryRemoved,
          worktree: entry,
        };
      }

      try {
        await this._pathPolicy.validateExistingWorktreePath({
          repositoryRoot: repo.repository_root,
          worktreePath: entry.worktree_path,
          worktreeStat: stat,
        });
      } catch (error) {
        this._logger('WARN', 'worktree.delete_path_policy_rejected', {
          reason: error?.code || 'WORKTREE_PATH_POLICY',
          message: error?.message || String(error),
        });
        return this._failure(error?.message || 'Worktree path was rejected.', {
          reason: 'path_policy_rejected',
          errorCode: TOOL_ERROR_CODES.DISABLED,
        });
      }

      const status = await this._runGit(
        entry.worktree_path,
        ['status', '--porcelain=v1', '--untracked-files=normal', '--ignored=matching'],
        { signal: gitSignal }
      );
      if (!status.success) {
        return this._failure('git status failed for worktree.', {
          reason: gitResultWasAborted(status) ? 'aborted' : 'git_status_failed',
          details: status.message,
        });
      }
      const dirtySummary = parseGitStatusPorcelainSummary(status.stdout);
      if (dirtySummaryHasChanges(dirtySummary)) {
        return {
          ...this._failure('Worktree has local changes; refusing to delete.', {
            reason: 'dirty_worktree',
            errorCode: TOOL_ERROR_CODES.DISABLED,
          }),
          result_kind: 'worktree_delete',
          dirty_summary: dirtySummary,
        };
      }

      const registryRemoved = this._removeRegistryEntry(entry.id);
      if (!registryRemoved) {
        return this._failure('Worktree registry entry could not be removed.', {
          reason: 'registry_remove_failed',
        });
      }

      const removed = await this._runGit(
        repo.repository_root,
        ['worktree', 'remove', entry.worktree_path],
        { signal: gitSignal }
      );
      if (!removed.success) {
        const registryRestored = this._restoreRegistryEntry(entry);
        const failure = this._failure('git worktree remove failed.', {
          reason: gitResultWasAborted(removed) ? 'aborted' : 'git_remove_failed',
          details: removed.message,
        });
        return {
          ...failure,
          result_kind: 'worktree_delete',
          rollback: {
            registry_restored: registryRestored,
            registry_restore_failed: !registryRestored,
          },
        };
      }
      deleteCompleted = true;
      return {
        success: true,
        result_kind: 'worktree_delete',
        status: 'deleted',
        registry_persisted: registryRemoved,
        worktree: entry,
        git: {
          stdout: clipText(removed.stdout),
          stderr: clipText(removed.stderr),
        },
      };
    } finally {
      releaseDelete({ deleted: deleteCompleted, worktree: entry });
      if (this._deletePromisesByWorktreeId.get(normalizedId) === deletePromise) {
        this._deletePromisesByWorktreeId.delete(normalizedId);
      }
    }
  }

  _restoreRegistryEntry(entry) {
    try {
      if (this._registryService && typeof this._registryService.add === 'function') {
        this._registryService.add(entry);
        return true;
      }
    } catch (error) {
      this._logger('WARN', 'worktree.registry_restore_failed', {
        message: error?.message || String(error),
      });
    }
    return false;
  }

  describeStatus({ workspaceRoot } = {}) {
    const activeRootConfigured = Boolean(normalizeString(workspaceRoot));
    let entries;
    try {
      entries = this._registryService && typeof this._registryService.listAll === 'function'
        ? this._registryService.listAll()
        : [];
    } catch (error) {
      this._logger('WARN', 'worktree.status_registry_read_failed', {
        message: error?.message || String(error),
      });
      return {
        kind: 'worktree',
        active_root_configured: activeRootConfigured,
        registry_count: 0,
        stale_count: 0,
        missing_count: 0,
        registry_readable: false,
      };
    }

    return {
      kind: 'worktree',
      active_root_configured: activeRootConfigured,
      registry_count: entries.length,
      stale_count: entries.filter((entry) => entry.status === 'stale').length,
      missing_count: entries.filter((entry) => entry.status === 'missing').length,
      registry_readable: true,
    };
  }

  _registryForRepository(repositoryRoot) {
    if (!this._registryService || typeof this._registryService.listAll !== 'function') {
      return [];
    }
    const normalizedRepo = normalizeComparablePath(repositoryRoot);
    return this._registryService.listAll().filter(
      (entry) => normalizeComparablePath(entry.repository_root) === normalizedRepo
    );
  }

  _removeRegistryEntry(id) {
    try {
      if (this._registryService && typeof this._registryService.removeById === 'function') {
        this._registryService.removeById(id);
        return true;
      }
    } catch (error) {
      this._logger('WARN', 'worktree.registry_remove_failed', {
        message: error?.message || String(error),
      });
    }
    return false;
  }

  async _resolveRepositoryRoot(workspaceRoot, { signal = null } = {}) {
    const root = normalizeString(workspaceRoot);
    if (!root) {
      return this._failure('A tools workspace root is required for worktree tools.', {
        reason: 'workspace_root_missing',
        errorCode: TOOL_ERROR_CODES.DISABLED,
      });
    }
    const candidate = path.resolve(root);
    const gitResult = await this._runGit(candidate, ['rev-parse', '--show-toplevel'], { signal });
    if (!gitResult.success) {
      return this._failure('Workspace root is not a Git repository.', {
        reason: gitResultWasAborted(gitResult) ? 'aborted' : 'not_git_repository',
        errorCode: TOOL_ERROR_CODES.DISABLED,
        details: gitResult.message,
      });
    }
    const topLevelRoot = normalizeString(gitResult.stdout).split(/\r?\n/)[0];
    if (!topLevelRoot) {
      return this._failure('Git did not return a repository root.', {
        reason: 'git_root_missing',
      });
    }
    const worktreeList = await this._runGit(
      candidate,
      ['worktree', 'list', '--porcelain'],
      { logFailure: false, signal }
    );
    if (gitResultWasAborted(worktreeList)) {
      return this._failure('Worktree operation aborted.', {
        reason: 'aborted',
      });
    }
    const worktreeListStdout = worktreeList.success && normalizeString(worktreeList.stdout)
      ? String(worktreeList.stdout || '')
      : '';
    const repositoryRoot = worktreeList.success
      ? canonicalRepositoryRootFromWorktreeList(worktreeListStdout, topLevelRoot)
      : path.resolve(topLevelRoot);
    return {
      success: true,
      repository_root: repositoryRoot,
      worktree_list_stdout: worktreeListStdout,
    };
  }

  async _validateBranchName(repositoryRoot, branch, { signal = null } = {}) {
    if (!branchNameIsSafe(branch)) {
      return this._failure('Worktree branch name is invalid.', {
        reason: 'branch_invalid',
        errorCode: TOOL_ERROR_CODES.DISABLED,
      });
    }
    const result = await this._runGit(repositoryRoot, ['check-ref-format', '--branch', branch], {
      signal,
    });
    if (!result.success) {
      return this._failure('Worktree branch name is invalid.', {
        reason: gitResultWasAborted(result) ? 'aborted' : 'branch_invalid',
        errorCode: TOOL_ERROR_CODES.DISABLED,
        details: result.message,
      });
    }
    const existingBranch = await this._runGit(
      repositoryRoot,
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { logFailure: false, signal }
    );
    if (gitResultWasAborted(existingBranch)) {
      return this._failure('Worktree operation aborted.', {
        reason: 'aborted',
      });
    }
    if (existingBranch.success) {
      return this._failure('Worktree branch already exists.', {
        reason: 'branch_exists',
        errorCode: TOOL_ERROR_CODES.DISABLED,
      });
    }
    return { success: true };
  }

  async _validateBaseRef(repositoryRoot, baseRef, { signal = null } = {}) {
    if (!baseRefIsSafe(baseRef)) {
      return this._failure('Worktree base ref is invalid.', {
        reason: 'base_ref_invalid',
        errorCode: TOOL_ERROR_CODES.DISABLED,
      });
    }
    const result = await this._runGit(
      repositoryRoot,
      ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`],
      { logFailure: false, signal }
    );
    if (!result.success) {
      return this._failure('Worktree base ref is invalid or unavailable locally.', {
        reason: gitResultWasAborted(result) ? 'aborted' : 'base_ref_invalid',
        errorCode: TOOL_ERROR_CODES.DISABLED,
      });
    }
    return { success: true };
  }

  async _checkTargetCollision(repositoryRoot, targetPath) {
    const targetComparable = normalizeComparablePath(targetPath);
    const registryCollision = this._registryForRepository(repositoryRoot).find(
      (entry) => normalizeComparablePath(entry.worktree_path) === targetComparable
    );
    if (registryCollision) {
      return this._failure('Worktree target is already registered.', {
        reason: 'registry_collision',
        errorCode: TOOL_ERROR_CODES.DISABLED,
      });
    }

    const stat = await statOrNull(targetPath);
    if (!stat) {
      return { success: true };
    }
    if (!stat.isDirectory()) {
      return this._failure('Worktree target path already exists and is not a directory.', {
        reason: 'target_collision',
        errorCode: TOOL_ERROR_CODES.DISABLED,
      });
    }
    if (!(await directoryIsEmpty(targetPath))) {
      return this._failure('Worktree target directory already exists and is not empty.', {
        reason: 'target_collision',
        errorCode: TOOL_ERROR_CODES.DISABLED,
      });
    }
    return { success: true };
  }

  // Thin delegate to the shared git-runner primitive. The worktree surface
  // keeps its own WARN logging vocabulary and inherits process.env (no scrub),
  // preserving byte-for-byte the result shape callers already depend on.
  _runGit(cwd, args, { logFailure = true, signal = null } = {}) {
    return runGit(cwd, args, {
      signal,
      timeoutMs: this._gitTimeoutMs,
      maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
    }).then((result) => {
      if (!result.success && result.reason !== 'aborted' && logFailure) {
        this._logger('WARN', 'worktree.git_failed', {
          args: args.slice(0, 3),
          message: result.message,
        });
      }
      return result;
    });
  }

  _failure(message, {
    reason = 'execution_failed',
    errorCode = TOOL_ERROR_CODES.EXECUTION_FAILED,
    details = '',
    extra = {},
  } = {}) {
    return {
      success: false,
      result_kind: 'worktree_error',
      error_code: errorCode,
      reason,
      message: details ? `${message} ${clipText(details)}` : message,
      ...(extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {}),
    };
  }
}

module.exports = {
  WorktreeService,
  parseGitStatusPorcelainSummary,
  branchNameIsSafe,
  baseRefIsSafe,
};
