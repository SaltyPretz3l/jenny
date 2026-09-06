'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { WorkspaceFileMapService } = require('../services/workspace-file-map-service');
const { WorkspaceRootCoordinator } = require('../services/workspace-root-coordinator');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// --- Fakes -------------------------------------------------------------
// Constructor-injected fakes per this repo's DI convention: no real engine,
// scan-rules, ide-service, or git-service is required by these tests, so
// they stay fast and fully isolated.

function makeFakeIdeService({ files = [], workspaceRoot = '/fake/root', statByPath = {}, contentByPath = {} } = {}) {
  const calls = { listAllFiles: 0, listAllFilesPayloads: [], stat: [], readFile: [] };
  const rootContext = Object.freeze({
    rootPath: workspaceRoot,
    rootId: workspaceRoot ? `root:${workspaceRoot}` : null,
    generation: 0,
    phase: 'ready',
  });
  const fake = {
    _calls: calls,
    getRootState() {
      return { workspaceRoot, workspaceRootStatus: 'ready' };
    },
    async listAllFiles(payload = {}) {
      calls.listAllFiles += 1;
      calls.listAllFilesPayloads.push({ ...payload });
      return {
        files: files.slice(), truncated: false, truncationReason: null, totalsKnown: true,
        filesScanned: files.length, directoriesScanned: 1, entriesScanned: files.length, elapsedMs: 4,
      };
    },
    async stat({ path } = {}) {
      calls.stat.push(path);
      const entry = statByPath[path];
      if (!entry) return { path, exists: false, kind: 'missing', size: 0, mtimeMs: 0 };
      return { path, exists: true, kind: 'file', size: entry.size || 0, mtimeMs: entry.mtimeMs || 0 };
    },
    async readFile({ path } = {}) {
      calls.readFile.push(path);
      if (!(path in contentByPath)) {
        const err = new Error('not found');
        err.code = 'CMP-WORKSPACEFS-0004';
        throw err;
      }
      return { path, content: contentByPath[path], size: contentByPath[path].length, mtimeMs: (statByPath[path] || {}).mtimeMs || 0, eol: 'lf' };
    },
    async acquireRootOperation() {
      if (!workspaceRoot) {
        const error = new Error('No workspace root is configured.');
        error.code = 'CMP-WORKSPACEFS-0001';
        throw error;
      }
      let released = false;
      return {
        acquired: true,
        context: rootContext,
        root: { configuredPath: workspaceRoot, realPath: workspaceRoot },
        signal: new AbortController().signal,
        isCurrent: () => !released,
        release: () => {
          if (released) return false;
          released = true;
          return true;
        },
      };
    },
  };
  fake.versionedFileService = {
    async readText({ path } = {}) {
      calls.readFile.push(path);
      if (!(path in contentByPath)) {
        const error = new Error('not found');
        error.code = 'CMP-WORKSPACEFS-0004';
        throw error;
      }
      const content = contentByPath[path];
      const mtimeMs = (statByPath[path] || {}).mtimeMs || 0;
      return {
        path,
        content,
        size: content.length,
        mtimeMs,
        fileVersion: `fake:${mtimeMs}:${content}`,
        rootId: rootContext.rootId,
        generation: rootContext.generation,
      };
    },
  };
  return fake;
}

// `nonIgnored`, when an array, adds a `listNonIgnoredFiles` method to the
// fake (git-scoped scan). Omitting it (the default for all pre-existing
// callers) keeps the fake WITHOUT that method, so WorkspaceFileMapService's
// `_safeNonIgnoredFiles` capability check falls through to the no-git
// denylist fallback — preserving every existing test's behavior unchanged.
function makeFakeGitService({ ok = true, commits = [], throwError = false, nonIgnored = null } = {}) {
  const calls = { getChangedFilesByCommit: 0, listNonIgnoredFiles: 0 };
  const fake = {
    _calls: calls,
    async getChangedFilesByCommit(payload) {
      calls.getChangedFilesByCommit += 1;
      if (throwError) {
        throw new Error('git exploded');
      }
      if (!ok) {
        return { ok: false, available: true, isRepo: false, op: 'getChangedFilesByCommit' };
      }
      return { ok: true, available: true, isRepo: true, op: 'getChangedFilesByCommit', commits, requestedLimit: payload?.limit };
    },
  };
  if (Array.isArray(nonIgnored)) {
    fake.listNonIgnoredFiles = async () => {
      calls.listNonIgnoredFiles += 1;
      return { ok: true, available: true, isRepo: true, op: 'listNonIgnoredFiles', files: nonIgnored.slice() };
    };
  }
  return fake;
}

function makeFakeEngine() {
  const calls = { buildGraph: [] };
  return {
    _calls: calls,
    buildGraph(args) {
      calls.buildGraph.push(args);
      // Minimal deterministic stand-in graph shape.
      return {
        nodes: (args.files || []).map((f) => ({ id: f })),
        edges: [],
        findings: { hubs: [], cycles: [], orphans: [] },
        meta: { scanned: (args.files || []).length, total: (args.files || []).length, durationMs: 0 },
      };
    },
  };
}

function makeFakeScanRules({ aliases = { baseUrl: null, paths: {} } } = {}) {
  return {
    EMPTY_ALIASES: { baseUrl: null, paths: {} },
    parseTsconfigAliases() {
      return aliases;
    },
    isDependencyContentPath(relPath) {
      return /\.(?:[cm]?[jt]sx?|py|css|html?)$/i.test(relPath);
    },
  };
}

describe('WorkspaceFileMapService — caching', () => {
  test('getGraph triggers a scan on first call and returns a cached graph on the second', async () => {
    const ideService = makeFakeIdeService({
      files: ['a.js', 'b.js'],
      statByPath: { 'a.js': { mtimeMs: 100 }, 'b.js': { mtimeMs: 200 } },
      contentByPath: { 'a.js': 'const a = 1;', 'b.js': 'const b = 2;' },
    });
    const gitService = makeFakeGitService({ commits: [] });
    const engine = makeFakeEngine();
    const scanRules = makeFakeScanRules();
    const svc = new WorkspaceFileMapService({ ideService, gitService, engine, scanRules });

    const first = await svc.getGraph('ws-1');
    assert.equal(first.ok, true);
    assert.equal(ideService._calls.listAllFiles, 1);
    assert.equal(engine._calls.buildGraph.length, 1);

    const second = await svc.getGraph('ws-1');
    assert.equal(second.ok, true);
    assert.equal(ideService._calls.listAllFiles, 1, 'second getGraph must not re-list files (cache hit)');
    assert.equal(engine._calls.buildGraph.length, 1, 'second getGraph must not rebuild the graph');
    assert.equal(second.graph, first.graph, 'same cached graph instance returned');
  });

  test('refresh always re-scans even when a graph is already cached', async () => {
    const ideService = makeFakeIdeService({
      files: ['a.js'],
      statByPath: { 'a.js': { mtimeMs: 100 } },
      contentByPath: { 'a.js': 'const a = 1;' },
    });
    const gitService = makeFakeGitService({ commits: [] });
    const engine = makeFakeEngine();
    const scanRules = makeFakeScanRules();
    const svc = new WorkspaceFileMapService({ ideService, gitService, engine, scanRules });

    await svc.getGraph('ws-1');
    assert.equal(ideService._calls.listAllFiles, 1);

    const refreshed = await svc.refresh('ws-1');
    assert.equal(refreshed.ok, true);
    assert.equal(ideService._calls.listAllFiles, 2, 'refresh must re-list files');
    assert.equal(engine._calls.buildGraph.length, 2, 'refresh must rebuild the graph');

    // A subsequent getGraph call should hit the freshly-cached graph from refresh.
    await svc.getGraph('ws-1');
    assert.equal(ideService._calls.listAllFiles, 2, 'getGraph after refresh must reuse the refreshed cache');
  });

  test('changing or empty renderer workspace ids share the canonical root cache', async () => {
    const ideService = makeFakeIdeService({
      files: ['a.js'],
      statByPath: { 'a.js': { mtimeMs: 1 } },
      contentByPath: { 'a.js': 'x' },
    });
    const gitService = makeFakeGitService({ commits: [] });
    const engine = makeFakeEngine();
    const scanRules = makeFakeScanRules();
    const svc = new WorkspaceFileMapService({ ideService, gitService, engine, scanRules });

    await svc.getGraph('ws-a');
    await svc.getGraph('ws-b');
    await svc.getGraph('');
    assert.equal(ideService._calls.listAllFiles, 1, 'caller ids never partition a canonical root cache');
  });

  test('a new generation of the same canonical root gets an isolated cache', async () => {
    const ideService = makeFakeIdeService({
      files: ['a.js'], statByPath: { 'a.js': { mtimeMs: 1 } }, contentByPath: { 'a.js': 'x' },
    });
    let generation = 1;
    ideService.acquireRootOperation = async () => {
      const captured = generation;
      let released = false;
      return {
        acquired: true,
        context: { rootId: 'canonical-root', generation: captured },
        signal: new AbortController().signal,
        isCurrent: () => !released && generation === captured,
        release: () => { released = true; },
      };
    };
    ideService.versionedFileService.readText = async ({ path }) => ({
      path, content: 'x', fileVersion: `v${generation}`, rootId: 'canonical-root', generation,
    });
    const service = new WorkspaceFileMapService({
      ideService, gitService: makeFakeGitService(), engine: makeFakeEngine(), scanRules: makeFakeScanRules(),
    });

    const first = await service.getGraph('same-caller');
    generation = 2;
    const second = await service.getGraph('same-caller');

    assert.equal(ideService._calls.listAllFiles, 2);
    assert.notEqual(first.graph, second.graph);
    assert.equal(second.graph.meta.generation, 2);
  });

  test('concurrent reads single-flight while a forced refresh queues exactly once', async () => {
    const gate = deferred();
    const ideService = makeFakeIdeService({ files: [] });
    const originalList = ideService.listAllFiles;
    let first = true;
    ideService.listAllFiles = async (payload, operation) => {
      if (first) {
        first = false;
        await gate.promise;
      }
      return originalList.call(ideService, payload, operation);
    };
    const engine = makeFakeEngine();
    const svc = new WorkspaceFileMapService({
      ideService, gitService: makeFakeGitService(), engine, scanRules: makeFakeScanRules(),
    });

    const readA = svc.getGraph('caller-a');
    const readB = svc.getGraph('caller-b');
    const refreshA = svc.refresh('caller-c');
    const refreshB = svc.refresh('caller-d');
    await Promise.resolve();
    assert.equal(ideService._calls.listAllFiles, 0, 'the first enumeration is still behind the gate');
    gate.resolve();
    const [a, b, refreshedA, refreshedB] = await Promise.all([readA, readB, refreshA, refreshB]);

    assert.equal(a.graph, b.graph, 'concurrent cache reads join one scan');
    assert.equal(refreshedA.graph, refreshedB.graph, 'forced waiters join one queued refresh');
    assert.equal(ideService._calls.listAllFiles, 2, 'one initial scan plus one forced refresh');
  });

});

describe('WorkspaceFileMapService — content cache reuse by mtime', () => {
  test('an unchanged file is not re-read on a second scan; a changed file is', async () => {
    const statByPath = { 'a.js': { mtimeMs: 100 }, 'b.js': { mtimeMs: 200 } };
    const contentByPath = { 'a.js': 'const a = 1;', 'b.js': 'const b = 2;' };
    const ideService = makeFakeIdeService({ files: ['a.js', 'b.js'], statByPath, contentByPath });
    const gitService = makeFakeGitService({ commits: [] });
    const engine = makeFakeEngine();
    const scanRules = makeFakeScanRules();
    const svc = new WorkspaceFileMapService({ ideService, gitService, engine, scanRules });

    await svc.getGraph('ws-1');
    assert.deepEqual(ideService._calls.readFile.sort(), ['a.js', 'b.js']);

    // Simulate b.js changing on disk (new mtime + new content); a.js stays put.
    statByPath['b.js'] = { mtimeMs: 201 };
    contentByPath['b.js'] = 'const b = 999;';
    ideService._calls.readFile.length = 0;

    await svc.refresh('ws-1');
    assert.deepEqual(ideService._calls.readFile, ['b.js'], 'only the changed file is re-read; unchanged a.js is skipped');
  });
});

describe('WorkspaceFileMapService — fail-soft git integration', () => {
  test('a git ok:false result yields an empty cochangeCommits list, not an error', async () => {
    const ideService = makeFakeIdeService({
      files: ['a.js'],
      statByPath: { 'a.js': { mtimeMs: 1 } },
      contentByPath: { 'a.js': 'x' },
    });
    const gitService = makeFakeGitService({ ok: false });
    const engine = makeFakeEngine();
    const scanRules = makeFakeScanRules();
    const svc = new WorkspaceFileMapService({ ideService, gitService, engine, scanRules });

    const res = await svc.getGraph('ws-1');
    assert.equal(res.ok, true);
    assert.equal(engine._calls.buildGraph.length, 1);
    assert.deepEqual(engine._calls.buildGraph[0].cochangeCommits, []);
  });

  test('a throwing gitService still produces a graph with an empty cochangeCommits list', async () => {
    const ideService = makeFakeIdeService({
      files: ['a.js'],
      statByPath: { 'a.js': { mtimeMs: 1 } },
      contentByPath: { 'a.js': 'x' },
    });
    const gitService = makeFakeGitService({ throwError: true });
    const engine = makeFakeEngine();
    const scanRules = makeFakeScanRules();
    const svc = new WorkspaceFileMapService({ ideService, gitService, engine, scanRules });

    const res = await svc.getGraph('ws-1');
    assert.equal(res.ok, true);
    assert.deepEqual(engine._calls.buildGraph[0].cochangeCommits, []);
  });

  test('real commits are threaded through to engine.buildGraph unchanged', async () => {
    const ideService = makeFakeIdeService({
      files: ['a.js', 'b.js'],
      statByPath: { 'a.js': { mtimeMs: 1 }, 'b.js': { mtimeMs: 2 } },
      contentByPath: { 'a.js': 'x', 'b.js': 'y' },
    });
    const commits = [{ hash: 'abc', files: ['a.js', 'b.js'] }];
    const gitService = makeFakeGitService({ commits });
    const engine = makeFakeEngine();
    const scanRules = makeFakeScanRules();
    const svc = new WorkspaceFileMapService({ ideService, gitService, engine, scanRules });

    await svc.getGraph('ws-1');
    assert.deepEqual(engine._calls.buildGraph[0].cochangeCommits, commits);
  });
});

describe('WorkspaceFileMapService — no workspace root', () => {
  test('getGraph returns a clean ok:false result when no workspace root is configured', async () => {
    const ideService = makeFakeIdeService({ workspaceRoot: '' });
    const gitService = makeFakeGitService({ commits: [] });
    const engine = makeFakeEngine();
    const scanRules = makeFakeScanRules();
    const svc = new WorkspaceFileMapService({ ideService, gitService, engine, scanRules });

    const res = await svc.getGraph('ws-1');
    assert.equal(res.ok, false);
    assert.equal(typeof res.reason, 'string');
    assert.ok(res.reason.startsWith('CMP-'), 'reason follows the CMP-<DOMAIN>-<NNNN> convention');
    assert.equal(ideService._calls.listAllFiles, 0, 'no scan is attempted without a root');
  });
});

describe('WorkspaceFileMapService — immutable root operations', () => {
  function createCoordinator(rootPath) {
    return new WorkspaceRootCoordinator({
      initialRootPath: rootPath,
      normalizeRootPath: (value) => String(value || ''),
      rootIdFactory: (value) => value ? `root:${String(value).toLowerCase()}` : null,
    });
  }

  function makeRootAwareIdeService(coordinator, readText) {
    return {
      getRootState() {
        return { workspaceRoot: coordinator.captureContext().rootPath };
      },
      async acquireRootOperation() {
        const lease = coordinator.acquireOperation({ kind: 'read', cancellable: true });
        if (!lease?.acquired) {
          const error = new Error('root unavailable');
          error.code = 'CMP-WORKSPACEFS-0008';
          throw error;
        }
        return {
          ...lease,
          root: {
            configuredPath: lease.context.rootPath,
            realPath: lease.context.rootPath,
          },
        };
      },
      async listAllFiles() {
        return { files: ['same.js'], truncated: false };
      },
      async stat() {
        return { path: 'same.js', exists: true, kind: 'file', size: 1, mtimeMs: 1, ctimeMs: 1 };
      },
      readFile: readText,
      versionedFileService: { readText },
    };
  }

  function contentEngine() {
    return {
      buildGraph({ files, readContent }) {
        return {
          nodes: files.map((id) => ({ id, content: readContent(id) })),
          edges: [],
          findings: { hubs: [], cycles: [], orphans: [] },
          meta: {},
        };
      },
    };
  }

  test('an A→B switch during a same-relative-path read discards the scan instead of caching mixed-root data', async () => {
    const rootA = '/workspace/A';
    const rootB = '/workspace/B';
    const coordinator = createCoordinator(rootA);
    const readStarted = deferred();
    const finishRead = deferred();
    const readText = async ({ path } = {}) => {
      readStarted.resolve();
      await finishRead.promise;
      const context = coordinator.captureContext();
      const content = context.rootPath === rootA ? 'from-a' : 'from-b';
      return {
        path,
        content,
        size: content.length,
        mtimeMs: 1,
        fileVersion: `${context.rootId}:${content}`,
        rootId: context.rootId,
        generation: context.generation,
      };
    };
    const ideService = makeRootAwareIdeService(coordinator, readText);
    const service = new WorkspaceFileMapService({
      ideService,
      gitService: makeFakeGitService(),
      engine: contentEngine(),
      scanRules: makeFakeScanRules(),
    });

    const scanPromise = service.refresh('same-workspace-id');
    await readStarted.promise;
    const prepared = await coordinator.prepareTarget(rootB);
    const committed = await coordinator.commit({ transitionId: prepared.transitionId });
    assert.equal(committed.committed, true);
    finishRead.resolve();

    const result = await scanPromise;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'CMP-WORKSPACEFS-0008');
    assert.equal(result.partial, false);
  });

  test('a cache key is bound to root identity and generation, not a renderer-supplied workspace id', async () => {
    const rootA = '/workspace/A';
    const rootB = '/workspace/B';
    const coordinator = createCoordinator(rootA);
    const readText = async ({ path } = {}) => {
      const context = coordinator.captureContext();
      const content = context.rootPath === rootA ? 'from-a' : 'from-b';
      return {
        path,
        content,
        size: content.length,
        mtimeMs: context.generation + 1,
        fileVersion: `${context.rootId}:${context.generation}:${content}`,
        rootId: context.rootId,
        generation: context.generation,
      };
    };
    const ideService = makeRootAwareIdeService(coordinator, readText);
    const service = new WorkspaceFileMapService({
      ideService,
      gitService: makeFakeGitService(),
      engine: contentEngine(),
      scanRules: makeFakeScanRules(),
    });

    const first = await service.getGraph('shared-id');
    assert.equal(first.graph.nodes[0].content, 'from-a');
    const prepared = await coordinator.prepareTarget(rootB);
    await coordinator.commit({ transitionId: prepared.transitionId });
    const second = await service.getGraph('shared-id');

    assert.equal(second.ok, true);
    assert.equal(second.graph.nodes[0].content, 'from-b');
    assert.notEqual(second.graph, first.graph);
  });

  test('a versioned read from another root fails the whole scan while the outer lease is current', async () => {
    const ideService = makeFakeIdeService({
      files: ['same.js'],
      statByPath: { 'same.js': { mtimeMs: 1 } },
      contentByPath: { 'same.js': 'wrong-root-content' },
    });
    ideService.versionedFileService.readText = async ({ path } = {}) => ({
      path,
      content: 'wrong-root-content',
      fileVersion: 'wrong-root-version',
      rootId: 'root:/different/workspace',
      generation: 0,
    });
    const engine = makeFakeEngine();
    const service = new WorkspaceFileMapService({
      ideService,
      gitService: makeFakeGitService(),
      engine,
      scanRules: makeFakeScanRules(),
    });

    const result = await service.refresh('same-workspace-id');

    assert.deepEqual(result, {
      ok: false,
      reason: 'CMP-WORKSPACEFS-0008',
      partial: false,
    });
    assert.equal(engine._calls.buildGraph.length, 0);
  });

  test('missing operation or versioned-file owners fail closed with a structured result', async () => {
    const ideService = makeFakeIdeService({
      files: ['a.js'],
      statByPath: { 'a.js': { mtimeMs: 1 } },
      contentByPath: { 'a.js': 'unsafe fallback' },
    });
    delete ideService.acquireRootOperation;
    delete ideService.versionedFileService;
    const service = new WorkspaceFileMapService({
      ideService,
      gitService: makeFakeGitService(),
      engine: contentEngine(),
      scanRules: makeFakeScanRules(),
    });

    const result = await service.getGraph('ws-1');

    assert.deepEqual(result, {
      ok: false,
      reason: 'CMP-WORKSPACEFS-0008',
      partial: false,
    });
    assert.equal(ideService._calls.listAllFiles, 0);
    assert.deepEqual(ideService._calls.readFile, []);
  });

  test('a root-generation change aborts the in-flight graph builder and never caches its result', async (t) => {
    const rootA = '/workspace/A';
    const rootB = '/workspace/B';
    const coordinator = createCoordinator(rootA);
    const readText = async ({ path } = {}) => {
      const context = coordinator.captureContext();
      return {
        path,
        content: 'export {};',
        size: 10,
        mtimeMs: 1,
        fileVersion: `${context.rootId}:1`,
        rootId: context.rootId,
        generation: context.generation,
      };
    };
    const ideService = makeRootAwareIdeService(coordinator, readText);
    const builderStarted = deferred();
    let abortObserved = false;
    const graphBuilder = (_payload, { signal }) => new Promise((_resolve, reject) => {
      builderStarted.resolve();
      const rejectCancelled = () => {
        abortObserved = true;
        const error = new Error('cancelled by root generation');
        error.code = 'CMP-WORKSPACEFS-0008';
        reject(error);
      };
      if (signal.aborted) rejectCancelled();
      else signal.addEventListener('abort', rejectCancelled, { once: true });
    });
    const service = new WorkspaceFileMapService({
      ideService,
      gitService: makeFakeGitService(),
      scanRules: makeFakeScanRules(),
      graphBuilder,
    });
    t.after(() => service.dispose());

    const scanPromise = service.refresh('shared-id');
    await builderStarted.promise;
    const prepared = await coordinator.prepareTarget(rootB);
    const committed = await coordinator.commit({ transitionId: prepared.transitionId });
    const result = await scanPromise;

    assert.equal(committed.committed, true);
    assert.equal(abortObserved, true);
    assert.deepEqual(result, {
      ok: false,
      reason: 'CMP-WORKSPACEFS-0008',
      partial: false,
    });
    assert.equal(service._cacheByRoot.size, 0);
  });

  test('scan and cache caps stop before excess entries and report explicit partial metadata', async (t) => {
    const files = ['a.js', 'b.js', 'c.js'];
    const ideService = makeFakeIdeService({
      files,
      statByPath: {
        'a.js': { size: 1, mtimeMs: 1 },
        'b.js': { size: 1, mtimeMs: 2 },
        'c.js': { size: 1, mtimeMs: 3 },
      },
      contentByPath: { 'a.js': 'a', 'b.js': 'b', 'c.js': 'c' },
    });
    const service = new WorkspaceFileMapService({
      ideService,
      gitService: makeFakeGitService({ nonIgnored: files }),
      engine: makeFakeEngine(),
      scanRules: makeFakeScanRules(),
      scanBudgets: { maxFiles: 2, maxCacheEntries: 1, maxCacheBytes: 100 },
    });
    t.after(() => service.dispose());

    const result = await service.refresh('ws-1');

    assert.equal(result.ok, true);
    assert.deepEqual(ideService._calls.readFile.sort(), ['a.js', 'b.js']);
    assert.equal(result.graph.meta.partial, true);
    assert.equal(result.graph.meta.truncated, true);
    assert.ok(result.graph.meta.truncationReasons.includes('file_limit'));
    assert.equal(result.graph.meta.serviceBudget.filesSeen, 3);
    assert.equal(result.graph.meta.serviceBudget.filesAccepted, 2);
    assert.equal(result.graph.meta.serviceBudget.cacheEntries, 1);
    assert.equal(result.graph.meta.serviceBudget.cacheTruncated, true);
  });

  test('aggregate content-byte budget stops further payload retention with a typed reason', async (t) => {
    const ideService = makeFakeIdeService({
      files: ['a.js'],
      statByPath: { 'a.js': { size: 6, mtimeMs: 1 } },
      contentByPath: { 'a.js': 'abcdef' },
    });
    let capturedPayload = null;
    const service = new WorkspaceFileMapService({
      ideService,
      gitService: makeFakeGitService({ nonIgnored: ['a.js'] }),
      scanRules: makeFakeScanRules(),
      scanBudgets: { maxContentBytes: 5 },
      graphBuilder: async (payload) => {
        capturedPayload = payload;
        return {
          nodes: [{ id: 'a.js' }],
          edges: [],
          findings: { hubs: [], cycles: [], orphans: [] },
          meta: { scanned: 0, total: 1, durationMs: 0 },
        };
      },
    });
    t.after(() => service.dispose());

    const result = await service.refresh('ws-1');

    assert.equal(result.ok, true);
    assert.deepEqual(capturedPayload.contentEntries, []);
    assert.ok(result.graph.meta.truncationReasons.includes('content_byte_limit'));
    assert.equal(result.graph.meta.serviceBudget.contentBytes, 0);
    assert.equal(result.graph.meta.serviceBudget.contentByteLimit, 5);
  });

  test('content read failures make the result partial and report an exact count', async () => {
    const ideService = makeFakeIdeService({
      files: ['missing.js'], statByPath: { 'missing.js': { size: 1, mtimeMs: 1 } }, contentByPath: {},
    });
    const service = new WorkspaceFileMapService({
      ideService, gitService: makeFakeGitService(), engine: makeFakeEngine(), scanRules: makeFakeScanRules(),
    });

    const result = await service.refresh('caller');

    assert.equal(result.graph.meta.partial, true);
    assert.ok(result.graph.meta.truncationReasons.includes('content_read_failure'));
    assert.equal(result.graph.meta.serviceBudget.contentReadFailures, 1);
  });

  test('uses the File Map deadline and spends content bytes on tsconfig and dependency sources first', async (t) => {
    const files = ['notes.txt', 'src/app.js', 'tsconfig.json'];
    const ideService = makeFakeIdeService({
      files,
      statByPath: Object.fromEntries(files.map((path, index) => [path, { size: 1, mtimeMs: index + 1 }])),
      contentByPath: { 'notes.txt': 'n', 'src/app.js': '1234567890', 'tsconfig.json': '{}' },
    });
    const logs = [];
    let capturedPayload = null;
    const service = new WorkspaceFileMapService({
      ideService,
      gitService: makeFakeGitService({ nonIgnored: files }),
      scanRules: makeFakeScanRules(),
      scanBudgets: { maxContentBytes: 12 },
      logger: (level, event, details) => logs.push({ level, event, details }),
      graphBuilder: async (payload) => {
        capturedPayload = payload;
        return {
          nodes: payload.files.map((id) => ({ id })), edges: [],
          findings: { hubs: [], cycles: [], orphans: [] }, meta: {},
        };
      },
    });
    t.after(() => service.dispose());

    const result = await service.refresh('unstable-renderer-id');

    assert.equal(ideService._calls.listAllFilesPayloads[0].maxDurationMs, 10_000);
    assert.deepEqual(capturedPayload.files, files, 'graph ordering remains enumeration ordering');
    assert.deepEqual(capturedPayload.contentEntries.map(([path]) => path), ['tsconfig.json', 'src/app.js']);
    assert.deepEqual(result.graph.meta.enumeration, {
      truncated: false, reason: null, totalsKnown: true, filesScanned: 3,
      directoriesScanned: 1, entriesScanned: 3, elapsedMs: 4,
    });
    assert.equal(result.graph.meta.serviceBudget.dependencyFilesEligible, 1);
    assert.equal(result.graph.meta.serviceBudget.dependencyFilesAnalyzed, 1);
    assert.equal(result.graph.meta.serviceBudget.contentFilesAnalyzed, 2);
    assert.equal(result.graph.meta.serviceBudget.contentFilesSkippedByBudget, 1);
    const scanLog = logs.find((entry) => entry.event === 'workspace_file_map.scan');
    assert.equal(scanLog.details.workspace_id, 'root:/fake/root');
    assert.equal(scanLog.details.root_generation, 0);
    assert.equal(scanLog.details.caller_workspace_id, 'unstable-renderer-id');
  });

  test('dispose aborts worker work and prevents a late cache write', async () => {
    const ideService = makeFakeIdeService({
      files: ['a.js'], statByPath: { 'a.js': { mtimeMs: 1 } }, contentByPath: { 'a.js': 'x' },
    });
    const started = deferred();
    let observedAbort = false;
    const service = new WorkspaceFileMapService({
      ideService,
      gitService: makeFakeGitService(),
      scanRules: makeFakeScanRules(),
      graphBuilder: (_payload, { signal }) => new Promise((_resolve, reject) => {
        started.resolve();
        signal.addEventListener('abort', () => {
          observedAbort = true;
          reject(new Error('disposed'));
        }, { once: true });
      }),
    });

    const pending = service.refresh('caller');
    await started.promise;
    service.dispose();
    const result = await pending;

    assert.equal(observedAbort, true);
    assert.deepEqual(result, { ok: false, reason: 'CMP-WORKSPACEFS-0008', partial: false });
    assert.equal(service._cacheByRoot.size, 0);
  });

  test('git scope and co-change responses are capped before Set/map materialization', async (t) => {
    const ideService = makeFakeIdeService({
      files: ['a.js'],
      statByPath: { 'a.js': { size: 1, mtimeMs: 1 } },
      contentByPath: { 'a.js': 'a' },
    });
    const nonIgnored = ['a.js'];
    for (let index = 0; index < 20_000; index += 1) nonIgnored.push(`extra-${index}.js`);
    const commits = Array.from({ length: 201 }, (_, index) => ({
      hash: `commit-${index}`,
      files: Array.from({ length: 1_000 }, (_unused, fileIndex) => `f${fileIndex}.js`),
    }));
    let capturedPayload = null;
    const service = new WorkspaceFileMapService({
      ideService,
      gitService: makeFakeGitService({ nonIgnored, commits }),
      scanRules: makeFakeScanRules(),
      graphBuilder: async (payload) => {
        capturedPayload = payload;
        return {
          nodes: [{ id: 'a.js' }],
          edges: [],
          findings: { hubs: [], cycles: [], orphans: [] },
          meta: { scanned: 1, total: 1, durationMs: 0 },
        };
      },
    });
    t.after(() => service.dispose());

    const result = await service.refresh('ws-1');

    assert.equal(result.ok, true);
    assert.equal(capturedPayload.cochangeCommits.length, 200);
    assert.equal(capturedPayload.cochangeCommits[0].files.length, 257);
    assert.ok(result.graph.meta.truncationReasons.includes('git_scope_limit'));
    assert.ok(result.graph.meta.truncationReasons.includes('cochange_commit_limit'));
  });
});

describe('WorkspaceFileMapService — constructor contract', () => {
  test('requires both ideService and gitService', () => {
    assert.throws(() => new WorkspaceFileMapService({ gitService: makeFakeGitService() }), TypeError);
    assert.throws(() => new WorkspaceFileMapService({ ideService: makeFakeIdeService() }), TypeError);
  });
});

describe('WorkspaceFileMapService — off-main graph builder seam', () => {
  test('an injected asynchronous graph builder owns the CPU phase and receives immutable scan data', async (t) => {
    const ideService = makeFakeIdeService({
      files: ['a.js'],
      statByPath: { 'a.js': { size: 11, mtimeMs: 1 } },
      contentByPath: { 'a.js': 'export {};' },
    });
    const engine = {
      buildGraph() {
        throw new Error('the synchronous engine must not run on the service path');
      },
    };
    let captured = null;
    const graphBuilder = async (payload, options) => {
      captured = { payload, options };
      return {
        nodes: [{ id: 'a.js' }],
        edges: [],
        findings: { hubs: [], cycles: [], orphans: [] },
        meta: { scanned: 1, total: 1, durationMs: 0, partial: false, truncated: false },
      };
    };
    const service = new WorkspaceFileMapService({
      ideService,
      gitService: makeFakeGitService({ nonIgnored: ['a.js'] }),
      engine,
      scanRules: makeFakeScanRules(),
      graphBuilder,
    });
    t.after(() => service.dispose?.());

    const result = await service.refresh('ws-1');

    assert.equal(result.ok, true);
    assert.equal(captured.payload.files[0], 'a.js');
    assert.deepEqual(captured.payload.contentEntries, [['a.js', 'export {};']]);
    assert.equal(captured.options.signal.aborted, false);
    assert.ok(Object.isFrozen(captured.payload));
    assert.ok(Object.isFrozen(captured.payload.files));
  });

  test('default graph build yields the event loop after the final file read', async (t) => {
    const ideService = makeFakeIdeService({
      files: ['a.js'],
      statByPath: { 'a.js': { size: 11, mtimeMs: 1 } },
      contentByPath: { 'a.js': 'export {};' },
    });
    const originalReadText = ideService.versionedFileService.readText;
    let heartbeat = false;
    ideService.versionedFileService.readText = async (request) => {
      const value = await originalReadText(request);
      setImmediate(() => { heartbeat = true; });
      return value;
    };
    const service = new WorkspaceFileMapService({
      ideService,
      gitService: makeFakeGitService({ nonIgnored: ['a.js'] }),
      scanRules: makeFakeScanRules(),
    });
    t.after(() => service.dispose?.());

    const result = await service.refresh('ws-1');

    assert.equal(result.ok, true);
    assert.equal(heartbeat, true, 'worker build must let the scheduled main-thread heartbeat run');
  });
});

describe('WorkspaceFileMapService — gitignore-aware scope + bucket nodes', () => {
  test('a git-provided keepSet scopes the scan: excluded files are never read, and appear as bucket nodes', async () => {
    const ideService = makeFakeIdeService({
      files: ['src/a.js', 'src/b.js', 'node_modules/pkg/index.js', 'artifacts/out.bin'],
      statByPath: { 'src/a.js': { mtimeMs: 1 }, 'src/b.js': { mtimeMs: 2 } },
      contentByPath: { 'src/a.js': 'const a = 1;', 'src/b.js': 'const b = 2;' },
    });
    const gitService = makeFakeGitService({ commits: [], nonIgnored: ['src/a.js', 'src/b.js'] });
    const engine = makeFakeEngine();
    const scanRules = makeFakeScanRules();
    const svc = new WorkspaceFileMapService({ ideService, gitService, engine, scanRules });

    const res = await svc.getGraph('ws-1');
    assert.equal(res.ok, true);
    assert.equal(gitService._calls.listNonIgnoredFiles, 1);

    assert.deepEqual(engine._calls.buildGraph[0].files, ['src/a.js', 'src/b.js'], 'engine only sees the kept files');
    assert.deepEqual(ideService._calls.readFile.sort(), ['src/a.js', 'src/b.js'], 'excluded files are never read');

    const bucketNodes = res.graph.nodes.filter((n) => n.bucket === true);
    assert.deepEqual(bucketNodes.map((n) => n.id).sort(), ['bucket:artifacts', 'bucket:node_modules']);
    assert.ok(bucketNodes.every((n) => n.count === 1), 'each excluded top-level dir had exactly one file');

    assert.equal(res.graph.meta.gitFiltered, true);
    assert.equal(res.graph.meta.included, 2);
    assert.equal(res.graph.meta.ignored, 2);
    assert.equal(res.graph.meta.bucketCount, 2);
  });

  test('no gitService.listNonIgnoredFiles falls back to the denylist scanner: dist/binaries bucketed, source kept', async () => {
    const ideService = makeFakeIdeService({
      files: ['src/a.js', 'dist/bundle.js', 'assets/logo.png'],
      statByPath: { 'src/a.js': { mtimeMs: 1 } },
      contentByPath: { 'src/a.js': 'const a = 1;' },
    });
    const gitService = makeFakeGitService({ commits: [] }); // no listNonIgnoredFiles on this fake
    const engine = makeFakeEngine();
    const scanRules = makeFakeScanRules();
    const svc = new WorkspaceFileMapService({ ideService, gitService, engine, scanRules });

    const res = await svc.getGraph('ws-1');
    assert.equal(res.ok, true);
    assert.deepEqual(engine._calls.buildGraph[0].files, ['src/a.js']);
    assert.deepEqual(ideService._calls.readFile, ['src/a.js']);

    const bucketNodes = res.graph.nodes.filter((n) => n.bucket === true);
    assert.deepEqual(bucketNodes.map((n) => n.id).sort(), ['bucket:assets', 'bucket:dist']);
    assert.equal(res.graph.meta.gitFiltered, false);
    assert.equal(res.graph.meta.included, 1);
    assert.equal(res.graph.meta.ignored, 2);
  });

  test('an omitted listNonIgnoredFiles keeps every pre-existing (all-source, no-bucket) test case unchanged', async () => {
    // Regression pin: existing fakes never implemented listNonIgnoredFiles,
    // so the fallback partitioner must reproduce the prior "scan everything"
    // behavior when every file is plain source (nothing denylisted).
    const ideService = makeFakeIdeService({
      files: ['a.js', 'b.js'],
      statByPath: { 'a.js': { mtimeMs: 100 }, 'b.js': { mtimeMs: 200 } },
      contentByPath: { 'a.js': 'const a = 1;', 'b.js': 'const b = 2;' },
    });
    const gitService = makeFakeGitService({ commits: [] });
    const engine = makeFakeEngine();
    const scanRules = makeFakeScanRules();
    const svc = new WorkspaceFileMapService({ ideService, gitService, engine, scanRules });

    const res = await svc.getGraph('ws-1');
    assert.deepEqual(engine._calls.buildGraph[0].files, ['a.js', 'b.js']);
    assert.equal(res.graph.nodes.filter((n) => n.bucket === true).length, 0, 'no buckets when nothing is excluded');
  });

  test('a truncated listAllFiles result surfaces into graph.meta.truncated', async () => {
    const ideService = makeFakeIdeService({
      files: ['a.js'],
      statByPath: { 'a.js': { mtimeMs: 1 } },
      contentByPath: { 'a.js': 'x' },
    });
    ideService.listAllFiles = async () => {
      ideService._calls.listAllFiles += 1;
      return { files: ['a.js'], truncated: true };
    };
    const gitService = makeFakeGitService({ commits: [] });
    const engine = makeFakeEngine();
    const scanRules = makeFakeScanRules();
    const svc = new WorkspaceFileMapService({ ideService, gitService, engine, scanRules });

    const res = await svc.getGraph('ws-1');
    assert.equal(res.ok, true);
    assert.equal(res.graph.meta.truncated, true);
  });

  test('a throwing listNonIgnoredFiles falls back to the denylist scanner instead of failing the scan', async () => {
    const ideService = makeFakeIdeService({
      files: ['a.js'],
      statByPath: { 'a.js': { mtimeMs: 1 } },
      contentByPath: { 'a.js': 'x' },
    });
    const gitService = makeFakeGitService({ commits: [] });
    gitService.listNonIgnoredFiles = async () => { throw new Error('git exploded'); };
    const engine = makeFakeEngine();
    const scanRules = makeFakeScanRules();
    const svc = new WorkspaceFileMapService({ ideService, gitService, engine, scanRules });

    const res = await svc.getGraph('ws-1');
    assert.equal(res.ok, true);
    assert.equal(res.graph.meta.gitFiltered, false);
    assert.deepEqual(engine._calls.buildGraph[0].files, ['a.js']);
  });
});
