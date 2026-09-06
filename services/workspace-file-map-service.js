/* services/workspace-file-map-service.js - stateful per-workspace owner of the
 * Workspace File Map dependency graph (the workspaceFileMap.* IPC namespace).
 *
 * Wraps the pure `workspace-file-map-engine` (buildGraph/computeImportance/
 * findings/layout) with the IO this repo's engine deliberately
 * stays free of: enumerating workspace files (WorkspaceIdeService), reading
 * their content, pulling co-change history (WorkspaceGitService), and loading
 * tsconfig path aliases. The engine itself is a synchronous pure function;
 * this service is the only async/IO layer around it.
 *
 * Caching: one graph per canonical root id + generation, kept until an
 * explicit refresh() or a getGraph() call for a root never scanned. Alongside
 * the graph, a `path -> {mtimeMs, content}` map lets a rescan skip re-reading
 * any file whose mtimeMs is unchanged since the last scan (the same
 * "memoize by mtime" shape as this repo's WorkspaceManifestCache pattern,
 * reimplemented here as a plain Map — no cross-module dependency).
 *
 * Every public method resolves to a plain structured result and never throws
 * across the IPC seam: a missing workspace root, a git-unavailable workspace,
 * or an unreadable file all degrade to either a clean {ok:false, reason} or a
 * partial scan, never a rejected promise reaching the caller.
 */

'use strict';

const { WORKSPACE_FS_ERROR_CODES } = require('./backend/error-codes');
const {
  WorkspaceFileMapWorkerBuilder,
  DEFAULT_BUILD_TIMEOUT_MS,
} = require('./workspace-file-map-worker');

// Yield the event loop back to other work every N files scanned, so a large
// workspace's content-read loop never blocks the main process for its whole
// duration (this is the only async portion of the scan; engine.buildGraph
// itself stays a synchronous pure function per its existing contract).
const YIELD_EVERY_N_FILES = 200;
const CACHE_MAX_ROOTS = 10;
const MAX_SCAN_FILES = 20_000;
const MAX_SCAN_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_CONTENT_CACHE_ENTRIES = 5_000;
const MAX_CONTENT_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_COCHANGE_COMMITS = 200;
const FILE_MAP_ENUMERATION_TIMEOUT_MS = 10_000;
const GRAPH_BUDGETS = Object.freeze({
  maxNodes: MAX_SCAN_FILES,
  maxEdges: 50_000,
  maxCochangePairs: 100_000,
  maxFilesPerCommit: 256,
});

function nextTick() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function scanLimit(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : maximum;
}

function freezeCochangeCommits(commits) {
  return Object.freeze(commits.slice(0, MAX_COCHANGE_COMMITS).map((commit) => {
    const files = Array.isArray(commit?.files)
      ? commit.files.slice(0, GRAPH_BUDGETS.maxFilesPerCommit + 1)
      : [];
    return Object.freeze({
      hash: String(commit?.hash || '').slice(0, 128),
      files: Object.freeze(files),
    });
  }));
}

function linkedAbortSignal(...signals) {
  const active = signals.filter(Boolean);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const listening = [];
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
    listening.push(signal);
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const signal of listening) signal.removeEventListener('abort', abort);
    },
  };
}

class WorkspaceFileMapService {
  constructor({
    ideService,
    gitService,
    engine = null,
    scanRules = require('./workspace-file-map-scan-rules'),
    ignore = require('./workspace-file-map-ignore'),
    graphBuilder = null,
    buildTimeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
    scanBudgets = null,
    versionedFileServiceProvider = null,
    logger = null,
  } = {}) {
    if (!ideService) {
      throw new TypeError('WorkspaceFileMapService requires ideService');
    }
    if (!gitService) {
      throw new TypeError('WorkspaceFileMapService requires gitService');
    }
    this._ideService = ideService;
    this._gitService = gitService;
    this._scanRules = scanRules;
    this._ignore = ignore;
    this._versionedFileServiceProvider = typeof versionedFileServiceProvider === 'function'
      ? versionedFileServiceProvider
      : () => this._ideService.versionedFileService || null;
    this._logger = typeof logger === 'function' ? logger : null;
    this._workerBuilder = null;
    if (typeof graphBuilder === 'function') {
      this._graphBuilder = graphBuilder;
    } else if (engine && typeof engine.buildGraph === 'function') {
      this._graphBuilder = async (payload) => {
        const contentByPath = new Map(payload.contentEntries);
        return engine.buildGraph({
          files: payload.files,
          readContent(relPath) {
            if (!contentByPath.has(relPath)) throw new Error('unreadable file');
            return contentByPath.get(relPath);
          },
          cochangeCommits: payload.cochangeCommits,
          tsconfigAliases: payload.tsconfigAliases,
          budgets: payload.budgets,
        });
      };
    } else {
      this._workerBuilder = new WorkspaceFileMapWorkerBuilder();
      this._graphBuilder = (payload, options) => this._workerBuilder.build(payload, options);
    }
    this._buildTimeoutMs = Number.isSafeInteger(buildTimeoutMs) && buildTimeoutMs > 0
      ? buildTimeoutMs
      : DEFAULT_BUILD_TIMEOUT_MS;
    this._scanBudgets = Object.freeze({
      maxFiles: scanLimit(scanBudgets?.maxFiles, MAX_SCAN_FILES),
      maxContentBytes: scanLimit(scanBudgets?.maxContentBytes, MAX_SCAN_CONTENT_BYTES),
      maxCacheEntries: scanLimit(scanBudgets?.maxCacheEntries, MAX_CONTENT_CACHE_ENTRIES),
      maxCacheBytes: scanLimit(scanBudgets?.maxCacheBytes, MAX_CONTENT_CACHE_BYTES),
    });
    this._disposed = false;
    this._lifecycleController = new AbortController();
    // `${rootId}:${generation}` -> cached graph/content or active scan.
    this._cacheByRoot = new Map();
    this._activeScansByRoot = new Map();
    this._queuedRefreshesByRoot = new Map();
  }

  _log(level, event, details = {}) {
    if (this._logger) {
      try {
        this._logger(level, event, details);
      } catch (_error) {
        /* logging must never break a scan */
      }
    }
  }

  // Cached graph if present; otherwise triggers a full scan and caches it.
  async getGraph(workspaceId) {
    return this._withRootOperation(workspaceId, false);
  }

  // Always forces a full re-scan, regardless of any cached graph.
  async refresh(workspaceId) {
    return this._withRootOperation(workspaceId, true);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._lifecycleController.abort();
    this._workerBuilder?.dispose?.();
    this._cacheByRoot.clear();
    this._activeScansByRoot.clear();
    this._queuedRefreshesByRoot.clear();
  }

  // --- internals -------------------------------------------------------

  _failure(error, fallback = WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING) {
    const candidate = String(error?.code || error?.error_code || '');
    const reason = candidate.startsWith('CMP-') ? candidate : fallback;
    return { ok: false, reason, partial: false };
  }

  _assertOperation(operation) {
    let current;
    try {
      current = this._disposed !== true
        && this._lifecycleController.signal.aborted !== true
        && operation?.acquired === true
        && operation.signal?.aborted !== true
        && operation.isCurrent?.() === true;
    } catch (_error) {
      current = false;
    }
    if (!current) {
      const error = new Error('Workspace root changed during the File Map scan.');
      error.code = WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING;
      throw error;
    }
  }

  _cacheKey(context) {
    return `${String(context.rootId)}:${context.generation}`;
  }

  _remember(cacheKey, value) {
    this._cacheByRoot.delete(cacheKey);
    this._cacheByRoot.set(cacheKey, value);
    while (this._cacheByRoot.size > CACHE_MAX_ROOTS) {
      this._cacheByRoot.delete(this._cacheByRoot.keys().next().value);
    }
  }

  _versionedFileService() {
    let service;
    try {
      service = this._versionedFileServiceProvider();
    } catch (_error) {
      service = null;
    }
    if (!service || typeof service.readText !== 'function') {
      const error = new Error('Versioned workspace file owner unavailable.');
      error.code = WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING;
      throw error;
    }
    return service;
  }

  async _withRootOperation(workspaceId, forceRefresh, expectedCacheKey = null) {
    let operation = null;
    try {
      if (this._disposed) {
        return this._failure(null);
      }
      if (typeof this._ideService.acquireRootOperation !== 'function') {
        return this._failure(null);
      }
      const versionedFileService = this._versionedFileService();
      operation = await this._ideService.acquireRootOperation({ kind: 'read' });
      this._assertOperation(operation);
      const context = operation.context;
      if (!context || !String(context.rootId || '') || !Number.isSafeInteger(context.generation)) {
        return this._failure(null);
      }
      const cacheKey = this._cacheKey(context);
      if (expectedCacheKey && cacheKey !== expectedCacheKey) {
        return this._failure(null);
      }
      const callerWorkspaceId = String(workspaceId || '').slice(0, 128);
      const cached = this._cacheByRoot.get(cacheKey);
      if (!forceRefresh && cached) {
        this._assertOperation(operation);
        this._log('DEBUG', 'workspace_file_map.cache_hit', {
          root_id: context.rootId,
          root_generation: context.generation,
          source: 'stored',
          caller_workspace_id: callerWorkspaceId,
        });
        return { ok: true, graph: cached.graph };
      }

      const active = this._activeScansByRoot.get(cacheKey);
      if (active) {
        if (!forceRefresh || active.forceRefresh) {
          this._log('DEBUG', 'workspace_file_map.cache_hit', {
            root_id: context.rootId,
            root_generation: context.generation,
            source: 'active_scan',
            caller_workspace_id: callerWorkspaceId,
          });
          operation.release?.();
          operation = null;
          return await active.promise;
        }
        let queued = this._queuedRefreshesByRoot.get(cacheKey);
        if (!queued) {
          queued = active.promise
            .then(() => this._withRootOperation(callerWorkspaceId, true, cacheKey))
            .finally(() => this._queuedRefreshesByRoot.delete(cacheKey));
          this._queuedRefreshesByRoot.set(cacheKey, queued);
        }
        operation.release?.();
        operation = null;
        return await queued;
      }

      this._log('DEBUG', 'workspace_file_map.cache_miss', {
        root_id: context.rootId,
        root_generation: context.generation,
        forced: forceRefresh === true,
        caller_workspace_id: callerWorkspaceId,
      });
      const ownedOperation = operation;
      operation = null;
      const promise = this._scan({
        workspaceId: callerWorkspaceId,
        cacheKey,
        operation: ownedOperation,
        versionedFileService,
      }).catch((error) => {
        this._log('WARN', 'workspace_file_map.scan_refused', {
          root_id: context.rootId,
          root_generation: context.generation,
          reason: String(error?.code || 'scan_failed').slice(0, 64),
        });
        return this._failure(error);
      }).finally(() => {
        try { ownedOperation.release?.(); } catch (_error) { /* idempotent lease */ }
        const current = this._activeScansByRoot.get(cacheKey);
        if (current?.promise === promise) this._activeScansByRoot.delete(cacheKey);
      });
      this._activeScansByRoot.set(cacheKey, { promise, forceRefresh: forceRefresh === true });
      return await promise;
    } catch (error) {
      this._log('WARN', 'workspace_file_map.scan_refused', {
        reason: String(error?.code || 'root_operation_failed').slice(0, 64),
      });
      return this._failure(error);
    } finally {
      try { operation?.release?.(); } catch (_error) { /* idempotent operation seam */ }
    }
  }

  async _scan({ workspaceId, cacheKey, operation, versionedFileService }) {
    this._assertOperation(operation);
    const listResult = await this._ideService.listAllFiles({
      maxFiles: this._scanBudgets.maxFiles,
      maxDurationMs: FILE_MAP_ENUMERATION_TIMEOUT_MS,
    }, operation);
    this._assertOperation(operation);
    if ((listResult?.rootId && listResult.rootId !== operation.context.rootId)
      || (Number.isSafeInteger(listResult?.generation)
        && listResult.generation !== operation.context.generation)) {
      return this._failure(null);
    }
    const files = Array.isArray(listResult?.files) ? listResult.files : [];

    // Scope the scan to non-ignored files only (git-aware when possible, a
    // conservative denylist fallback otherwise) so a workspace's build
    // output / vendored deps / binaries are never read or parsed — while
    // still accounting for every excluded file via a per-top-level-dir
    // "bucket" summary node appended below, so nothing silently vanishes.
    const gitScope = await this._safeNonIgnoredFiles(operation, files);
    this._assertOperation(operation);
    const keepSet = gitScope?.keepSet || null;
    const partitioned = keepSet
      ? this._ignore.partitionByKeepSet(files, keepSet)
      : this._ignore.fallbackPartition(files);
    const includedTotal = partitioned.included.length;
    const included = partitioned.included.slice(0, this._scanBudgets.maxFiles);
    const buckets = partitioned.buckets;
    const serviceTruncationReasons = new Set();
    if (includedTotal > included.length) serviceTruncationReasons.add('file_limit');
    if (gitScope?.truncated === true) serviceTruncationReasons.add('git_scope_limit');

    const previousCache = this._cacheByRoot.get(cacheKey);
    const previousContentCache = previousCache?.contentCacheByPath || new Map();
    const nextContentCache = new Map();

    const contentByPath = new Map();
    let contentBytes = 0;
    let cacheBytes = 0;
    let cacheTruncated = false;
    let contentBudgetExhausted = false;
    let contentReadFailures = 0;
    let scannedSinceYield = 0;
    const isDependencyContentPath = (relPath) => (
      typeof this._scanRules.isDependencyContentPath === 'function'
        ? this._scanRules.isDependencyContentPath(relPath)
        : /\.(?:[cm]?[jt]sx?|py|css|html?)$/i.test(relPath)
    );
    const dependencyFilesEligible = included.filter(isDependencyContentPath).length;
    const contentReadOrder = included.slice().sort((left, right) => {
      const priority = (relPath) => {
        if (relPath === 'tsconfig.json') return 0;
        if (isDependencyContentPath(relPath)) return 1;
        return 2;
      };
      return priority(left) - priority(right);
    });
    for (const relPath of contentReadOrder) {
      this._assertOperation(operation);
      if (contentBudgetExhausted) {
        serviceTruncationReasons.add('content_byte_limit');
        continue;
      }
      const fingerprint = await this._statFingerprint(relPath, operation);
      this._assertOperation(operation);

      const previousEntry = previousContentCache.get(relPath);
      let content;
      let fileVersion = previousEntry?.fileVersion || '';
      if (previousEntry && previousEntry.fingerprint === fingerprint) {
        // Unchanged since the last scan: reuse the cached content instead of
        // re-reading from disk.
        content = previousEntry.content;
      } else {
        try {
          const read = await versionedFileService.readText({ path: relPath, intent: 'preview' });
          this._assertOperation(operation);
          if (read?.rootId !== operation.context.rootId
            || read?.generation !== operation.context.generation) {
            const error = new Error('Versioned read belongs to a different workspace root.');
            error.code = WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING;
            throw error;
          }
          content = typeof read?.content === 'string' ? read.content : '';
          fileVersion = String(read?.fileVersion || '');
        } catch (error) {
          if (error?.code === WORKSPACE_FS_ERROR_CODES.ROOT_MISSING
            || error?.code === WORKSPACE_FS_ERROR_CODES.ROOT_INVALID
            || error?.code === WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING
            || error?.code === WORKSPACE_FS_ERROR_CODES.STALE_GENERATION) {
            throw error;
          }
          this._assertOperation(operation);
          // Unreadable (binary/too-large/vanished): engine.buildGraph already
          // tolerates a reader throw per-file, so surface that here too by
          // leaving this path absent from contentByPath (reader below throws).
          content = null;
          contentReadFailures += 1;
        }
      }

      if (content !== null) {
        const entryBytes = Buffer.byteLength(content, 'utf8');
        if (contentBytes + entryBytes > this._scanBudgets.maxContentBytes) {
          contentBudgetExhausted = true;
          serviceTruncationReasons.add('content_byte_limit');
        } else {
          contentBytes += entryBytes;
          contentByPath.set(relPath, content);
          if (nextContentCache.size < this._scanBudgets.maxCacheEntries
            && cacheBytes + entryBytes <= this._scanBudgets.maxCacheBytes) {
            cacheBytes += entryBytes;
            nextContentCache.set(relPath, { fingerprint, fileVersion, content });
          } else {
            cacheTruncated = true;
          }
        }
      }

      scannedSinceYield += 1;
      if (scannedSinceYield >= YIELD_EVERY_N_FILES) {
        scannedSinceYield = 0;
        await nextTick();
        this._assertOperation(operation);
      }
    }
    if (contentReadFailures > 0) serviceTruncationReasons.add('content_read_failure');

    const cochangeScope = await this._safeCochangeCommits(operation);
    this._assertOperation(operation);
    if (cochangeScope.truncated) serviceTruncationReasons.add('cochange_commit_limit');
    const tsconfigAliases = this._parseTsconfigAliases(contentByPath.get('tsconfig.json'));

    this._assertOperation(operation);
    const contentEntries = Array.from(contentByPath.entries(), (entry) => Object.freeze(entry));
    const payload = Object.freeze({
      files: Object.freeze(included.slice()),
      contentEntries: Object.freeze(contentEntries),
      cochangeCommits: freezeCochangeCommits(cochangeScope.commits),
      tsconfigAliases,
      budgets: Object.freeze({ ...GRAPH_BUDGETS, maxNodes: this._scanBudgets.maxFiles }),
    });
    const buildAbort = linkedAbortSignal(operation.signal, this._lifecycleController.signal);
    let graph;
    try {
      graph = await this._graphBuilder(payload, {
        signal: buildAbort.signal,
        timeoutMs: this._buildTimeoutMs,
      });
    } finally {
      buildAbort.dispose();
    }
    this._assertOperation(operation);
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      throw new Error('File Map graph builder returned an invalid result.');
    }

    // Bucket nodes fold every excluded top-level directory into one summary
    // node each; graph.meta gains service-owned scope bookkeeping alongside
    // (never removing) the engine's own meta fields.
    const bucketNodes = this._ignore.buildBucketNodes(buckets);
    const bucketCapacity = Math.max(0, this._scanBudgets.maxFiles - graph.nodes.length);
    if (bucketNodes.length > bucketCapacity) serviceTruncationReasons.add('bucket_limit');
    graph.nodes = graph.nodes.concat(bucketNodes.slice(0, bucketCapacity));
    graph.meta = graph.meta && typeof graph.meta === 'object' ? graph.meta : {};
    const truncationReasons = new Set(Array.isArray(graph.meta.truncationReasons)
      ? graph.meta.truncationReasons
      : []);
    for (const reason of serviceTruncationReasons) truncationReasons.add(reason);
    if (listResult?.truncated === true) truncationReasons.add('enumeration_limit');
    graph.meta.gitFiltered = keepSet != null;
    graph.meta.included = included.length;
    graph.meta.includedTotal = includedTotal;
    graph.meta.ignored = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    graph.meta.bucketCount = Math.min(bucketNodes.length, bucketCapacity);
    graph.meta.truncated = graph.meta.truncated === true || truncationReasons.size > 0;
    graph.meta.partial = graph.meta.partial === true || truncationReasons.size > 0;
    graph.meta.truncationReasons = Array.from(truncationReasons).sort();
    graph.meta.enumeration = {
      truncated: listResult?.truncated === true,
      reason: typeof listResult?.truncationReason === 'string' ? listResult.truncationReason : null,
      totalsKnown: listResult?.totalsKnown !== false,
      filesScanned: Number(listResult?.filesScanned) || files.length,
      directoriesScanned: Number(listResult?.directoriesScanned) || 0,
      entriesScanned: Number(listResult?.entriesScanned) || files.length,
      elapsedMs: Number(listResult?.elapsedMs) || 0,
    };
    const dependencyFilesAnalyzed = Array.from(contentByPath.keys())
      .filter(isDependencyContentPath).length;
    graph.meta.serviceBudget = {
      filesSeen: includedTotal,
      filesAccepted: included.length,
      contentFilesAnalyzed: contentByPath.size,
      contentFilesSkippedByBudget: Math.max(0, included.length - contentByPath.size - contentReadFailures),
      dependencyFilesEligible,
      dependencyFilesAnalyzed,
      contentBytes,
      contentByteLimit: this._scanBudgets.maxContentBytes,
      contentReadFailures,
      cacheEntries: nextContentCache.size,
      cacheBytes,
      cacheTruncated,
    };
    graph.meta.rootId = operation.context.rootId;
    graph.meta.generation = operation.context.generation;

    this._assertOperation(operation);
    this._remember(cacheKey, {
      graph,
      contentCacheByPath: nextContentCache,
    });

    this._log('INFO', 'workspace_file_map.scan', {
      workspace_id: operation.context.rootId,
      root_id: operation.context.rootId,
      root_generation: operation.context.generation,
      caller_workspace_id: workspaceId,
      file_count: files.length,
      truncated: graph.meta.truncated === true,
      truncation_reasons: graph.meta.truncationReasons,
    });

    return { ok: true, graph };
  }

  async _statFingerprint(relPath, operation) {
    try {
      const stat = await this._ideService.stat({ path: relPath }, operation);
      this._assertOperation(operation);
      return [
        Number(stat?.size) || 0,
        Number(stat?.mtimeMs) || 0,
        Number(stat?.ctimeMs) || 0,
        String(stat?.dev || ''),
        String(stat?.ino || ''),
      ].join(':');
    } catch (error) {
      this._assertOperation(operation);
      return 'missing';
    }
  }

  // gitService.getChangedFilesByCommit is fail-soft by contract, but a test
  // double or an unexpected shape must never break the scan either — any
  // non-ok result or thrown error degrades to no co-change signal.
  async _safeCochangeCommits(operation) {
    try {
      this._assertOperation(operation);
      const result = await this._gitService.getChangedFilesByCommit({
        limit: 200,
        signal: operation.signal,
      });
      this._assertOperation(operation);
      if (!result || result.ok !== true || !Array.isArray(result.commits)) {
        return { commits: [], truncated: false };
      }
      return {
        commits: result.commits.slice(0, MAX_COCHANGE_COMMITS),
        truncated: result.commits.length > MAX_COCHANGE_COMMITS,
      };
    } catch (error) {
      this._assertOperation(operation);
      return { commits: [], truncated: false };
    }
  }

  // gitService.listNonIgnoredFiles is an optional capability (a test double
  // may omit it, and older gitService shapes never had it) as well as
  // fail-soft by contract: any missing method, non-ok result, unexpected
  // shape, or thrown error degrades to null, which _scan reads as "no git
  // scope available" and falls back to the denylist partitioner.
  async _safeNonIgnoredFiles(operation, enumeratedFiles) {
    if (typeof this._gitService.listNonIgnoredFiles !== 'function') {
      return null;
    }
    try {
      this._assertOperation(operation);
      const result = await this._gitService.listNonIgnoredFiles({ signal: operation.signal });
      this._assertOperation(operation);
      if (!result || result.ok !== true || !Array.isArray(result.files)) {
        return null;
      }
      const maxEntries = MAX_SCAN_FILES;
      const candidates = new Set((Array.isArray(enumeratedFiles) ? enumeratedFiles : []).slice(0, maxEntries));
      const boundedGitFiles = result.files.slice(0, maxEntries);
      return {
        keepSet: new Set(boundedGitFiles.filter((relPath) => candidates.has(relPath))),
        truncated: result.files.length > maxEntries,
      };
    } catch (error) {
      this._assertOperation(operation);
      return null;
    }
  }

  _parseTsconfigAliases(raw) {
    try {
      return typeof this._scanRules.parseTsconfigAliases === 'function'
        ? this._scanRules.parseTsconfigAliases(raw)
        : this._scanRules.EMPTY_ALIASES;
    } catch (_error) {
      return this._scanRules.EMPTY_ALIASES;
    }
  }
}

module.exports = { WorkspaceFileMapService };
