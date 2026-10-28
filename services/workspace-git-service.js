/* services/workspace-git-service.js - root-scoped git/SCM access for the
 * Workspace IDE page (the workspaceGit.* IPC namespace). Every method first
 * resolves the active tools workspace root fresh, confirms it is inside a git
 * work tree, and short-circuits to a CLEAN structured result (never a throw)
 * when the feature is disabled, no root is configured, or the workspace is not
 * a git repository. Renderer-supplied paths are lexically + realpath contained
 * to the root (mirrors WorkspaceIdeService); refs are validated with the
 * worktree-service ref validators. Every destructive operation routes through
 * the single `_runWrite` guard - no write method touches the executor directly.
 */

'use strict';

const crypto = require('crypto');
const fsPromises = require('fs/promises');
const nodePath = require('path');

const { ToolPathPolicy } = require('./tools/tool-path-policy');
const { WORKSPACE_GIT_ERROR_CODES, workspaceGitError } = require('./workspace-git-errors');
const {
  buildPathspecCommand,
  literalPathspec,
  classifyExpectedOutcome,
  runWorkspaceGit,
} = require('./workspace-git-executor');
const { branchNameIsSafe, baseRefIsSafe } = require('./worktree-service');
const { isContainedGitRunner } = require('./contained-git-runner');
const {
  createWorkspaceGitResources,
  isWorkspaceGitResourceError,
} = require('./workspace-git-resources');
const {
  createCheckpointTransactionRunner,
  createWorkspaceGitCheckpointApi,
} = require('./workspace-git-checkpoint');
const {
  WorkspaceGitOperationContext,
  clampInt,
  normalizePathList,
} = require('./workspace-git-operation-context');
const {
  detectRepoScope,
  notRepoToplevelResult,
  probeHeadState,
} = require('./workspace-git-root-guard');
// Pure output parsers (extracted for the file-size ceiling; re-exported below
// so unit tests keep importing them from this module). US is the field
// separator the parsers expect in structured `git log`/`git branch` formats.
const {
  US,
  parseBranchHeader,
  deriveFileState,
  parseStatus,
  parseLog,
  parseChangedFilesByCommit,
  parseBlamePorcelain,
} = require('./workspace-git-parsers');
const { buildResolveDeleteCommand } = require('./workspace-git-resolve-delete');
const { listNonIgnoredFilesRead, checkIgnoredRead, normalizeCheckIgnoredPaths } = require('./workspace-git-ignore-reads');
const { createWorkspaceGitExtras, classifyHeadPathMiss, trashUntracked } = require('./workspace-git-service-extras');

const MAX_DIFF_CHARS = 200000;
const MAX_BLAME_LINES = 2000;
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;

// The only git verbs a write may invoke. The guard asserts args[0] is in here,
// so a buildArgs bug can never smuggle an unexpected mutation past _runWrite.
// Row 82 G1/G2: `branch` (delete `-d` only) and `apply` (`--cached`, one validated
// single-file patch), both built in workspace-git-service-extras. No network verb.
const WRITE_VERBS = new Set(['add', 'restore', 'commit', 'checkout', 'stash', 'reset', 'update-ref', 'branch', 'apply']);

function assertWriteVerb(verb) {
  if (!WRITE_VERBS.has(verb)) {
    throw new Error(`workspace-git write guard: unexpected git verb "${verb}"`);
  }
}

function buildPathLogHint(relPath) {
  const normalized = String(relPath || '');
  return {
    file_name: normalized.split('/').pop() || '',
    path_hash: crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12),
  };
}

class WorkspaceGitService {
  constructor({
    configService,
    featureFlagProvider = null,
    exec = runWorkspaceGit,
    fs = fsPromises,
    path = nodePath,
    logger = null,
    trashItemImpl = null,
    rootContextProvider = null,
    resourceAdmissionProvider = null,
  } = {}) {
    if (!configService) {
      throw new TypeError('WorkspaceGitService requires configService');
    }
    this._configService = configService;
    this._featureFlagProvider = typeof featureFlagProvider === 'function' ? featureFlagProvider : null;
    if (resourceAdmissionProvider !== null && !isContainedGitRunner(exec)) {
      throw new TypeError('WorkspaceGitService resource admission requires a contained Git runner.');
    }
    this._resources = createWorkspaceGitResources({ resourceAdmissionProvider });
    this._exec = this._resources.wrapExecutor(exec);
    this._fs = fs;
    this._path = path;
    this._pathPolicy = new ToolPathPolicy({ fs, path, logger });
    this._logger = typeof logger === 'function' ? logger : null;
    this._trashItemImpl = typeof trashItemImpl === 'function' ? trashItemImpl : null;
    this._operations = new WorkspaceGitOperationContext({
      rootContextProvider,
      rootProvider: () => this._configService.getToolsWorkspaceRoot?.(),
    });
    // WIDE-035 checkpoint owner: the whole transaction core (one root-bound
    // serialized mutation lease per operation) lives in workspace-git-checkpoint;
    // the service only lends its guard/result primitives through these seams.
    this._checkpoints = createWorkspaceGitCheckpointApi({
      runTransaction: createCheckpointTransactionRunner({
        gitEnabled: () => this._gitEnabled(),
        acquireMutation: (signal) => this._operations.acquire({ kind: 'mutation', signal }),
        runSerialized: (key, fn) => this._operations.runSerialized(key, fn),
        detectScope: (root, options) => detectRepoScope(this._exec, root, { ...options, fs: this._fs }),
        unavailable: (op, reason) => this._unavailable(op, reason),
        notARepo: (op) => this._notARepo(op),
        notToplevel: (op) => notRepoToplevelResult(op),
        execFailure: (op, result) => this._execFailure(op, result),
        runWithResources: (operation, handler) => this._resources.run({
          root: operation.root,
          signal: operation.signal,
          validate: operation.isCurrent,
        }, handler),
        isResourceError: isWorkspaceGitResourceError,
      }),
      exec: this._exec,
      execFailure: (op, result) => this._execFailure(op, result),
      probeHeadState,
      log: (level, event, details) => this._log(level, event, details),
      resolveInsideRoot: (relPath, root) => this._resolveInsideRoot(relPath, root),
      trashItem: this._trashItemImpl,
    });
    // Row 82 G1/G2 verbs (commit / stash options, index and commit reads, branch -d,
    // apply --cached) run through this instance's _withRepo / _runWrite envelopes.
    this._extras = createWorkspaceGitExtras(this);
  }

  _log(level, event, details = {}) {
    if (this._logger) {
      try {
        this._logger(level, event, details);
      } catch (_error) {
        /* logging must never break git access */
      }
    }
  }

  _gitEnabled() {
    return this._featureFlagProvider?.()?.workspace_git === true;
  }

  // Lexical gate: returns the normalized POSIX relative path or throws.
  _normalizeRelPath(value) {
    const raw = String(value || '').replace(/\\/g, '/');
    const lead = raw.trimStart();
    if (!lead || raw.includes('\0') || lead.startsWith('/') || /^[A-Za-z]:/.test(lead)) {
      throw workspaceGitError(
        WORKSPACE_GIT_ERROR_CODES.PATH_INVALID,
        'Path must be a workspace-relative path.'
      );
    }
    const segments = raw.split('/').filter((segment) => segment.length > 0 && segment !== '.');
    if (!segments.length || segments.some((segment) => segment === '..')) {
      throw workspaceGitError(
        WORKSPACE_GIT_ERROR_CODES.PATH_INVALID,
        'Path must stay inside the workspace (no ".." segments).'
      );
    }
    const normalized = segments.join('/');
    if (normalized.startsWith('-')) {
      throw workspaceGitError(
        WORKSPACE_GIT_ERROR_CODES.PATH_INVALID,
        'Path must not start with a dash.'
      );
    }
    return normalized;
  }

  async _resolveInsideRoot(relPath, root) {
    const normalizedRel = this._normalizeRelPath(relPath);
    const resolved = this._path.resolve(root, normalizedRel);
    try {
      await this._pathPolicy.assertInsideRoot(resolved, { workingDirectory: root });
    } catch (error) {
      if (error?.code && String(error.code).startsWith('CMP-')) {
        throw error;
      }
      throw workspaceGitError(
        WORKSPACE_GIT_ERROR_CODES.PATH_OUTSIDE_ROOT,
        'Path resolves outside the workspace root.',
        buildPathLogHint(normalizedRel)
      );
    }
    return { root, relPath: normalizedRel, resolved };
  }

  // --- clean-result shapes (never thrown) -----------------------------------

  _unavailable(op, reason) {
    return { ok: false, available: false, isRepo: false, op, reason };
  }

  _notARepo(op) {
    return { ok: false, available: true, isRepo: false, op };
  }

  _execFailure(op, result) {
    const expected = classifyExpectedOutcome(op, result);
    return {
      ok: false,
      available: true,
      isRepo: true,
      op,
      error_code: WORKSPACE_GIT_ERROR_CODES.GIT_COMMAND_FAILED,
      reason: expected || result?.reason || 'git_failed',
      message: result?.message || '',
    };
  }

  // Read-path envelope: resolves flag/root/repo and degrades cleanly, else runs
  // `handler(root)`.
  async _withRepo(op, handler, { signal = null } = {}) {
    if (!this._gitEnabled()) {
      return this._unavailable(op, 'feature_disabled');
    }
    const operation = this._operations.acquire({ kind: 'read', signal });
    if (!operation.acquired) return this._unavailable(op, operation.code);
    try {
      return await this._resources.run({
        root: operation.root,
        signal: operation.signal,
        validate: operation.isCurrent,
      }, async () => {
        const detect = await detectRepoScope(this._exec, operation.root, { signal: operation.signal, fs: this._fs, isCurrent: operation.isCurrent });
        if (!operation.isCurrent()) return this._unavailable(op, 'root_changed');
        if (detect.failure) return this._execFailure(op, detect.failure);
        if (!detect.isRepo) return this._notARepo(op);
        if (!detect.isToplevel) return notRepoToplevelResult(op);
        const result = await handler(operation.root, operation.signal);
        return operation.isCurrent() ? result : this._unavailable(op, 'root_changed');
      });
    } catch (error) {
      if (isWorkspaceGitResourceError(error)) return this._unavailable(op, error.reason);
      throw error;
    } finally {
      operation.release();
    }
  }

  // The single destructive chokepoint. Re-checks flag/root/repo, lexically +
  // realpath contains every path, builds argv from validated inputs only,
  // asserts the verb is in the write allowlist, then executes. Returns a clean
  // degrade shape (ok:false) or { ok:true, root, safePaths, stdout, stderr }.
  async _runWrite(op, { validate = null, validatePaths = [], buildArgs, signal = null }) {
    if (!this._gitEnabled()) {
      return this._unavailable(op, 'feature_disabled');
    }
    const operation = this._operations.acquire({ kind: 'mutation', signal });
    if (!operation.acquired) return this._unavailable(op, operation.code);
    try {
      return await this._operations.runSerialized(
        operation.context?.rootId || operation.root,
        async () => {
          try {
            return await this._resources.run({
              root: operation.root,
              signal: operation.signal,
              validate: operation.isCurrent,
            }, async () => this._runWriteOperation(op, {
              operation,
              validate,
              validatePaths,
              buildArgs,
            }));
          } catch (error) {
            if (isWorkspaceGitResourceError(error)) return this._unavailable(op, error.reason);
            throw error;
          }
        }
      );
    } finally {
      operation.release();
    }
  }

  async _runWriteOperation(op, { operation, validate, validatePaths, buildArgs }) {
    const root = operation.root;
    if (!operation.isCurrent()) return this._unavailable(op, 'root_changed');
    const detect = await detectRepoScope(this._exec, root, { signal: operation.signal, fs: this._fs, isCurrent: operation.isCurrent });
    if (!operation.isCurrent()) return this._unavailable(op, 'root_changed');
    if (detect.failure) {
      return this._execFailure(op, detect.failure);
    }
    if (!detect.isRepo) {
      return this._notARepo(op);
    }
    if (!detect.isToplevel) return notRepoToplevelResult(op);
    // Caller-argument validation runs only once the workspace is a usable repo,
    // so a disabled / no-root / non-repo workspace degrades cleanly instead of
    // throwing on a bad message or ref (consistent with the read-method path).
    if (validate) {
      validate();
    }
    const safePaths = [];
    for (const candidate of validatePaths) {
      safePaths.push((await this._resolveInsideRoot(candidate, root)).relPath);
      if (!operation.isCurrent()) return this._unavailable(op, 'root_changed');
    }
    const command = await buildArgs({ root, safePaths, signal: operation.signal });
    if (!operation.isCurrent()) return this._unavailable(op, 'root_changed');
    // UIUX-032: a buildArgs closure that must perform a non-git side effect
    // (e.g. discardFile deleting an untracked file directly rather than
    // routing it through `git restore`, which only ever knows tracked paths)
    // returns its already-final result here instead of a git argv, so it still
    // runs inside the same serialized mutation lease + root/repo guard as every
    // other write, without stretching WRITE_VERBS to cover non-git verbs.
    if (command && command.skipExec === true) {
      return command.result;
    }
    // A batch write (discardFiles) returns { commands: [...], finish }: every command passes
    // the verb guard before any runs, they run in order inside this one lease, stopping at
    // the first failure, and `finish` (its non-git side effect) runs only after all succeed.
    const commands = Array.isArray(command?.commands) ? command.commands : [command];
    const argvs = commands.map((each) => (Array.isArray(each) ? each : each?.args));
    for (const args of argvs) assertWriteVerb(args[0]);
    let r = { stdout: '', stderr: '' };
    for (const [index, each] of commands.entries()) {
      r = await this._exec(root, argvs[index], { signal: operation.signal, input: Array.isArray(each) ? null : each?.input });
      if (!operation.isCurrent()) return this._unavailable(op, 'root_changed');
      if (!r.success) return this._execFailure(op, r);
    }
    if (typeof command?.finish === 'function') await command.finish();
    return { ok: true, available: true, isRepo: true, op, root, safePaths, stdout: r.stdout, stderr: r.stderr };
  }

  // --- READ methods ---------------------------------------------------------

  async getStatus({ signal = null } = {}) {
    return this._withRepo('getStatus', async (root, operationSignal) => {
      const r = await this._exec(
        root,
        ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'],
        { signal: operationSignal, streamOutput: true }
      );
      if (!r.success) {
        return this._execFailure('getStatus', r);
      }
      return {
        ok: true,
        available: true,
        isRepo: true,
        op: 'getStatus',
        ...parseStatus(r.truncated ? String(r.stdout).slice(0, String(r.stdout).lastIndexOf('\0') + 1) : r.stdout),
        truncated: r.truncated === true, droppedBytes: Math.max(0, Number(r.droppedBytes) || 0),
      };
    }, { signal });
  }

  // Read seam for sibling application services (proposal binding capture): the handler runs
  // inside the same flag/root/toplevel/resource-admission envelope as every read above and
  // receives the service-owned admitted exec, so its Git children get the same containment.
  async readWithExec(op, handler, { signal = null } = {}) {
    return this._withRepo(String(op || 'readWithExec'), (root, operationSignal) => handler({
      root,
      signal: operationSignal,
      exec: (args, options = {}) => this._exec(root, args, { ...options, signal: operationSignal }),
    }), { signal });
  }

  async getDiff({ path: relInput = null, staged = false, signal = null } = {}) {
    return this._withRepo('getDiff', async (root, operationSignal) => {
      let relPath = null;
      if (relInput != null && String(relInput).trim()) {
        relPath = (await this._resolveInsideRoot(relInput, root)).relPath;
      }
      const headState = await probeHeadState(this._exec, root, operationSignal);
      // Fail-oracle: a broken HEAD probe (abort/timeout/spawn failure) must
      // surface as an execution failure, never be silently read as "no HEAD".
      if (headState.failure) return this._execFailure('getDiff', headState.failure);
      const hasHead = headState.hasHead;
      const args = ['diff', '--no-color'];
      // staged: index-vs-HEAD (the changes that WILL be committed); with no
      // HEAD yet, --cached diffs the index against the empty tree (all
      // additions). Unstaged (default): working-tree-vs-HEAD.
      if (staged) {
        args.push('--cached');
      } else if (hasHead) {
        args.push('HEAD');
      }
      args.push('--');
      if (relPath) args.push(literalPathspec(relPath));
      const r = await this._exec(root, args, { signal: operationSignal });
      if (!r.success) {
        return this._execFailure('getDiff', r);
      }
      let diff = r.stdout;
      let truncated = false;
      if (diff.length > MAX_DIFF_CHARS) {
        diff = diff.slice(0, MAX_DIFF_CHARS);
        truncated = true;
      }
      const result = {
        ok: true,
        available: true,
        isRepo: true,
        op: 'getDiff',
        path: relPath,
        diff,
        truncated,
        containsBinary: /^Binary files /m.test(diff),
      };
      if (!hasHead) result.note = 'no_head';
      return result;
    }, { signal });
  }

  async getCommitDiff({ hash, signal = null } = {}) {
    return this._withRepo('getCommitDiff', async (root, operationSignal) => {
      const rev = String(hash == null ? '' : hash).trim();
      // The hash originates from getLog, but validate anyway: a hex SHA can
      // never be read as a git flag, so a malformed value is rejected before it
      // reaches the executor (injection safety). Reuses REF_INVALID (no new code).
      if (!/^[0-9a-f]{7,64}$/i.test(rev)) {
        throw workspaceGitError(
          WORKSPACE_GIT_ERROR_CODES.REF_INVALID,
          'Invalid commit hash.',
          { hash: rev }
        );
      }
      // `git show` renders the commit metadata header + the unified diff the
      // commit introduced (and correctly shows an all-additions diff for a root
      // commit, where `<rev>^!` would degrade). `--` terminates option parsing
      // as a second line of defense behind the hex-only validation above.
      const r = await this._exec(
        root,
        ['show', '--no-color', '--format=medium', rev, '--'],
        { signal: operationSignal }
      );
      if (!r.success) {
        return this._execFailure('getCommitDiff', r);
      }
      let diff = r.stdout;
      let truncated = false;
      if (diff.length > MAX_DIFF_CHARS) {
        diff = diff.slice(0, MAX_DIFF_CHARS);
        truncated = true;
      }
      return {
        ok: true,
        available: true,
        isRepo: true,
        op: 'getCommitDiff',
        hash: rev,
        diff,
        truncated,
        containsBinary: /^Binary files /m.test(diff),
      };
    }, { signal });
  }

  async getFileAtHead({ path: relInput, signal = null } = {}) {
    return this._withRepo('getFileAtHead', async (root, operationSignal) => {
      const relPath = (await this._resolveInsideRoot(relInput, root)).relPath;
      // HEAD:./<path> makes the path current-directory-relative (correct even
      // when the workspace root is a subdirectory of the repo).
      const r = await this._exec(
        root,
        ['show', `HEAD:./${relPath}`],
        { signal: operationSignal }
      );
      if (r.success) {
        return {
          ok: true,
          available: true,
          isRepo: true,
          op: 'getFileAtHead',
          path: relPath,
          found: true,
          content: r.stdout,
        };
      }
      const reason = classifyHeadPathMiss(r);
      if (!reason) return this._execFailure('getFileAtHead', r);
      return {
        ok: true,
        available: true,
        isRepo: true,
        op: 'getFileAtHead',
        path: relPath,
        found: false,
        reason,
      };
    }, { signal });
  }

  async getLog({ limit = DEFAULT_LOG_LIMIT, signal = null } = {}) {
    return this._withRepo('getLog', async (root, operationSignal) => {
      const max = clampInt(limit, 1, MAX_LOG_LIMIT, DEFAULT_LOG_LIMIT);
      const r = await this._exec(
        root,
        ['log', '-z', '--no-color', `--max-count=${max}`,
          `--pretty=format:%H${US}%h${US}%an${US}%ae${US}%aI${US}%P${US}%s`],
        { signal: operationSignal }
      );
      if (!r.success) {
        if (/does not have any commits|bad default revision/i.test(r.message || r.stderr || '')) {
          return { ok: true, available: true, isRepo: true, op: 'getLog', commits: [] };
        }
        return this._execFailure('getLog', r);
      }
      return { ok: true, available: true, isRepo: true, op: 'getLog', commits: parseLog(r.stdout) };
    }, { signal });
  }

  // Raw per-commit changed-file lists for the co-change signal consumed by
  // the Workspace File Map engine (buildGraph's `cochangeCommits` input).
  // `--name-only -z --pretty=format:%H` is deliberately minimal (hash + file
  // list only, no US-delimited metadata) since the engine only needs file
  // sets per commit, not commit metadata; NUL-delimited to stay robust
  // against filenames with embedded newlines. See parseChangedFilesByCommit
  // for the empirically-verified NUL/newline layout this format actually
  // produces (git does not document it precisely).
  async getChangedFilesByCommit({ limit = 200, signal = null } = {}) {
    return this._withRepo('getChangedFilesByCommit', async (root, operationSignal) => {
      const max = clampInt(limit, 1, MAX_LOG_LIMIT, 200);
      const r = await this._exec(
        root,
        ['log', '--name-only', '-z', `--max-count=${max}`, '--pretty=format:%H'],
        { signal: operationSignal }
      );
      if (!r.success) {
        if (/does not have any commits|bad default revision/i.test(r.message || r.stderr || '')) {
          return { ok: true, available: true, isRepo: true, op: 'getChangedFilesByCommit', commits: [] };
        }
        return this._execFailure('getChangedFilesByCommit', r);
      }
      return {
        ok: true,
        available: true,
        isRepo: true,
        op: 'getChangedFilesByCommit',
        commits: parseChangedFilesByCommit(r.stdout),
      };
    }, { signal });
  }

  // Non-ignored scan scope for the Workspace File Map scanner (see
  // workspace-git-ignore-reads). READ-only: never _runWrite / WRITE_VERBS.
  async listNonIgnoredFiles({ signal = null } = {}) {
    return this._withRepo('listNonIgnoredFiles', (root, operationSignal) => listNonIgnoredFilesRead({
      exec: this._exec, execFailure: (op, result) => this._execFailure(op, result), root, signal: operationSignal,
    }), { signal });
  }

  // Row 82 X1: which of these workspace-relative paths are gitignored (invalid
  // paths dropped silently, capped; see workspace-git-ignore-reads).
  async checkIgnored({ paths = [], signal = null } = {}) {
    const { list, truncated } = normalizeCheckIgnoredPaths(normalizePathList(paths), (value) => this._normalizeRelPath(value));
    return this._withRepo('checkIgnored', (root, operationSignal) => checkIgnoredRead({
      exec: this._exec, execFailure: (op, result) => this._execFailure(op, result), root, signal: operationSignal, list, truncated,
    }), { signal });
  }

  async getBranches({ signal = null } = {}) {
    return this._withRepo('getBranches', async (root, operationSignal) => {
      const r = await this._exec(
        root,
        ['branch', '--list', '--format=%(refname:short)' + US + '%(HEAD)'],
        { signal: operationSignal }
      );
      if (!r.success) {
        return this._execFailure('getBranches', r);
      }
      const branches = [];
      let current = null;
      let detached = false;
      for (const line of r.stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const sep = line.indexOf(US);
        const name = sep >= 0 ? line.slice(0, sep) : line;
        const head = sep >= 0 ? line.slice(sep + 1) : '';
        if (name.startsWith('(') || name.includes('HEAD detached')) {
          if (head === '*') detached = true;
          continue;
        }
        branches.push(name);
        if (head === '*') current = name;
      }
      // Robust across git versions whether or not `--format` emits the
      // detached pseudo-row: real branches exist but none is checked out.
      const isDetached = detached || (current === null && branches.length > 0);
      return {
        ok: true,
        available: true,
        isRepo: true,
        op: 'getBranches',
        branches,
        current,
        detached: isDetached,
        unborn: branches.length === 0 && !isDetached,
      };
    }, { signal });
  }

  async blameRange({ path: relInput, startLine, endLine, signal = null } = {}) {
    return this._withRepo('blameRange', async (root, operationSignal) => {
      const relPath = (await this._resolveInsideRoot(relInput, root)).relPath;
      const start = Math.floor(Number(startLine));
      const end = Math.floor(Number(endLine));
      if (!Number.isInteger(start) || !Number.isInteger(end)
        || start < 1 || end < start || (end - start + 1) > MAX_BLAME_LINES) {
        throw workspaceGitError(
          WORKSPACE_GIT_ERROR_CODES.LINE_RANGE_INVALID,
          'Invalid line range for blame.',
          { ...buildPathLogHint(relPath), startLine, endLine }
        );
      }
      const r = await this._exec(
        root,
        ['blame', '-L', `${start},${end}`, '--porcelain', 'HEAD', '--', relPath],
        { signal: operationSignal }
      );
      if (!r.success) {
        const reason = classifyHeadPathMiss(r);
        if (!reason) return this._execFailure('blameRange', r);
        return {
          ok: true,
          available: true,
          isRepo: true,
          op: 'blameRange',
          path: relPath,
          startLine: start,
          endLine: end,
          found: false,
          reason,
          lines: [],
        };
      }
      return {
        ok: true,
        available: true,
        isRepo: true,
        op: 'blameRange',
        path: relPath,
        startLine: start,
        endLine: end,
        found: true,
        lines: parseBlamePorcelain(r.stdout),
      };
    }, { signal });
  }

  // --- WRITE methods (all via _runWrite) ------------------------------------

  async stage({ paths = [], signal = null } = {}) {
    const list = normalizePathList(paths);
    if (!list.length) {
      return this._withRepo(
        'stage',
        () => ({ ok: true, available: true, isRepo: true, op: 'stage', staged: 0, paths: [] }),
        { signal }
      );
    }
    const r = await this._runWrite('stage', {
      validatePaths: list,
      buildArgs: ({ safePaths }) => buildPathspecCommand(['add'], safePaths),
      signal,
    });
    if (!r.ok) return r;
    return { ok: true, available: true, isRepo: true, op: 'stage', staged: r.safePaths.length, paths: r.safePaths };
  }

  // Row 75: resolve a conflict by deleting the file (recycle bin, then the
  // deletion is staged). Unmerged paths only: see workspace-git-resolve-delete.
  async resolveDelete({ paths = [], signal = null } = {}) {
    const list = normalizePathList(paths);
    if (!list.length) {
      return this._withRepo('resolveDelete', () => ({ ok: true, available: true, isRepo: true, op: 'resolveDelete', paths: [] }), { signal });
    }
    const r = await this._runWrite('resolveDelete', {
      validatePaths: list,
      buildArgs: ({ root, safePaths, signal: operationSignal }) => buildResolveDeleteCommand({
        exec: this._exec, execFailure: (op, result) => this._execFailure(op, result), fs: this._fs,
        trashItemImpl: this._trashItemImpl, root, safePaths, signal: operationSignal,
      }),
      signal,
    });
    if (!r.ok) return r;
    return { ok: true, available: true, isRepo: true, op: 'resolveDelete', paths: r.safePaths };
  }

  async unstage({ paths = [], signal = null } = {}) {
    const list = normalizePathList(paths);
    if (!list.length) {
      return this._withRepo(
        'unstage',
        () => ({ ok: true, available: true, isRepo: true, op: 'unstage', unstaged: 0, paths: [] }),
        { signal }
      );
    }
    const r = await this._runWrite('unstage', {
      validatePaths: list,
      buildArgs: async ({ root, safePaths, signal: operationSignal }) => {
        const headState = await probeHeadState(this._exec, root, operationSignal);
        // Fail-oracle: never map a broken HEAD probe to the no-HEAD `reset`
        // branch — propagate the failure so the mutation aborts cleanly.
        if (headState.failure) {
          throw workspaceGitError(
            WORKSPACE_GIT_ERROR_CODES.GIT_COMMAND_FAILED,
            headState.failure.message || 'Could not determine repository HEAD state.'
          );
        }
        return buildPathspecCommand(headState.hasHead ? ['restore', '--staged'] : ['reset'], safePaths);
      },
      signal,
    });
    if (!r.ok) return r;
    return { ok: true, available: true, isRepo: true, op: 'unstage', unstaged: r.safePaths.length, paths: r.safePaths };
  }

  // Row 82 G1: `amend` / `signoff` options (workspace-git-service-extras).
  commit(options = {}) { return this._extras.commit(options); }

  // UIUX-032: "Discard" promises restoring the last-committed version, but
  // `git restore --worktree` only understands paths git already tracks — on an
  // untracked path it fails with "did not match any file(s) known to git",
  // which used to surface verbatim as a confusing GIT_COMMAND_FAILED instead of
  // doing what "no changes" actually means for an untracked file: it goes away.
  // Classify tracked vs untracked FIRST (a scoped status probe on just this
  // path), then either move the untracked file to the OS recycle bin via
  // trashItem or restore the tracked one - so the same single-path entry point
  // is honest for both
  // classes instead of only working for the tracked half.
  async discardFile({ path: relInput, signal = null } = {}) {
    const r = await this._runWrite('discardFile', {
      validatePaths: [relInput],
      buildArgs: async ({ root, safePaths, signal: opSignal }) => {
        const relPath = safePaths[0];
        // `ls-files` (not `status`) answers the one question that matters here -
        // is this path in the INDEX at all - with a plain exit 0 whether the
        // path is tracked, untracked, or missing entirely from disk. A tracked
        // path (even one currently absent on disk, e.g. a working-tree delete)
        // goes through `restore`; anything git's index doesn't know about is
        // "untracked" for this purpose and is moved to the OS recycle bin.
        const tracked = await this._exec(root, ['ls-files', '-z', '--', literalPathspec(relPath)], { signal: opSignal });
        if (!tracked.success) {
          return { skipExec: true, result: this._execFailure('discardFile', tracked) };
        }
        const isTracked = String(tracked.stdout || '').split('\0').filter(Boolean).includes(relPath);
        if (isTracked) {
          return ['restore', '--worktree', '--', literalPathspec(relPath)];
        }
        // `ls-files -- <dir>` lists the CHILDREN, never the directory itself, so a
        // folder whose files are tracked reads as "untracked" here: trashUntracked
        // refuses a directory (and an unreachable or failing recycle bin).
        const trashed = await trashUntracked({ fs: this._fs, path: this._path, trashItemImpl: this._trashItemImpl, root, relPath });
        if (!trashed.ok) {
          return {
            skipExec: true,
            result: {
              ok: false, available: true, isRepo: true, op: 'discardFile',
              error_code: WORKSPACE_GIT_ERROR_CODES.GIT_COMMAND_FAILED, reason: trashed.reason, message: trashed.message,
            },
          };
        }
        return {
          skipExec: true,
          result: {
            ok: true, available: true, isRepo: true, op: 'discardFile',
            path: relPath, discarded: true, class: 'untracked', deleted: true, trashed: true,
          },
        };
      },
      signal,
    });
    if (!r.ok) return r;
    // The untracked branch already returns its final shape via skipExec; the
    // tracked branch went through the normal git-exec wrap and needs it added.
    if (r.class) return r;
    return { ok: true, available: true, isRepo: true, op: 'discardFile', path: r.safePaths[0], discarded: true, class: 'tracked' };
  }

  async checkout({ ref, createBranch = false, signal = null } = {}) {
    const refStr = String(ref != null ? ref : '').trim();
    const r = await this._runWrite('checkout', {
      validate: () => {
        const valid = createBranch ? branchNameIsSafe(refStr) : baseRefIsSafe(refStr);
        if (!valid) {
          throw workspaceGitError(
            WORKSPACE_GIT_ERROR_CODES.REF_INVALID,
            'Invalid branch or ref name.',
            { ref: refStr }
          );
        }
      },
      buildArgs: () => (createBranch ? ['checkout', '-b', refStr] : ['checkout', refStr]),
      signal,
    });
    if (!r.ok) return r;
    return {
      ok: true,
      available: true,
      isRepo: true,
      op: 'checkout',
      ref: refStr,
      created: createBranch === true,
      switched: true,
    };
  }

  // push / pop / apply / drop with an optional entry index (workspace-git-service-extras).
  stash(options = {}) { return this._extras.stash(options); }

  async undoLastCommit({ signal = null } = {}) {
    const r = await this._runWrite('undoLastCommit', {
      buildArgs: () => ['reset', '--soft', 'HEAD~1'],
      signal,
    });
    if (!r.ok) {
      if (r.error_code === WORKSPACE_GIT_ERROR_CODES.GIT_COMMAND_FAILED
        && r.reason === 'no_prior_commit') {
        return { ok: true, available: true, isRepo: true, op: 'undoLastCommit', undone: false, reason: 'no_prior_commit' };
      }
      return r;
    }
    return { ok: true, available: true, isRepo: true, op: 'undoLastCommit', undone: true };
  }

  // Row 82 G1/G2 reads and writes (workspace-git-service-extras).
  getFileAtIndex(options = {}) { return this._extras.getFileAtIndex(options); }
  getFileAtCommit(options = {}) { return this._extras.getFileAtCommit(options); }
  getCommitFiles(options = {}) { return this._extras.getCommitFiles(options); }
  listStashes(options = {}) { return this._extras.listStashes(options); }
  getLastCommitMessage(options = {}) { return this._extras.getLastCommitMessage(options); }
  blameFile(options = {}) { return this._extras.blameFile(options); }
  // Row 82 cleanup G3: Discard All as one write (workspace-git-service-extras).
  discardFiles(options = {}) { return this._extras.discardFiles(options); }
  deleteBranch(options = {}) { return this._extras.deleteBranch(options); }
  applyPatch(options = {}) { return this._extras.applyPatch(options); }

  createCheckpoint(options = {}) { return this._checkpoints.createCheckpoint(options); }

  listCheckpoints(options = {}) { return this._checkpoints.listCheckpoints(options); }

  restoreCheckpoint(options = {}) { return this._checkpoints.restoreCheckpoint(options); }

  deleteCheckpoint(options = {}) { return this._checkpoints.deleteCheckpoint(options); }

  preflightCheckpointFiles(options = {}) { return this._checkpoints.preflightCheckpointFiles(options); }

  restoreCheckpointFiles(options = {}) { return this._checkpoints.restoreCheckpointFiles(options); }
}

module.exports = {
  WorkspaceGitService,
  assertWriteVerb,
  WRITE_VERBS,
  parseStatus,
  parseBranchHeader,
  parseLog,
  parseChangedFilesByCommit,
  parseBlamePorcelain,
  deriveFileState,
};
