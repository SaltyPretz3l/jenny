'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  createWorkspaceIdeWatcher,
  normalizeWatchedRelPath,
  isGitMetaPath,
} = require('../services/workspace-ide-watcher');
const { WORKSPACE_FS_ERROR_CODES } = require('../services/workspace-ide-errors');
const { workspaceIdePathKey } = require('../services/workspace-ide-config-schema');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createFakeWatchImpl() {
  const watchers = [];
  const impl = (root, options, listener) => {
    const watcher = {
      root,
      options,
      listener,
      closed: false,
      close() {
        this.closed = true;
      },
      errorHandler: null,
      on(event, handler) { if (event === 'error') this.errorHandler = handler; },
      emitError(error) { this.errorHandler?.(error); },
      emit(eventType, filename) {
        listener(eventType, filename);
      },
    };
    watchers.push(watcher);
    return watcher;
  };
  impl.watchers = watchers;
  return impl;
}

function createHarness({ root = 'C:\\ws', files = {}, recentWrites = new Set(), maxBatch = 500 } = {}) {
  const state = { root, files, recentWrites };
  const payloads = [];
  const gitMetaEvents = [];
  const lifecycleEvents = [];
  const logs = [];
  const watchImpl = createFakeWatchImpl();
  const watcher = createWorkspaceIdeWatcher({
    getRoot: () => state.root,
    service: {
      consumeRecentWrite: (absPath, stats) => state.recentWrites.delete(`${absPath}|${stats?.mtimeMs}`),
    },
    emitChange: (payload) => payloads.push(payload),
    emitGitMeta: () => gitMetaEvents.push(Date.now()),
    emitLifecycle: (payload) => lifecycleEvents.push(payload),
    logger: (level, event, details) => logs.push({ level, event, details }),
    watchImpl,
    statImpl: async (absPath) => {
      const entry = state.files[absPath];
      return entry ? { mtimeMs: entry.mtimeMs } : null;
    },
    debounceMs: 20,
    maxBatch,
  });
  return { state, watcher, watchImpl, payloads, gitMetaEvents, lifecycleEvents, logs };
}


test('workspace-ide-watcher drops a 501-event node_modules burst without truncating the next batch', async () => {
  const root = 'C:\\ws';
  const { state, watcher, watchImpl, payloads, logs } = createHarness({ root });
  watcher.start();
  const [fake] = watchImpl.watchers;

  for (let index = 0; index < 501; index += 1) {
    fake.emit('change', `node_modules/package-${index}/index.js`);
  }
  await watcher.flush();

  assert.deepEqual(payloads, [], 'ignored paths never produce a change batch');
  assert.deepEqual(
    logs.filter(({ event }) => event === 'workspace_fs.watch_events_ignored'),
    [{
      level: 'DEBUG',
      event: 'workspace_fs.watch_events_ignored',
      details: { ignored_event_count: 501 },
    }]
  );

  state.files[path.join(root, 'src/app.js')] = { mtimeMs: 1 };
  fake.emit('change', 'src/app.js');
  await watcher.flush();
  assert.deepEqual(payloads, [{
    context: payloads[0].context,
    changes: [{ relPath: 'src/app.js', pathKey: workspaceIdePathKey('src/app.js'), kind: 'changed' }],
    truncated: false,
  }], 'ignored paths do not occupy pending slots or set overflow');
  assert.equal(
    logs.filter(({ event }) => event === 'workspace_fs.watch_events_ignored').length,
    1,
    'the ignored-event counter resets after reporting'
  );
  watcher.stop();
});

test('workspace-ide-watcher drops a burst beneath name-policy coverage directories', async () => {
  const { watcher, watchImpl, payloads } = createHarness({});
  watcher.start();
  const [fake] = watchImpl.watchers;

  for (let index = 0; index < 20; index += 1) {
    fake.emit('change', `coverage/chunk-${index}.json`);
  }
  await watcher.flush();

  assert.deepEqual(payloads, []);
  watcher.stop();
});

test('workspace-ide-watcher still delivers a real source-file change', async () => {
  const root = 'C:\\ws';
  const { state, watcher, watchImpl, payloads } = createHarness({ root });
  state.files[path.join(root, 'src/real.js')] = { mtimeMs: 1 };
  watcher.start();

  watchImpl.watchers[0].emit('change', 'src/real.js');
  await watcher.flush();

  assert.deepEqual(payloads[0].changes, [
    { relPath: 'src/real.js', pathKey: workspaceIdePathKey('src/real.js'), kind: 'changed' },
  ]);
  watcher.stop();
});

test('workspace-ide-watcher delivers a new file in a previously empty tracked directory', async () => {
  const root = 'C:\\ws';
  const { state, watcher, watchImpl, payloads } = createHarness({ root });
  state.files[path.join(root, 'tracked/new-file.js')] = { mtimeMs: 1 };
  watcher.start();

  watchImpl.watchers[0].emit('rename', 'tracked/new-file.js');
  await watcher.flush();

  assert.deepEqual(payloads[0].changes, [
    {
      relPath: 'tracked/new-file.js',
      pathKey: workspaceIdePathKey('tracked/new-file.js'),
      kind: 'changed',
    },
  ]);
  watcher.stop();
});

test('workspace-ide-watcher delivers a root file literally named coverage', async () => {
  const root = 'C:\\ws';
  const { state, watcher, watchImpl, payloads } = createHarness({ root });
  state.files[path.join(root, 'coverage')] = { mtimeMs: 1 };
  watcher.start();

  watchImpl.watchers[0].emit('change', 'coverage');
  await watcher.flush();

  assert.deepEqual(payloads[0].changes, [
    { relPath: 'coverage', pathKey: workspaceIdePathKey('coverage'), kind: 'changed' },
  ]);
  watcher.stop();
});

test('workspace-ide-watcher still truncates a 501-event real-source burst', async () => {
  const root = 'C:\\ws';
  const { state, watcher, watchImpl, payloads } = createHarness({ root });
  watcher.start();
  const [fake] = watchImpl.watchers;

  for (let index = 0; index < 501; index += 1) {
    const relPath = `src/file-${index}.js`;
    state.files[path.join(root, relPath)] = { mtimeMs: index };
    fake.emit('change', relPath);
  }
  await watcher.flush();

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].changes.length, 500);
  assert.equal(payloads[0].truncated, true);
  watcher.stop();
});

test('workspace-ide-watcher preserves queued order across staggered concurrent stats', async () => {
  const root = 'C:\\ws';
  const payloads = [];
  const watchImpl = createFakeWatchImpl();
  const delays = new Map([
    ['src/slow.js', 30],
    ['src/medium.js', 10],
    ['src/fast.js', 1],
  ]);
  const watcher = createWorkspaceIdeWatcher({
    getRoot: () => root,
    emitChange: (payload) => payloads.push(payload),
    watchImpl,
    statImpl: async (absPath) => {
      const relPath = path.relative(root, absPath).replace(/\\/g, '/');
      await sleep(delays.get(relPath));
      return { mtimeMs: 1 };
    },
    debounceMs: 100,
  });
  watcher.start();

  for (const relPath of delays.keys()) watchImpl.watchers[0].emit('change', relPath);
  await watcher.flush();

  assert.deepEqual(
    payloads[0].changes.map(({ relPath }) => relPath),
    [...delays.keys()]
  );
  watcher.stop();
});

