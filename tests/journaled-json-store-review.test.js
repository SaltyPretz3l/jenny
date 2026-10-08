'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { JournaledJsonStore } = require('../services/backend/journaled-json-store');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function state(count, title = 'chat') {
  return {
    schema_version: 1,
    session: {
      id: 's1',
      title,
      messages: Array.from({ length: count }, (_, index) => ({ id: `m${index}`, text: `message ${index}` })),
      turn_events: [],
    },
  };
}

function open(dir, options = {}) {
  return new JournaledJsonStore(path.join(dir, 's1.json'), {
    payloadKey: 'session', compact: true, idleCompactMs: 0, ...options,
  });
}

function baseEpoch(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 's1.json'), 'utf8')).journal_epoch;
}

function wait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

test('two stores on one file never lose an acknowledged write to an unread journal', () => {
  const dir = createTrackedTempDir('jenny-jjs-review-');
  const first = open(dir);
  first.writeImmediate(state(1));
  first.writeImmediate(state(2));
  const second = open(dir);
  second.writeImmediate(state(3));
  second.writeImmediate(state(4));
  assert.equal(baseEpoch(dir), 2);

  // `first` still believes the base is epoch 1. Its compaction must leave the
  // second writer's base and journal alone.
  assert.equal(first.compact(), false);
  assert.equal(baseEpoch(dir), 2);
  second.writeImmediate(state(5));
  assert.deepEqual(open(dir).read(), state(5));

  // A write from the stale store is never appended to its orphaned journal: it
  // replaces the base with a fresh epoch (last writer wins, as with plain files).
  first.writeImmediate(state(6));
  assert.equal(baseEpoch(dir), 3);
  assert.deepEqual(open(dir).read(), state(6));
  first.writeImmediate(state(7));
  assert.deepEqual(open(dir).read(), state(7));

  // And the other store notices in turn instead of appending to a dead journal.
  second.writeImmediate(state(8));
  assert.ok(baseEpoch(dir) > 3);
  const result = open(dir).readWithStatus();
  assert.notEqual(result.journalStatus, 'corrupt');
  assert.deepEqual(result.value, state(8));
});

test('the idle timer is re-armed when it fires during a background append', async (t) => {
  const dir = createTrackedTempDir('jenny-jjs-review-');
  const store = open(dir, { idleCompactMs: 30, writeDebounceMs: 5 });
  store.writeImmediate(state(1));
  const realFsync = fs.fsync;
  t.mock.method(fs, 'fsync', (fd, callback) => {
    setTimeout(() => realFsync(fd, callback), 90);
  });
  store.write(state(2));
  await wait(60);
  assert.equal(baseEpoch(dir), 1, 'no compaction while the append is still syncing');
  await store.flushAsync();
  t.mock.restoreAll();
  const deadline = Date.now() + 2000;
  while (baseEpoch(dir) === 1 && Date.now() < deadline) await wait(20);
  assert.equal(baseEpoch(dir), 2, 'compaction ran once the append settled');
  assert.deepEqual(open(dir).read(), state(2));
  store.dispose();
});

test('a store that is written continuously still compacts within the age limit', async () => {
  const dir = createTrackedTempDir('jenny-jjs-review-');
  const store = open(dir, { idleCompactMs: 80 });
  store.writeImmediate(state(1));
  const deadline = Date.now() + 3000;
  let count = 1;
  while (baseEpoch(dir) === 1 && Date.now() < deadline) {
    count += 1;
    store.writeImmediate(state(count));
    await wait(20);
  }
  assert.ok(baseEpoch(dir) >= 2, 'the base was rewritten although writes never paused for the age limit');
  assert.deepEqual(open(dir).read(), state(count));
  store.dispose();
});

test('debounced writes that never pause still compact about once per age limit', async () => {
  const dir = createTrackedTempDir('jenny-jjs-review-');
  const store = open(dir, { idleCompactMs: 100, writeDebounceMs: 30 });
  store.writeImmediate(state(1));
  const startedAt = Date.now();
  let count = 1;
  while (Date.now() - startedAt < 1500) {
    count += 1;
    store.write(state(count));
    await wait(10);
  }
  await store.flushAsync();
  // 1.5 s at a 100 ms limit: a timer that waited a full period per pending
  // write managed 1 or 2 rewrites here.
  assert.ok(baseEpoch(dir) >= 6, `base rewritten ${baseEpoch(dir) - 1} times`);
  assert.deepEqual(open(dir).read(), state(count));
  store.dispose();
});

test('a failed durable append is not acknowledged and the next write replaces the base', (t) => {
  const dir = createTrackedTempDir('jenny-jjs-review-');
  const store = open(dir);
  store.writeImmediate(state(1));
  const before = store.getWriteState().durableGeneration;
  t.mock.method(fs, 'fsyncSync', () => { throw Object.assign(new Error('io'), { code: 'EIO' }); });
  assert.throws(() => store.writeImmediate(state(2)), { code: 'EIO' });
  assert.equal(store.getWriteState().durableGeneration, before);
  t.mock.restoreAll();

  store.writeImmediate(state(3));
  assert.equal(baseEpoch(dir), 2);
  assert.deepEqual(open(dir).read(), state(3));
  store.dispose();
});
