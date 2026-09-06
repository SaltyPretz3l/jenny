const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTempPath, FileJsonStore } = require('../services/backend/file-json-store');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

// FileJsonStore's debounce timer is REFERENCED, not unref'd: a store left with a
// pending write keeps the runner alive for the whole writeDebounceMs and then
// writes into a directory this teardown has already removed. Every test here that
// uses writeDebounceMs relied on reaching its own flush() call, so any assertion
// failing before that line left a live 30s timer behind.
const openStores = [];

function makeStore(...args) {
  const store = new FileJsonStore(...args);
  openStores.push(store);
  return store;
}

test.afterEach(async () => {
  // Dispose BEFORE the directories go: dispose() flushes, and a flush into a
  // removed directory would fail. Some tests deliberately leave a store that
  // cannot write, so a throw here must not mask the test's own result.
  while (openStores.length) {
    try {
      openStores.pop().dispose();
    } catch (error) {
      void error;
    }
  }
  await cleanupTrackedResources();
});

test('write persists valid JSON and read returns it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-'));
  trackDirectory(dir);
  const store = makeStore(path.join(dir, 'data.json'));

  store.write({ key: 'value', nested: { a: 1 } });
  const result = store.read({});
  assert.deepEqual(result, { key: 'value', nested: { a: 1 } });
});

test('write generations distinguish accepted and durable bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-epochs-'));
  trackDirectory(dir);
  const store = makeStore(path.join(dir, 'data.json'), { writeDebounceMs: 30_000 });
  const accepted = store.write({ value: 1 });
  assert.deepEqual(accepted, { generation: 1, durable: false });
  assert.deepEqual(store.getWriteState(), {
    acceptedGeneration: 1, durableGeneration: 0, failedGeneration: 0, pending: true,
  });
  store.flush();
  assert.deepEqual(store.getWriteState(), {
    acceptedGeneration: 1, durableGeneration: 1, failedGeneration: 0, pending: false,
  });
});

test('failed immediate write remains observable by generation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-failed-epoch-'));
  trackDirectory(dir);
  const store = makeStore(path.join(dir, 'data.json'));
  const realRenameSync = fs.renameSync;
  fs.renameSync = () => { throw new Error('blocked'); };
  try {
    assert.throws(() => store.writeImmediate({ value: 1 }), /blocked/);
  } finally {
    fs.renameSync = realRenameSync;
  }
  assert.deepEqual(store.getWriteState(), {
    acceptedGeneration: 1, durableGeneration: 0, failedGeneration: 1, pending: false,
  });
});

test('write does not corrupt existing file when temp rename fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'data.json');
  const store = makeStore(filePath);

  store.write({ original: true });
  assert.deepEqual(store.read({}), { original: true });

  const realRenameSync = fs.renameSync;
  fs.renameSync = () => {
    throw new Error('simulated rename failure');
  };

  try {
    assert.throws(() => store.write({ corrupted: true }), /simulated rename failure/);
  } finally {
    fs.renameSync = realRenameSync;
  }

  assert.deepEqual(store.read({}), { original: true });
});

test('write cleans up temp file on failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'data.json');
  const store = makeStore(filePath);

  const realRenameSync = fs.renameSync;
  fs.renameSync = () => {
    throw new Error('simulated rename failure');
  };

  try {
    assert.throws(() => store.write({ data: true }));
  } finally {
    fs.renameSync = realRenameSync;
  }

  const remaining = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.equal(remaining.length, 0, 'temp file should be cleaned up after failure');
});

test('write creates parent directories if missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-'));
  trackDirectory(dir);
  const nested = path.join(dir, 'a', 'b', 'c', 'data.json');
  const store = makeStore(nested);

  store.write({ deep: true });
  assert.deepEqual(store.read({}), { deep: true });
});

test('delete removes the file and ignores missing files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'data.json');
  const store = makeStore(filePath);

  store.write({ temp: true });
  assert.ok(fs.existsSync(filePath));

  store.delete();
  assert.ok(!fs.existsSync(filePath));

  assert.doesNotThrow(() => store.delete());
});

test('read returns defaultValue when file does not exist or is corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-'));
  trackDirectory(dir);
  const store = makeStore(path.join(dir, 'missing.json'));

  assert.deepEqual(store.read({ fallback: true }), { fallback: true });

  const corruptPath = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corruptPath, '{bad json', 'utf8');
  const corruptStore = makeStore(corruptPath);
  assert.deepEqual(corruptStore.read({ fallback: true }), { fallback: true });
});

test('readWithStatus distinguishes a missing file from a corrupt one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-'));
  trackDirectory(dir);

  const missing = makeStore(path.join(dir, 'missing.json')).readWithStatus(null);
  assert.equal(missing.value, null);
  assert.equal(missing.missing, true);
  assert.equal(missing.corrupted, false);
  assert.equal(missing.errorCode, 'ENOENT');

  const corruptPath = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corruptPath, '{bad json', 'utf8');
  const corrupt = makeStore(corruptPath).readWithStatus(null);
  assert.equal(corrupt.value, null);
  assert.equal(corrupt.missing, false);
  assert.equal(corrupt.corrupted, true);
  assert.match(String(corrupt.errorMessage), /JSON|position|Expected/i);

  const intactPath = path.join(dir, 'intact.json');
  fs.writeFileSync(intactPath, JSON.stringify({ ok: 1 }), 'utf8');
  const intact = makeStore(intactPath).readWithStatus(null);
  assert.deepEqual(intact.value, { ok: 1 });
  assert.equal(intact.missing, false);
  assert.equal(intact.corrupted, false);
});

test('buildTempPath produces unique temp names even when the clock does not advance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'data.json');
  const realNow = Date.now;

  Date.now = () => 1234567890;
  try {
    const first = buildTempPath(filePath);
    const second = buildTempPath(filePath);

    assert.notEqual(first, second);
    assert.match(first, /\.1234567890\.[0-9a-f]{12}\.tmp$/);
    assert.match(second, /\.1234567890\.[0-9a-f]{12}\.tmp$/);
  } finally {
    Date.now = realNow;
  }
});

test('write uses distinct temp files when the clock does not advance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'data.json');
  const store = makeStore(filePath);
  const realNow = Date.now;
  const realWriteFileSync = fs.writeFileSync;
  const tempPaths = [];

  Date.now = () => 1234567890;
  fs.writeFileSync = (targetPath, ...args) => {
    if (String(targetPath).endsWith('.tmp')) {
      tempPaths.push(String(targetPath));
    }
    return realWriteFileSync.call(fs, targetPath, ...args);
  };

  try {
    store.write({ value: 1 });
    store.write({ value: 2 });
  } finally {
    Date.now = realNow;
    fs.writeFileSync = realWriteFileSync;
  }

  assert.equal(tempPaths.length, 2);
  assert.notEqual(tempPaths[0], tempPaths[1]);
  assert.deepEqual(store.read({}), { value: 2 });
});

test('writeDebounceMs defers disk writes until flush()', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-debounce-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'debounced.json');
  const store = makeStore(filePath, { writeDebounceMs: 30_000 });

  store.write({ pending: true });
  assert.equal(store.hasPendingWrite(), true);
  assert.equal(fs.existsSync(filePath), false);

  const flushed = store.flush();
  assert.equal(flushed, true);
  assert.equal(store.hasPendingWrite(), false);
  assert.deepEqual(store.read({}), { pending: true });
});

test('failed synchronous flush retains the pending value for a later durability retry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-flush-retry-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'debounced.json');
  const store = makeStore(filePath, { writeDebounceMs: 30_000 });
  const realWriteFileSync = fs.writeFileSync;
  let failOnce = true;
  fs.writeFileSync = (...args) => {
    if (failOnce && String(args[0]).endsWith('.tmp')) {
      failOnce = false;
      throw Object.assign(new Error('simulated flush failure'), { code: 'EIO' });
    }
    return realWriteFileSync(...args);
  };

  try {
    store.write({ retained: true });
    assert.throws(() => store.flush(), /simulated flush failure/);
    assert.equal(store.hasPendingWrite(), true);
    assert.equal(store.flush(), true);
  } finally {
    fs.writeFileSync = realWriteFileSync;
  }

  assert.equal(store.hasPendingWrite(), false);
  assert.deepEqual(store.read({}), { retained: true });
});

test('writeDebounceMs coalesces multiple writes into the latest value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-debounce-coalesce-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'debounced.json');
  const store = makeStore(filePath, { writeDebounceMs: 30_000 });
  const realWriteFileSync = fs.writeFileSync;
  let physicalWrites = 0;
  fs.writeFileSync = (targetPath, ...args) => {
    if (String(targetPath).endsWith('.tmp')) {
      physicalWrites += 1;
    }
    return realWriteFileSync.call(fs, targetPath, ...args);
  };

  try {
    store.write({ value: 1 });
    store.write({ value: 2 });
    store.write({ value: 3 });
    store.flush();
  } finally {
    fs.writeFileSync = realWriteFileSync;
  }

  assert.equal(physicalWrites, 1);
  assert.deepEqual(store.read({}), { value: 3 });
});

test('flushAsync drains pending debounced writes asynchronously', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-flush-async-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'debounced.json');
  const store = makeStore(filePath, { writeDebounceMs: 30_000 });

  store.write({ asyncValue: true });
  const flushed = await store.flushAsync();

  assert.equal(flushed, true);
  assert.equal(store.hasPendingWrite(), false);
  assert.deepEqual(store.read({}), { asyncValue: true });
});

test('debounced async write failures are logged and swallowed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-async-fail-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'debounced.json');
  const entries = [];
  const store = makeStore(filePath, {
    writeDebounceMs: 30_000,
    logger(level, event, details) {
      entries.push({ level, event, details });
    },
  });
  const realWriteFile = fs.promises.writeFile;
  const realConsoleError = console.error;
  const consoleErrors = [];
  const writeError = new Error('simulated async disk failure');
  writeError.code = 'EIO';

  fs.promises.writeFile = async () => {
    throw writeError;
  };
  console.error = (...args) => {
    consoleErrors.push(args.join(' '));
  };

  try {
    store.write({ pending: true });
    await assert.doesNotReject(() => store.flushAsync());
  } finally {
    fs.promises.writeFile = realWriteFile;
    console.error = realConsoleError;
  }

  const entry = entries.find((item) => item.event === 'store.debounced_write_failed');
  assert.ok(entry);
  assert.equal(entry.level, 'ERROR');
  assert.equal(entry.details.errorCode, 'EIO');
  assert.match(consoleErrors.join('\n'), /debounced write failed/);
  assert.equal(fs.existsSync(filePath), false);
});

test('writeImmediate cancels any pending debounced write and writes synchronously', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-immediate-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'debounced.json');
  const store = makeStore(filePath, { writeDebounceMs: 30_000 });

  store.write({ stale: true });
  assert.equal(store.hasPendingWrite(), true);

  store.writeImmediate({ fresh: true });
  assert.equal(store.hasPendingWrite(), false);
  assert.deepEqual(store.read({}), { fresh: true });

  // The pending stale value must have been discarded; a follow-up flush
  // must not overwrite the immediate value.
  store.flush();
  assert.deepEqual(store.read({}), { fresh: true });
});

test('dispose flushes pending debounced writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-dispose-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'debounced.json');
  const store = makeStore(filePath, { writeDebounceMs: 30_000 });

  store.write({ pending: true });
  store.dispose();
  assert.equal(store.hasPendingWrite(), false);
  assert.deepEqual(store.read({}), { pending: true });
});

test('delete cancels any pending debounced write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-delete-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'debounced.json');
  const store = makeStore(filePath, { writeDebounceMs: 30_000 });

  store.writeImmediate({ initial: true });
  store.write({ pending: true });
  store.delete();
  assert.equal(store.hasPendingWrite(), false);
  assert.equal(fs.existsSync(filePath), false);

  // A subsequent flush must not resurrect the deleted file from the
  // discarded pending write.
  store.flush();
  assert.equal(fs.existsSync(filePath), false);
});

test('delete wins over an in-flight debounced async rename', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-delete-race-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'debounced.json');
  const store = makeStore(filePath, { writeDebounceMs: 1 });
  const realRename = fs.promises.rename;
  let releaseRename;
  let renameStarted = false;
  const renameGate = new Promise((resolve) => {
    releaseRename = resolve;
  });

  store.writeImmediate({ original: true });
  fs.promises.rename = async (oldPath, newPath) => {
    renameStarted = true;
    await renameGate;
    return realRename.call(fs.promises, oldPath, newPath);
  };

  try {
    store.write({ stale: true });
    const started = Date.now();
    while (!renameStarted && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(renameStarted, true, 'async rename should be paused inside the test gate');

    store.delete();
    assert.equal(fs.existsSync(filePath), false);

    releaseRename();
    await store.flushAsync();
  } finally {
    fs.promises.rename = realRename;
  }

  assert.equal(fs.existsSync(filePath), false);
});

test('writeDebounceMs:0 keeps writes synchronous (default behavior)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-immediate-default-'));
  trackDirectory(dir);
  const filePath = path.join(dir, 'data.json');
  const store = makeStore(filePath);

  store.write({ value: 1 });
  assert.equal(store.hasPendingWrite(), false);
  assert.deepEqual(store.read({}), { value: 1 });
});
