'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createModelLibrarySource,
} = require('../renderer/shell/model-library/model-library-sources');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function sourceHarness(overrides = {}) {
  const calls = {
    modelsList: 0,
    modelsListOllamaTags: 0,
    listLocalGgufs: 0,
    getLlamaServerStatus: 0,
  };
  const warnings = [];
  const shell = {
    models: {
      list() {
        calls.modelsList += 1;
        return overrides.list
          ? overrides.list(calls.modelsList)
          : Promise.resolve({ data: [] });
      },
      listOllamaTags() {
        calls.modelsListOllamaTags += 1;
        return Promise.resolve({ data: [] });
      },
    },
    offline: {
      getDiagnostics() {
        return Promise.resolve({});
      },
    },
    llamaServer: {
      listLocalGgufs() {
        calls.listLocalGgufs += 1;
        return Promise.resolve({ ok: true, entries: [] });
      },
      getStatus() {
        calls.getLlamaServerStatus += 1;
        return Promise.resolve({ ok: true, state: 'stopped' });
      },
    },
  };
  const source = createModelLibrarySource({
    windowRef: { jennyShell: shell },
    appendClientLog(level, event, details) {
      warnings.push({ level, event, details });
    },
  });
  return { source, calls, warnings };
}

test('coalesces concurrent loads with the same source set and generation', async () => {
  const installed = deferred();
  const { source, calls } = sourceHarness({
    list() { return installed.promise; },
  });

  const firstPromise = source.load();
  const secondPromise = source.load();

  assert.strictEqual(secondPromise, firstPromise);
  await Promise.resolve();
  assert.equal(calls.modelsList, 1);
  assert.equal(calls.modelsListOllamaTags, 1);

  installed.resolve({ data: [] });
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.strictEqual(second, first);
  assert.equal(first.generation, second.generation);
  assert.equal(first.generation, source.latestGeneration());
});

test('does not coalesce overlapping loads with different source sets', async () => {
  const withoutLlamaServer = deferred();
  const withLlamaServer = deferred();
  const { source, calls } = sourceHarness({
    list(callNumber) {
      return callNumber === 1 ? withoutLlamaServer.promise : withLlamaServer.promise;
    },
  });

  const withoutPromise = source.load({ llamaServer: false });
  const withPromise = source.load({ llamaServer: true });

  assert.notStrictEqual(withPromise, withoutPromise);
  await Promise.resolve();
  assert.equal(calls.modelsList, 2);
  assert.equal(calls.modelsListOllamaTags, 2);
  assert.equal(calls.listLocalGgufs, 1);
  assert.equal(calls.getLlamaServerStatus, 1);

  withLlamaServer.resolve({ data: [] });
  const newer = await withPromise;
  withoutLlamaServer.resolve({ data: [] });
  const older = await withoutPromise;

  assert.equal(older.generation, 1);
  assert.equal(newer.generation, 2);
  assert.equal(source.latestGeneration(), 2);
});

test('starts a fresh fan-out after a load settles', async () => {
  const { source, calls } = sourceHarness();

  await source.load();
  await source.load();

  assert.equal(calls.modelsList, 2);
  assert.equal(calls.modelsListOllamaTags, 2);
  assert.equal(source.latestGeneration(), 2);
});

test('logs one source warning for coalesced callers when a source rejects', async () => {
  const installed = deferred();
  const { source, calls, warnings } = sourceHarness({
    list() { return installed.promise; },
  });

  const firstPromise = source.load();
  const secondPromise = source.load();
  await Promise.resolve();
  installed.reject(new Error('backend stalled'));
  await Promise.all([firstPromise, secondPromise]);

  assert.equal(calls.modelsList, 1);
  assert.equal(warnings.filter((entry) => (
    entry.level === 'WARN' && entry.event === 'model_library.source_unavailable'
  )).length, 1);
});

// The Refresh button and every post-mutation reload pass force. Joining an
// already-running fan-out would answer a user action with a pre-action snapshot,
// and during a stall would resolve instantly with that load's failure.
test('a forced load never joins an in-flight fan-out', async () => {
  const first = deferred();
  const second = deferred();
  const { source, calls } = sourceHarness({
    list(callNumber) { return callNumber === 1 ? first.promise : second.promise; },
  });

  const joined = source.load();
  const forced = source.load({ force: true });

  assert.notStrictEqual(forced, joined);
  await Promise.resolve();
  assert.equal(calls.modelsList, 2);

  second.resolve({ data: ['fresh'] });
  const forcedResult = await forced;
  assert.equal(forcedResult.generation, 2);
  assert.equal(source.latestGeneration(), 2);

  first.resolve({ data: ['stale'] });
  const joinedResult = await joined;
  // The joined caller is now detectably stale, which is what the consumer drops on.
  assert.equal(joinedResult.generation, 1);
  assert.notEqual(joinedResult.generation, source.latestGeneration());
});

// Without an identity guard the older load's settle handler nulls the slot the
// forced load owns, letting a third caller start yet another fan-out.
test('an older load settling does not release the forced load’s slot', async () => {
  const first = deferred();
  const second = deferred();
  const { source, calls } = sourceHarness({
    list(callNumber) { return callNumber === 1 ? first.promise : second.promise; },
  });

  const joined = source.load();
  const forced = source.load({ force: true });
  await Promise.resolve();

  first.resolve({ data: ['stale'] });
  await joined;

  const rejoined = source.load();
  assert.strictEqual(rejoined, forced);
  assert.equal(calls.modelsList, 2);

  second.resolve({ data: ['fresh'] });
  await forced;
});
