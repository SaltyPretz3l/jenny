'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createWorkspaceInventory,
} = require('../renderer/features/renderer-ide-workspace-inventory');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function buildInventory(listAllFiles, now = () => 0) {
  return createWorkspaceInventory({
    getWorkspaceFsApi: () => ({ listAllFiles }),
    now,
  });
}

test('two sequential reads share one workspace listing', async () => {
  let calls = 0;
  const inventory = buildInventory(async () => {
    calls += 1;
    return { files: ['a.js', 'b.js'] };
  });

  const first = await inventory.getFiles();
  const second = await inventory.getFiles();

  assert.equal(calls, 1);
  assert.strictEqual(second, first);
  assert.deepEqual(inventory.stats(), {
    listCalls: 1,
    cacheHits: 1,
    invalidations: 0,
    fileCount: 2,
  });
});

test('two concurrent reads share one in-flight workspace listing', async () => {
  const listing = deferred();
  let calls = 0;
  const inventory = buildInventory(() => {
    calls += 1;
    return listing.promise;
  });

  const firstPromise = inventory.getFiles();
  const secondPromise = inventory.getFiles();
  assert.equal(calls, 1);

  listing.resolve({ files: ['a.js'] });
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.strictEqual(second.files, first.files);
  assert.deepEqual(first.files, ['a.js']);
});

test('a complete create and delete batch patches the cached list without re-fetching', async () => {
  let calls = 0;
  const inventory = buildInventory(async () => {
    calls += 1;
    return { files: ['a.js', 'b.js'] };
  });

  const first = await inventory.getFiles();
  inventory.handleExternalChanges([
    { relPath: 'a.js', kind: 'deleted' },
    { relPath: 'c.js', kind: 'changed' },
  ], { truncated: false });
  const second = await inventory.getFiles();

  assert.equal(calls, 1);
  assert.strictEqual(second, first);
  assert.deepEqual(second.files, ['b.js', 'c.js']);
});

test('a complete batch arriving during a fetch is merged into its result', async () => {
  const listing = deferred();
  let calls = 0;
  const inventory = buildInventory(() => {
    calls += 1;
    return listing.promise;
  });

  const resultPromise = inventory.getFiles();
  inventory.handleExternalChanges([
    { relPath: 'a.js', kind: 'deleted' },
    { relPath: 'b.js', kind: 'changed' },
  ]);
  listing.resolve({ files: ['a.js'] });

  assert.deepEqual((await resultPromise).files, ['b.js']);
  assert.equal(calls, 1);
});

test('a truncated batch invalidates so the next read re-fetches', async () => {
  const listings = [['a.js'], ['a.js', 'b.js']];
  let calls = 0;
  const inventory = buildInventory(async () => ({ files: listings[calls++] }));

  await inventory.getFiles();
  inventory.handleExternalChanges([], { truncated: true });
  const refreshed = await inventory.getFiles();

  assert.equal(calls, 2);
  assert.deepEqual(refreshed.files, ['a.js', 'b.js']);
  assert.equal(inventory.stats().invalidations, 1);
});

test('a rejected fetch is backed off briefly and then retried', async () => {
  let clock = 0;
  let calls = 0;
  const inventory = buildInventory(() => {
    calls += 1;
    if (calls === 1) throw new Error('bridge unavailable');
    return { files: ['recovered.js'] };
  }, () => clock);

  const failed = await inventory.getFiles();
  assert.equal(failed.failed, true);
  assert.deepEqual(failed.files, []);

  clock = 2999;
  const backedOff = await inventory.getFiles();
  assert.equal(backedOff.failed, true);
  assert.equal(calls, 1);

  clock = 3000;
  const recovered = await inventory.getFiles();
  assert.equal(calls, 2);
  assert.equal(recovered.failed, false);
  assert.deepEqual(recovered.files, ['recovered.js']);
});

test('invalidate forces a fresh workspace listing', async () => {
  let calls = 0;
  const inventory = buildInventory(async () => ({ files: [`call-${++calls}.js`] }));

  assert.deepEqual((await inventory.getFiles()).files, ['call-1.js']);
  inventory.invalidate();
  assert.deepEqual((await inventory.getFiles()).files, ['call-2.js']);
  assert.equal(calls, 2);
});

test('dispose invalidates and ignores later watcher batches', async () => {
  let calls = 0;
  const inventory = buildInventory(async () => {
    calls += 1;
    return { files: calls === 1 ? ['old.js'] : ['fresh.js'] };
  });

  await inventory.getFiles();
  inventory.dispose();
  inventory.handleExternalChanges([{ relPath: 'stale.js', kind: 'changed' }]);
  const refreshed = await inventory.getFiles();

  assert.equal(calls, 2);
  assert.deepEqual(refreshed.files, ['fresh.js']);
});

test('a missing workspace filesystem API resolves an empty result', async () => {
  const inventory = createWorkspaceInventory({});

  assert.deepEqual(await inventory.getFiles(), {
    files: [],
    truncated: false,
    complete: true,
    ignoreSource: undefined,
    rootId: undefined,
    generation: undefined,
    failed: false,
  });
});

test('workspace listing metadata and completeness pass through', async () => {
  const inventory = buildInventory(async () => ({
    files: ['a.js'],
    truncated: true,
    ignoreSource: 'gitignore',
    rootId: 'root-7',
    generation: 42,
  }));

  assert.deepEqual(await inventory.getFiles(), {
    files: ['a.js'],
    truncated: true,
    complete: false,
    ignoreSource: 'gitignore',
    rootId: 'root-7',
    generation: 42,
    failed: false,
  });
});
