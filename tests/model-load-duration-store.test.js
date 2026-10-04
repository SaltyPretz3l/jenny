'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ModelLoadDurationStore,
  buildDurationKey,
  MAX_ENTRIES,
  MAX_DURATION_MS,
  MIN_RECORDED_MS,
  STORE_VERSION,
} = require('../services/model-load-duration-store');

// T-10: every temp directory goes when its test ends.
function makeTempFilePath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-load-durations-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'model-load-durations.json');
}

test('record then get round-trips the last load of an (engine, model) pair', (t) => {
  const store = new ModelLoadDurationStore({ filePath: makeTempFilePath(t), now: () => 1_000 });
  assert.equal(store.get({ engine: 'llama-server', modelId: 'qwen3.8-27b' }), null);
  store.record({ engine: 'llama-server', modelId: 'qwen3.8-27b', durationMs: 48_250.4 });
  assert.deepEqual(store.get({ engine: 'LLAMA-SERVER', modelId: 'qwen3.8-27b' }), {
    engine: 'llama-server', modelId: 'qwen3.8-27b', lastMs: 48_250, observedAt: 1_000,
  });
  store.record({ engine: 'llama-server', modelId: 'qwen3.8-27b', durationMs: 12_000 });
  assert.equal(store.get({ engine: 'llama-server', modelId: 'qwen3.8-27b' }).lastMs, 12_000, 'the newest load replaces the last');
  assert.equal(buildDurationKey({ engine: 'Ollama', modelId: 'a:b' }), 'ollama|a:b');
});

test('an unnamed model, a non-positive or absurd duration is ignored', (t) => {
  const store = new ModelLoadDurationStore({ filePath: makeTempFilePath(t) });
  assert.equal(store.record({ engine: 'ollama', modelId: '', durationMs: 5_000 }), null);
  assert.equal(store.record({ engine: 'ollama', modelId: 'm', durationMs: 0 }), null);
  assert.equal(store.record({ engine: 'ollama', modelId: 'm', durationMs: MAX_DURATION_MS + 1 }), null);
  assert.equal(store.record({ engine: 'ollama', modelId: 'm', durationMs: Number.NaN }), null);
  assert.deepEqual(store.list(), []);
});

test('the store is bounded to MAX_ENTRIES pairs, least recently observed evicted first', (t) => {
  let clock = 0;
  const store = new ModelLoadDurationStore({ filePath: makeTempFilePath(t), now: () => { clock += 1; return clock; } });
  for (let i = 0; i < MAX_ENTRIES + 3; i += 1) {
    store.record({ engine: 'ollama', modelId: `model-${i}`, durationMs: 1_000 + i });
  }
  assert.equal(store.list().length, MAX_ENTRIES);
  assert.equal(store.get({ engine: 'ollama', modelId: 'model-0' }), null, 'the oldest three are gone');
  assert.equal(store.get({ engine: 'ollama', modelId: 'model-2' }), null);
  assert.equal(store.get({ engine: 'ollama', modelId: 'model-3' }).lastMs, 1_003);
  assert.equal(store.get({ engine: 'ollama', modelId: `model-${MAX_ENTRIES + 2}` }).lastMs, 1_000 + MAX_ENTRIES + 2);
});

test('a corrupt file degrades to an empty store and is rewritten on the next record', (t) => {
  const filePath = makeTempFilePath(t);
  fs.writeFileSync(filePath, '{ not json', 'utf8');
  const logs = [];
  const store = new ModelLoadDurationStore({ filePath, logger: (level, event) => logs.push([level, event]) });
  assert.equal(store.get({ engine: 'ollama', modelId: 'm' }), null);
  assert.deepEqual(store.list(), []);
  store.record({ engine: 'ollama', modelId: 'm', durationMs: 9_000 });
  assert.equal(store.get({ engine: 'ollama', modelId: 'm' }).lastMs, 9_000);
  assert.equal(logs.some(([, event]) => String(event).includes('record_failed')), false);
});

test('a pre-version blob without a durations map loads as empty', (t) => {
  const filePath = makeTempFilePath(t);
  fs.writeFileSync(filePath, JSON.stringify({ version: 0, durations: 'nope' }), 'utf8');
  const store = new ModelLoadDurationStore({ filePath });
  assert.deepEqual(store.list(), []);
});

// A-5 (owner, 2026-09-29): a sub-second load is a warm reload of a resident
// model; recording it would hide the cold-load figure the popover exists for.
test('a load under MIN_RECORDED_MS is not recorded, so the cold-load figure survives', (t) => {
  const store = new ModelLoadDurationStore({ filePath: makeTempFilePath(t) });
  assert.equal(MIN_RECORDED_MS, 1_000);
  store.record({ engine: 'ollama', modelId: 'qwen3:8b', durationMs: 48_000 });
  assert.equal(store.record({ engine: 'ollama', modelId: 'qwen3:8b', durationMs: 900 }), null);
  assert.equal(store.get({ engine: 'ollama', modelId: 'qwen3:8b' }).lastMs, 48_000);
  store.record({ engine: 'ollama', modelId: 'qwen3:8b', durationMs: 1_000 });
  assert.equal(store.get({ engine: 'ollama', modelId: 'qwen3:8b' }).lastMs, 1_000, 'otherwise the last load wins');
});

test('an Ollama bare name and its :latest tag are one entry', (t) => {
  const store = new ModelLoadDurationStore({ filePath: makeTempFilePath(t) });
  store.record({ engine: 'ollama', modelId: 'qwen3', durationMs: 30_000 });
  assert.equal(store.get({ engine: 'ollama', modelId: 'qwen3:latest' }).lastMs, 30_000);
  store.record({ engine: 'ollama', modelId: 'Qwen3:Latest', durationMs: 20_000 });
  assert.equal(store.get({ engine: 'ollama', modelId: 'qwen3' }).lastMs, 20_000);
  assert.equal(store.list().length, 1);
  assert.equal(buildDurationKey({ engine: 'llama-server', modelId: 'Qwen3.8-27B.gguf' }), 'llama-server|Qwen3.8-27B.gguf', 'non-Ollama ids stay verbatim');
});

test('a blob of another version loads as empty', (t) => {
  const filePath = makeTempFilePath(t);
  fs.writeFileSync(filePath, JSON.stringify({
    version: STORE_VERSION + 1,
    durations: { 'ollama|m:latest': { engine: 'ollama', modelId: 'm:latest', lastMs: 5_000, observedAt: 1 } },
  }), 'utf8');
  assert.deepEqual(new ModelLoadDurationStore({ filePath }).list(), []);
});

// A-4: the file is read once; a corrupt one logs once, not on every status build.
test('the store reads its file once and serves later reads from memory', (t) => {
  let reads = 0;
  let writes = 0;
  const backing = {
    readWithStatus(fallback) { reads += 1; return { value: fallback }; },
    write() { writes += 1; },
  };
  const store = new ModelLoadDurationStore({ store: backing });
  for (let i = 0; i < 5; i += 1) { store.get({ engine: 'ollama', modelId: 'm' }); }
  store.record({ engine: 'ollama', modelId: 'm', durationMs: 5_000 });
  assert.equal(store.get({ engine: 'ollama', modelId: 'm' }).lastMs, 5_000);
  assert.equal(reads, 1);
  assert.equal(writes, 1);
});
