'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ModelFitObservationStore,
  buildObservationKey,
  MAX_ENTRIES,
} = require('../services/model-fit-observation-store');

function makeTempFilePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-fit-obs-'));
  return path.join(dir, 'model-fit-observations.json');
}

function baseObservation(overrides = {}) {
  return {
    modelId: 'llama3.1:8b',
    digest: 'sha256:abc',
    engine: 'ollama',
    gpuName: 'NVIDIA RTX 5070 Ti',
    gpuVramMb: 16384,
    contextLength: 8192,
    sizeMb: 4900,
    vramMb: 4900,
    offloadedMb: 0,
    residentModelCount: 1,
    ...overrides,
  };
}

test('record then get round-trips an observation', () => {
  const store = new ModelFitObservationStore({ filePath: makeTempFilePath() });
  const observation = baseObservation();
  store.record(observation);
  const found = store.get({
    modelId: observation.modelId,
    digest: observation.digest,
    gpuName: observation.gpuName,
    gpuVramMb: observation.gpuVramMb,
  });
  assert.ok(found);
  assert.equal(found.modelId, 'llama3.1:8b');
  assert.equal(found.vramMb, 4900);
});

test('get returns null for a GPU mismatch', () => {
  const store = new ModelFitObservationStore({ filePath: makeTempFilePath() });
  store.record(baseObservation());
  const found = store.get({
    modelId: 'llama3.1:8b',
    digest: 'sha256:abc',
    gpuName: 'Apple M3 Max',
    gpuVramMb: 36864,
  });
  assert.equal(found, null);
});

test('buildObservationKey prefers digest over modelId when both present', () => {
  const keyWithDigest = buildObservationKey({
    engine: 'ollama', digest: 'sha256:abc', modelId: 'other-name', gpuName: 'GPU', gpuVramMb: 8000,
  });
  const keySameDigestDifferentName = buildObservationKey({
    engine: 'ollama', digest: 'sha256:abc', modelId: 'irrelevant', gpuName: 'GPU', gpuVramMb: 8000,
  });
  assert.equal(keyWithDigest, keySameDigestDifferentName);
});

test('record persists to disk and survives a fresh store instance', () => {
  const filePath = makeTempFilePath();
  const store1 = new ModelFitObservationStore({ filePath });
  store1.record(baseObservation());

  const store2 = new ModelFitObservationStore({ filePath });
  const found = store2.get({
    modelId: 'llama3.1:8b',
    digest: 'sha256:abc',
    gpuName: 'NVIDIA RTX 5070 Ti',
    gpuVramMb: 16384,
  });
  assert.equal(found.modelId, 'llama3.1:8b');
  assert.equal(found.vramMb, 4900);
  assert.equal(found.sizeMb, 4900);
  assert.ok(found);
});

test('LRU cap evicts the oldest entries beyond MAX_ENTRIES', () => {
  let clock = 1000;
  const store = new ModelFitObservationStore({ filePath: makeTempFilePath(), now: () => clock });
  for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
    clock += 1;
    store.record(baseObservation({ digest: `sha256:model-${i}` }));
  }
  const all = store.list();
  assert.equal(all.length, MAX_ENTRIES);
  // The earliest-recorded entries (model-0..model-4) should have been evicted.
  const found0 = store.get({
    modelId: 'llama3.1:8b', digest: 'sha256:model-0', gpuName: 'NVIDIA RTX 5070 Ti', gpuVramMb: 16384,
  });
  assert.equal(found0, null);
  const foundLast = store.get({
    modelId: 'llama3.1:8b',
    digest: `sha256:model-${MAX_ENTRIES + 4}`,
    gpuName: 'NVIDIA RTX 5070 Ti',
    gpuVramMb: 16384,
  });
  assert.ok(foundLast);
});

test('TTL prune drops observations older than 90 days', () => {
  let clock = 1_000_000;
  const store = new ModelFitObservationStore({ filePath: makeTempFilePath(), now: () => clock });
  store.record(baseObservation());
  // Advance clock past the 90-day TTL.
  clock += 91 * 24 * 60 * 60 * 1000;
  store.prune();
  const found = store.get({
    modelId: 'llama3.1:8b',
    digest: 'sha256:abc',
    gpuName: 'NVIDIA RTX 5070 Ti',
    gpuVramMb: 16384,
  });
  assert.equal(found, null);
});

test('corrupt store file degrades to an empty store rather than throwing', () => {
  const filePath = makeTempFilePath();
  fs.writeFileSync(filePath, '{ not valid json', 'utf8');
  const store = new ModelFitObservationStore({ filePath });
  assert.deepEqual(store.list(), []);
  // record() must still work after a corrupt read.
  const result = store.record(baseObservation());
  assert.ok(result);
});

test('recording 8k then 128k for the same model keeps both entries and get() resolves the 128k one', () => {
  const store = new ModelFitObservationStore({ filePath: makeTempFilePath() });
  store.record(baseObservation({ contextLength: 8192, vramMb: 5000 }));
  store.record(baseObservation({ contextLength: 131072, vramMb: 6200 }));

  // Both context-length measurements must survive as distinct entries.
  assert.equal(store.list().length, 2);

  // get() ignores contextLength and picks the largest-context (most
  // conservative) measurement for the (model, GPU) pair.
  const found = store.get({
    modelId: 'llama3.1:8b',
    digest: 'sha256:abc',
    gpuName: 'NVIDIA RTX 5070 Ti',
    gpuVramMb: 16384,
  });
  assert.ok(found);
  assert.equal(found.contextLength, 131072);
  assert.equal(found.vramMb, 6200);
});

test('record never throws even when the underlying store write fails', () => {
  const fakeStore = {
    readWithStatus: () => ({ value: { version: 1, observations: {} } }),
    write: () => {
      throw new Error('disk full');
    },
  };
  const store = new ModelFitObservationStore({ filePath: makeTempFilePath(), store: fakeStore });
  let result;
  assert.doesNotThrow(() => {
    result = store.record(baseObservation());
  });
  // The write failure is swallowed internally (logged, not thrown), so
  // record() still returns the normalized in-memory observation.
  assert.equal(result.modelId, 'llama3.1:8b');
  assert.equal(result.vramMb, 4900);
});
