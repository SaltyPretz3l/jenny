'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { TOOL_ERROR_CODES } = require('./backend/error-codes');
const { runGit } = require('./git-runner');
const { normalizeString } = require('./shared/normalize');
const {
  baseRefIsSafe,
  branchNameIsSafe,
  canonicalRepositoryRootFromWorktreeList,
  clipText,
  dirtySummaryHasChanges,
  normalizeBaseRef,
  normalizeBranchName,
  parseGitStatusPorcelainSummary,
  parsePorcelainWorktreeList,
  slugify,
} = require('./worktree-service-git');
const {
  WorktreePathPolicy,
  normalizeComparablePath,
} = require('./worktree-path-policy');

const DEFAULT_GIT_TIMEOUT_MS = 30000;
const GIT_OUTPUT_LIMIT_BYTES = 1024 * 1024;

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
    const gitList = await this._worktreeListFor(repo, { signal: gitSignal });
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

    if (registryEntries.length) {
      this._reconcileRegistryStatuses(worktrees, now);
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
    const gitList = await this._worktreeListFor(repo, {
      signal: normalizeAbortSignal({ signal, abortSignal }),
    });
    if (!gitList.success) {
      return this._failure('git worktree list failed.', {
        reason: gitResultWasAborted(gitList) ? 'aborted' : 'git_list_failed',
        details: gitList.message,
      });
    }
    const selectedPath = await fs.realpath(entry.worktree_path);
    const liveRows = parsePorcelainWorktreeList(gitList.stdout).filter((row) => row.prunable !== true);
    const livePaths = await Promise.all(liveRows.map(
      async (row) => fs.realpath(row.path).catch(() => null)
    ));
    if (!livePaths.some((livePath) => livePath
      && normalizeComparablePath(livePath) === normalizeComparablePath(selectedPath))) {
      return this._failure('Worktree is no longer registered with Git.', {
        reason: 'worktree_stale', errorCode: TOOL_ERROR_CODES.DISABLED,
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

  // `beforeRemove` (optional) runs after the ownership, path-policy and dirty
  // checks pass and before any registry or disk mutation. It receives
  // `{ worktree, worktree_path, repository_root }` and may veto the delete by
  // returning `{ proceed: false, message?, reason?, extra? }`; a throw vetoes
  // with reason `before_remove_failed`.
  async deleteWorktree({
    workspaceRoot,
    worktreeId,
    beforeRemove = null,
    signal = null,
    abortSignal = null,
  } = {}) {
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

      const veto = await this._runBeforeRemove(beforeRemove, entry, repo.repository_root);
      if (veto) {
        return veto;
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

  // Re-read the registry synchronously after the awaits above so a concurrent
  // add/remove is never overwritten by the pre-await snapshot, and write only
  // when a reconciled status actually changed (listing is a read-only tool).
  _reconcileRegistryStatuses(worktrees, now) {
    if (typeof this._registryService?.saveAll !== 'function') {
      return;
    }
    const reconciledStatusById = new Map(
      worktrees
        .filter((entry) => entry.registry_id)
        .map((entry) => [entry.registry_id, entry.status])
    );
    try {
      const freshEntries = this._registryService.listAll();
      let changed = false;
      const nextEntries = freshEntries.map((entry) => {
        if (!reconciledStatusById.has(entry.id)) {
          return entry;
        }
        const status = reconciledStatusById.get(entry.id);
        if (entry.status === status) {
          return entry;
        }
        changed = true;
        return { ...entry, status, last_checked_at: now };
      });
      if (changed) {
        this._registryService.saveAll(nextEntries);
      }
    } catch (error) {
      this._logger('WARN', 'worktree.registry_reconcile_failed', {
        message: error?.message || String(error),
      });
    }
  }

  async _runBeforeRemove(beforeRemove, entry, repositoryRoot) {
    if (typeof beforeRemove !== 'function') {
      return null;
    }
    let outcome;
    try {
      outcome = await beforeRemove({
        worktree: entry,
        worktree_path: path.resolve(entry.worktree_path),
        repository_root: repositoryRoot,
      });
    } catch (error) {
      return {
        ...this._failure('Worktree delete was blocked before filesystem mutation.', {
          reason: 'before_remove_failed',
          details: error?.message || String(error),
        }),
        result_kind: 'worktree_delete',
      };
    }
    if (outcome && outcome.proceed === false) {
      return {
        ...this._failure(outcome.message || 'Worktree delete was blocked before filesystem mutation.', {
          reason: outcome.reason || 'before_remove_blocked',
          extra: outcome.extra,
        }),
        result_kind: 'worktree_delete',
      };
    }
    return null;
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

  // `_resolveRepositoryRoot` already ran `git worktree list --porcelain`; reuse
  // its stdout and only spawn again when that capture failed or was empty.
  _worktreeListFor(repo, { signal = null } = {}) {
    if (repo.worktree_list_stdout) {
      return Promise.resolve({
        success: true,
        stdout: repo.worktree_list_stdout,
        stderr: '',
        message: '',
      });
    }
    return this._runGit(repo.repository_root, ['worktree', 'list', '--porcelain'], { signal });
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
