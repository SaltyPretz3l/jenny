'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { FileJsonStore } = require('../services/backend/file-json-store');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function makeDir() {
  return createTrackedTempDir('jenny-fjs-measured-');
}

test('sync write reports bytes, ms and sync=true once per successful write', () => {
  const dir = makeDir();
  const calls = [];
  const store = new FileJsonStore(path.join(dir, 'data.json'), {
    compact: true,
    onWriteMeasured: (info) => calls.push(info),
  });
  const value = { a: 'héllo', b: [1, 2, 3] };
  store.writeImmediate(value);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sync, true);
  assert.equal(calls[0].bytes, Buffer.byteLength(JSON.stringify(value), 'utf8'));
  assert.equal(calls[0].bytes, fs.statSync(path.join(dir, 'data.json')).size);
  assert.equal(typeof calls[0].ms, 'number');
  assert.ok(calls[0].ms >= 0);
  store.writeImmediate({ a: 'x' });
  assert.equal(calls.length, 2);
});

test('debounced write reports sync=false once after the background write lands', async () => {
  const dir = makeDir();
  const calls = [];
  const store = new FileJsonStore(path.join(dir, 'data.json'), {
    compact: true,
    writeDebounceMs: 5,
    onWriteMeasured: (info) => calls.push(info),
  });
  const value = { turn: 'streaming', n: 42 };
  store.write(value);
  store.write(value);
  await store.flushAsync();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sync, false);
  assert.equal(calls[0].bytes, Buffer.byteLength(JSON.stringify(value), 'utf8'));
  assert.ok(calls[0].ms >= 0);
  await store.disposeAsync();
});

test('failed write does not report a measurement', () => {
  const dir = makeDir();
  // The target is a directory, so the temp file is written and the rename
  // then fails: the failure happens after the measurement started.
  const target = path.join(dir, 'data.json');
  fs.mkdirSync(target);
  const calls = [];
  const store = new FileJsonStore(target, {
    onWriteMeasured: (info) => calls.push(info),
  });
  assert.throws(() => store.writeImmediate({ a: 1 }));
  assert.equal(calls.length, 0);
});

test('a throwing callback never fails or alters the write', async () => {
  const dir = makeDir();
  const filePath = path.join(dir, 'data.json');
  let invoked = 0;
  const store = new FileJsonStore(filePath, {
    compact: true,
    writeDebounceMs: 5,
    onWriteMeasured: () => {
      invoked += 1;
      throw new Error('meter exploded');
    },
  });
  store.writeImmediate({ v: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { v: 1 });
  store.write({ v: 2 });
  await store.flushAsync();
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { v: 2 });
  assert.equal(invoked, 2);
  await store.disposeAsync();
});
