'use strict';

// Stored tool-result metadata is a bounded copy (tool review, 2026-10-19): an
// arbitrary sidecar key cannot carry megabytes, hundreds of keys or a deep
// object into the session message and the live event, while the keys the
// renderer reads (trace_id, monitor, result_kind, ...) are kept.

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeToolResultMetadataForStorage } = require('../services/backend/tool-result-diff-metadata');
const {
  MAX_STORAGE_METADATA_DEPTH,
  boundedStorageMetadataValue,
} = require('../services/backend/tool-result-metadata-bounds');

test('the value bounder drops functions, non-finite numbers and over-deep objects', () => {
  assert.equal(boundedStorageMetadataValue(() => 1, 1), undefined);
  assert.equal(boundedStorageMetadataValue(Number.NaN, 1), null);
  assert.equal(boundedStorageMetadataValue({ a: 1 }, MAX_STORAGE_METADATA_DEPTH), undefined);
  assert.deepEqual(boundedStorageMetadataValue([1, () => 2, 'x'], 1), [1, 'x']);
});

test('strings, item counts and depth are bounded; known keys survive', () => {
  const deep = {};
  let cursor = deep;
  for (let level = 0; level < 12; level += 1) {
    cursor.next = { level };
    cursor = cursor.next;
  }
  const wide = {};
  for (let index = 0; index < 150; index += 1) wide[`k${index}`] = index;
  const metadata = {
    result_kind: 'shell',
    trace_id: 'trace-1',
    monitor: { monitor_id: 'mon-1' },
    blob: 'x'.repeat(3 * 1024 * 1024),
    list: Array.from({ length: 150 }, (_, index) => index),
    deep,
    ...wide,
  };
  const stored = normalizeToolResultMetadataForStorage(metadata);
  assert.equal(stored.result_kind, 'shell');
  assert.equal(stored.trace_id, 'trace-1');
  assert.deepEqual(stored.monitor, { monitor_id: 'mon-1' });
  assert.equal(stored.blob.length, 64 * 1024);
  assert.equal(stored.list.length, 100);
  assert.equal(Object.keys(stored).length, 100);
  let depth = 0;
  for (let node = stored.deep; node && node.next; node = node.next) depth += 1;
  assert.ok(depth < 12 && depth >= 5, `depth ${depth} is bounded`);
  assert.equal(JSON.stringify(stored).length < 200_000, true);
});

test('priority keys survive the item cap wherever they sit', () => {
  const metadata = {};
  for (let index = 0; index < 150; index += 1) metadata[`k${index}`] = index;
  metadata.failure_class = 'precondition_unmet';
  metadata.effects = 'none';
  const stored = normalizeToolResultMetadataForStorage(metadata);
  assert.equal(stored.failure_class, 'precondition_unmet');
  assert.equal(stored.effects, 'none');
  assert.equal(Object.keys(stored).length, 100);
});

test('prototype keys and structured keys are never copied raw', () => {
  const metadata = JSON.parse('{"__proto__": {"polluted": true}, "constructor": "x", "diff": "raw", "status": "ok"}');
  const stored = normalizeToolResultMetadataForStorage(metadata, {}, null);
  assert.equal(Object.hasOwn(stored, '__proto__'), false);
  assert.equal(Object.hasOwn(stored, 'constructor'), false);
  assert.equal(Object.hasOwn(stored, 'diff'), false);
  assert.equal(stored.status, 'ok');
  assert.equal(stored.polluted, undefined);
});
