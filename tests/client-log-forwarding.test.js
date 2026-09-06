'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createClientLogBatchHandler,
  createLogRedactionPrefixesProvider,
  registerClientLogIpcHandler,
} = require('../services/main/client-log-forwarding');

const { getBridgeChannel } = require('../services/ipc-contract');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWriter() {
  return {
    written: [],
    write(entry) {
      this.written.push(entry);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('redaction prefix provider resolves mutable shell config at read time', () => {
  let root = 'C:\\workspace-a';
  const provider = createLogRedactionPrefixesProvider({
    app: { getPath: () => 'C:\\profile' }, rootDir: 'G:\\Jenny',
    getShellConfigService: () => ({ getState: () => ({ toolsWorkspaceRoot: root }) }),
  });
  assert.deepEqual(provider(), ['C:\\profile', 'G:\\Jenny', 'C:\\workspace-a']);
  root = 'C:\\workspace-b';
  assert.equal(provider()[2], 'C:\\workspace-b');
});

test('DEBUG entries are dropped when debug forwarding is OFF (default env)', () => {
  const writer = makeWriter();
  const handler = createClientLogBatchHandler({
    getProcessLogWriter: () => writer,
    getRedactionPrefixes: () => [],
    env: {},
    log: () => {},
  });

  handler(null, {
    entries: [
      { level: 'INFO', message: 'hi' },
      { level: 'DEBUG', message: 'dbg' },
    ],
  });

  // Only the INFO entry should be written; DEBUG must be dropped.
  assert.equal(writer.written.length, 1, 'exactly one entry written (DEBUG dropped)');
  assert.equal(writer.written[0].layer, 'renderer', 'layer pinned to renderer');
  assert.equal(writer.written[0].source, 'renderer', 'source pinned to renderer');
});

test('DEBUG entries are forwarded when JENNY_ENABLE_AGENT_TEST_HOOKS=1', () => {
  const writer = makeWriter();
  const handler = createClientLogBatchHandler({
    getProcessLogWriter: () => writer,
    getRedactionPrefixes: () => [],
    env: { JENNY_ENABLE_AGENT_TEST_HOOKS: '1' },
    log: () => {},
  });

  handler(null, {
    entries: [
      { level: 'INFO', message: 'hi' },
      { level: 'DEBUG', message: 'dbg' },
    ],
  });

  // Both entries should be written when debug forwarding is enabled.
  assert.equal(writer.written.length, 2, 'both INFO and DEBUG written when agent_test_hooks on');
  assert.equal(writer.written[1].layer, 'renderer', 'debug entry layer pinned to renderer');
  assert.equal(writer.written[1].source, 'renderer', 'debug entry source pinned to renderer');
});

test('dropped_count > 0 triggers a single WARN log; warnedAboutDrops latches so second call is silent', () => {
  const logCalls = [];
  const writer = makeWriter();
  const handler = createClientLogBatchHandler({
    getProcessLogWriter: () => writer,
    getRedactionPrefixes: () => [],
    env: {},
    log: (...args) => logCalls.push(args),
  });

  // First call with dropped_count:3 — should emit the WARN.
  handler(null, { entries: [], dropped_count: 3 });

  assert.equal(logCalls.length, 1, 'log called once after first dropped_count');
  assert.equal(logCalls[0][0], 'WARN', 'log level is WARN');
  assert.equal(logCalls[0][1], 'logs.client_forwarding_dropped', 'log event name correct');
  assert.equal(logCalls[0][2].droppedCount, 3, 'droppedCount passed in log data');

  // Second call with dropped_count:5 — warnedAboutDrops latch must suppress it.
  handler(null, { entries: [], dropped_count: 5 });

  assert.equal(logCalls.length, 1, 'log NOT called again (warnedAboutDrops latch active)');
});

test('null writer: handler returns without throwing and nothing is written', () => {
  const logCalls = [];
  const handler = createClientLogBatchHandler({
    getProcessLogWriter: () => null,
    getRedactionPrefixes: () => [],
    env: {},
    log: (...args) => logCalls.push(args),
  });

  // Must not throw.
  assert.doesNotThrow(() => {
    handler(null, { entries: [{ level: 'INFO', message: 'test' }] });
  });

  // No log calls either (the early-return path exits before logging).
  assert.equal(logCalls.length, 0, 'no log calls when writer is null');
});

test('malformed-entry isolation: null/array entries skipped, valid entry survives', () => {
  const writer = makeWriter();
  const handler = createClientLogBatchHandler({
    getProcessLogWriter: () => writer,
    getRedactionPrefixes: () => [],
    env: {},
    log: () => {},
  });

  handler(null, {
    entries: [
      null,
      ['x'],
      { level: 'INFO', message: 'ok' },
    ],
  });

  assert.equal(writer.written.length, 1, 'only the valid entry survives malformed peers');
  assert.equal(writer.written[0].message, 'ok', 'correct entry written through');
});

test('MAX_BATCH_ENTRIES cap: 250 entries are trimmed to 200', () => {
  const writer = makeWriter();
  const handler = createClientLogBatchHandler({
    getProcessLogWriter: () => writer,
    getRedactionPrefixes: () => [],
    env: {},
    log: () => {},
  });

  const entries = Array.from({ length: 250 }, (_, i) => ({
    level: 'INFO',
    message: `msg-${i}`,
  }));

  handler(null, { entries });

  assert.equal(writer.written.length, 200, 'batch is capped at MAX_BATCH_ENTRIES (200)');
});

test('production writer receives one ordered writeBatch call per IPC batch', () => {
  const batches = [];
  const handler = createClientLogBatchHandler({
    getProcessLogWriter: () => ({ writeBatch: (entries) => batches.push(entries) }),
    getRedactionPrefixes: () => [],
    env: {},
  });

  handler(null, {
    entries: [
      { level: 'INFO', message: 'first' },
      null,
      { level: 'WARN', message: 'second' },
    ],
  });

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((entry) => entry.message), ['first', 'second']);
});

test('throwing batch writer never escapes renderer IPC', () => {
  let attempts = 0;
  const handler = createClientLogBatchHandler({
    getProcessLogWriter: () => ({ writeBatch() { attempts += 1; throw new Error('sink failed'); } }),
    env: {},
  });
  assert.doesNotThrow(() => handler(null, { entries: [{ level: 'INFO', message: 'safe' }] }));
  assert.equal(attempts, 1, 'the sink was exercised before its failure was isolated');
});

test('registerClientLogIpcHandler registers canonical and compatibility channels with one handler', () => {
  const fakeCalls = [];
  const fakeIpcMain = {
    on(channel, fn) {
      fakeCalls.push([channel, fn]);
    },
  };

  registerClientLogIpcHandler(fakeIpcMain, {
    getProcessLogWriter: () => null,
    getRedactionPrefixes: () => [],
    env: {},
    log: () => {},
  });

  const expectedChannels = [
    getBridgeChannel('diagnostics.logs.appendRendererBatch', 'send'),
    getBridgeChannel('logs.clientAppend', 'send'),
  ];

  assert.equal(fakeCalls.length, 2, 'both bridge channels are registered');
  assert.deepEqual(fakeCalls.map(([channel]) => channel), expectedChannels);
  assert.equal(fakeCalls[0][1], fakeCalls[1][1], 'aliases share one ingestion handler');
  assert.equal(typeof fakeCalls[0][1], 'function', 'second arg is a function handler');
});

test('registerClientLogIpcHandler does not throw when passed an object without .on', () => {
  let result;

  assert.doesNotThrow(() => {
    result = registerClientLogIpcHandler({});
  }, 'no throw for object missing .on');
  assert.equal(result, undefined, 'returns undefined for object without .on (guard early-return)');

  assert.doesNotThrow(() => {
    result = registerClientLogIpcHandler(null);
  }, 'no throw for null ipcMain');
  assert.equal(result, undefined, 'returns undefined for null ipcMain (guard early-return)');

  assert.doesNotThrow(() => {
    result = registerClientLogIpcHandler(undefined);
  }, 'no throw for undefined ipcMain');
  assert.equal(result, undefined, 'returns undefined for undefined ipcMain (guard early-return)');
});

test('registerClientLogIpcHandler ignores ipcMain whose .on is not a function (guard does not invoke it)', () => {
  // A crafted ipcMain whose `.on` is a non-callable value must hit the
  // `typeof ipcMainLike.on !== 'function'` guard branch and return without
  // attempting to use it. We make `.on` a sentinel string and assert the
  // handler is never installed by spying on a sibling callable property.
  let onAccessedAsFunction = false;
  const malformedIpcMain = {
    on: 'not-a-function',
    // If the guard were broken (e.g. checked truthiness instead of typeof),
    // calling a string would throw a TypeError; doesNotThrow proves the guard
    // short-circuits before any call attempt.
  };

  assert.doesNotThrow(() => {
    registerClientLogIpcHandler(malformedIpcMain, {
      getProcessLogWriter: () => null,
      getRedactionPrefixes: () => [],
      env: {},
      log: () => {},
    });
  }, 'guard short-circuits a non-function .on without throwing');

  // Positive contrast: a *valid* ipcMain DOES get both aliases registered,
  // proving the guard is selective (rejects bad, accepts good) rather than
  // unconditionally returning early.
  const goodCalls = [];
  const goodIpcMain = {
    on(channel, fn) {
      onAccessedAsFunction = true;
      goodCalls.push([channel, fn]);
    },
  };
  registerClientLogIpcHandler(goodIpcMain, {
    getProcessLogWriter: () => null,
    getRedactionPrefixes: () => [],
    env: {},
    log: () => {},
  });
  assert.equal(goodCalls.length, 2, 'valid ipcMain.on registered both aliases');
  assert.equal(onAccessedAsFunction, true, 'valid ipcMain.on was actually invoked');
  assert.deepEqual(
    goodCalls.map(([channel]) => channel),
    [
      getBridgeChannel('diagnostics.logs.appendRendererBatch', 'send'),
      getBridgeChannel('logs.clientAppend', 'send'),
    ],
    'valid registration uses both contract channels'
  );
});
