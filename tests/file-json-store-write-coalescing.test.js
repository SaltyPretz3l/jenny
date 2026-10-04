'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { FileJsonStore } = require('../services/backend/file-json-store');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-coalescing-'));
  const filePath = path.join(dir, 'data.json');
  const store = new FileJsonStore(filePath, { writeDebounceMs: 500 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const releaseGates = [];
  t.after(async () => {
    for (const release of releaseGates) release();
    await store.disposeAsync();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    filePath,
    releaseGates,
    fire(value) {
      const accepted = store.write(value);
      t.mock.timers.tick(500);
      return accepted;
    },
    disk() { return JSON.parse(fs.readFileSync(filePath, 'utf8')); },
  };
}

function blockFs(t, f, method, blockedCalls = 1) {
  const original = fs.promises[method];
  const gates = Array.from({ length: blockedCalls }, deferred);
  const starts = Array.from({ length: blockedCalls }, deferred);
  const calls = [];
  t.mock.method(fs.promises, method, async (...args) => {
    const index = calls.length;
    calls.push(args);
    if (gates[index]) {
      starts[index].resolve();
      await gates[index].promise;
    }
    return original.apply(fs.promises, args);
  });
  for (const gate of gates) f.releaseGates.push(gate.resolve);
  return { calls, gates, starts };
}

test('40 fired debounce windows retain only the in-flight and latest pending writes', async (t) => {
  const f = fixture(t);
  const writer = blockFs(t, f, 'writeFile');
  f.fire({ value: 0 });
  await writer.starts[0].promise;
  for (let value = 1; value < 40; value += 1) f.fire({ value });
  const draining = f.store.flushAsync();
  writer.gates[0].resolve();
  await draining;

  assert.ok(writer.calls.length <= 2, `expected at most 2 writer invocations, got ${writer.calls.length}`);
  assert.deepEqual(f.disk(), { value: 39 });
  assert.equal(f.store.getWriteState().durableGeneration, 40);
  assert.equal(f.store.hasPendingWrite(), false);
});

test('superseded pending snapshots are dropped before serialization', async (t) => {
  const f = fixture(t);
  const writer = blockFs(t, f, 'writeFile');
  const serialized = [];
  f.fire({ value: 'first' });
  await writer.starts[0].promise;
  for (let value = 1; value <= 3; value += 1) {
    f.fire({ toJSON() { serialized.push(value); return { value }; } });
  }
  writer.gates[0].resolve();
  await f.store.flushAsync();

  assert.deepEqual(serialized, [3]);
  assert.deepEqual(f.disk(), { value: 3 });
});

test('a generation superseded during mkdir is skipped before serialization or writing', async (t) => {
  const f = fixture(t);
  const mkdir = blockFs(t, f, 'mkdir');
  const writer = blockFs(t, f, 'writeFile', 0);
  let obsoleteSerializations = 0;
  f.fire({ toJSON() { obsoleteSerializations += 1; return { obsolete: true }; } });
  await mkdir.starts[0].promise;
  f.fire({ value: 'latest' });
  mkdir.gates[0].resolve();
  await f.store.flushAsync();

  assert.equal(obsoleteSerializations, 0, 'obsolete generation must not be serialized');
  assert.equal(writer.calls.length, 1);
  assert.deepEqual(f.disk(), { value: 'latest' });
});

test('immediate write supersedes pending snapshots during a blocked async rename', async (t) => {
  const f = fixture(t);
  const rename = blockFs(t, f, 'rename');
  const writer = blockFs(t, f, 'writeFile', 0);
  f.fire({ value: 'first' });
  await rename.starts[0].promise;
  for (let value = 1; value <= 3; value += 1) f.fire({ value });
  f.store.writeImmediate({ value: 'immediate' });
  assert.deepEqual(f.disk(), { value: 'immediate' });
  rename.gates[0].resolve();
  await f.store.flushAsync();

  assert.equal(writer.calls.length, 1, 'immediate write must discard older pending IO');
  assert.deepEqual(f.disk(), { value: 'immediate' });
  assert.equal(f.store.getWriteState().durableGeneration, f.store.getWriteState().acceptedGeneration);
});

test('delete discards pending snapshots and repairs a blocked async rename', async (t) => {
  const f = fixture(t);
  const rename = blockFs(t, f, 'rename');
  const writer = blockFs(t, f, 'writeFile', 0);
  f.store.writeImmediate({ value: 'initial' });
  f.fire({ value: 'first' });
  await rename.starts[0].promise;
  for (let value = 1; value <= 3; value += 1) f.fire({ value });
  f.store.delete();
  assert.equal(fs.existsSync(f.filePath), false);
  rename.gates[0].resolve();
  await f.store.flushAsync();

  assert.equal(writer.calls.length, 1, 'delete must discard older pending IO');
  assert.equal(fs.existsSync(f.filePath), false);
  assert.equal(f.store.hasPendingWrite(), false);
});

test('flushAsync already waiting on a write also waits for the latest accepted generation', async (t) => {
  const f = fixture(t);
  const writer = blockFs(t, f, 'writeFile', 2);
  f.fire({ value: 'first' });
  await writer.starts[0].promise;
  let settled = false;
  const draining = f.store.flushAsync().then(() => { settled = true; });
  // Leave this value in the debounce window: the waiting flush must drain it.
  const latest = f.store.write({ value: 'latest' });
  writer.gates[0].resolve();
  // An old implementation settles before the second write starts. Racing
  // against its completion avoids leaving the regression hung on that bug.
  await Promise.race([writer.starts[1].promise, draining]);
  assert.equal(settled, false, 'flush must wait for the latest accepted generation');
  writer.gates[1].resolve();
  await draining;

  assert.deepEqual(f.disk(), { value: 'latest' });
  assert.equal(f.store.getWriteState().durableGeneration, latest.generation);
});

test('synchronous flush persists the latest queued snapshot during a blocked rename', async (t) => {
  const f = fixture(t);
  const rename = blockFs(t, f, 'rename');
  f.fire({ value: 'first' });
  await rename.starts[0].promise;
  f.fire({ value: 'latest' });
  const flushed = f.store.flush();
  const diskAtFlush = fs.existsSync(f.filePath) ? f.disk() : null;
  rename.gates[0].resolve();
  await f.store.flushAsync();

  assert.equal(flushed, true, 'synchronous flush must drain queued snapshots');
  assert.deepEqual(diskAtFlush, { value: 'latest' });
  assert.deepEqual(f.disk(), { value: 'latest' });
});

test('flushAsync settles the generation accepted at entry while a writer keeps writing', async (t) => {
  const f = fixture(t);
  f.store.write({ n: 0 });
  const original = fs.promises.writeFile;
  let calls = 0;
  let writing = true;
  t.mock.method(fs.promises, 'writeFile', async (...args) => {
    calls += 1;
    if (writing && calls < 1000) f.store.write({ n: calls });
    return original.apply(fs.promises, args);
  });
  await f.store.flushAsync();
  assert.ok(calls < 20, `flush must not chase later writes (${calls} writes)`);
  writing = false;
  await f.store.flushAsync();
  assert.equal(f.disk().n, calls - 1);
  assert.equal(f.store.hasPendingWrite(), false);
});

test('flushAsync returns while debounced writes keep refilling the running drain', async (t) => {
  const f = fixture(t);
  f.fire({ n: 0 });
  const original = fs.promises.writeFile;
  let calls = 0;
  let writing = true;
  t.mock.method(fs.promises, 'writeFile', async (...args) => {
    calls += 1;
    // Each write outlasts the debounce: a new write's timer fires mid-write and refills the drain slot.
    if (writing && calls < 1000) f.fire({ n: calls });
    return original.apply(fs.promises, args);
  });
  f.store.write({ n: 'target' });
  await f.store.flushAsync();
  assert.ok(calls < 20, `flush must settle its own generation, not the drain (${calls} writes)`);
  writing = false;
  await f.store.flushAsync();
  assert.equal(f.store.hasPendingWrite(), false);
});
