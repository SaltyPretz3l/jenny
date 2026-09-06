'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { WorkspaceFileMapWorkerBuilder } = require('../services/workspace-file-map-worker');

class FakeWorker extends EventEmitter {
  static instances = [];

  constructor(workerPath, options) {
    super();
    this.workerPath = workerPath;
    this.options = options;
    this.terminateCalls = 0;
    FakeWorker.instances.push(this);
  }

  terminate() {
    this.terminateCalls += 1;
    return Promise.resolve(0);
  }
}

test('worker deadline is deterministic, rejects, and terminates the worker', async (t) => {
  FakeWorker.instances.length = 0;
  let scheduled = null;
  const builder = new WorkspaceFileMapWorkerBuilder({
    WorkerImpl: FakeWorker,
    workerPath: 'fake-worker.js',
    setTimeoutImpl: (callback, ms) => {
      scheduled = { callback, ms };
      return 1;
    },
    clearTimeoutImpl: () => {},
  });
  t.after(() => builder.dispose());

  const resultPromise = builder.build(Object.freeze({ files: [] }), { timeoutMs: 123 });
  assert.equal(scheduled.ms, 123);
  scheduled.callback();

  await assert.rejects(resultPromise, /exceeded 123 ms/);
  assert.equal(FakeWorker.instances[0].terminateCalls, 1);
});

test('abort signal cancels and terminates an in-flight worker without waiting', async (t) => {
  FakeWorker.instances.length = 0;
  const controller = new AbortController();
  const builder = new WorkspaceFileMapWorkerBuilder({
    WorkerImpl: FakeWorker,
    workerPath: 'fake-worker.js',
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
  });
  t.after(() => builder.dispose());

  const resultPromise = builder.build(Object.freeze({ files: [] }), { signal: controller.signal });
  controller.abort();

  await assert.rejects(resultPromise, /cancelled/);
  assert.equal(FakeWorker.instances[0].terminateCalls, 1);
});

test('dispose terminates every active worker and rejects future builds', async () => {
  FakeWorker.instances.length = 0;
  const builder = new WorkspaceFileMapWorkerBuilder({
    WorkerImpl: FakeWorker,
    workerPath: 'fake-worker.js',
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
  });
  const pending = [
    builder.build(Object.freeze({ files: [] })),
    builder.build(Object.freeze({ files: [] })),
  ];

  builder.dispose();

  assert.deepEqual(FakeWorker.instances.map((worker) => worker.terminateCalls), [1, 1]);
  await Promise.all(pending.map((promise) => assert.rejects(promise, /disposed/)));
  await assert.rejects(builder.build(Object.freeze({ files: [] })), /disposed/);
});

test('real worker keeps the main loop live and returns a bounded partial graph for 20k files', {
  timeout: 30_000,
}, async (t) => {
  const builder = new WorkspaceFileMapWorkerBuilder();
  t.after(() => builder.dispose());
  const files = Array.from({ length: 20_000 }, (_, index) => `src/f${index}.js`);
  const payload = Object.freeze({
    files,
    contentEntries: files.map((relPath) => [relPath, '']),
    cochangeCommits: [],
    budgets: {
      maxNodes: 2_000,
      maxEdges: 4_000,
      maxCochangePairs: 8_000,
      maxFilesPerCommit: 64,
    },
  });
  let heartbeats = 0;
  const heartbeat = setInterval(() => { heartbeats += 1; }, 0);

  let graph;
  try {
    graph = await builder.build(payload, { timeoutMs: 30_000 });
  } finally {
    clearInterval(heartbeat);
  }

  assert.ok(heartbeats > 0, 'worker build must yield the Electron/main event loop');
  assert.ok(graph.nodes.length <= 2_000);
  assert.equal(graph.meta.partial, true);
  assert.equal(graph.meta.truncated, true);
  assert.ok(graph.meta.truncationReasons.includes('node_limit'));
});
