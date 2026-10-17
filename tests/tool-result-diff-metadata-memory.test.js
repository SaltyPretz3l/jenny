'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeMemoryResultMetadata } = require('../services/backend/memory-result-metadata');
const {
  normalizePersistedToolResultMetadata,
} = require('../services/backend/tool-result-diff-metadata');

const SAVED = Object.freeze({
  result_kind: 'memory',
  action: 'remember',
  status: 'saved',
  memory_id: 12,
  revision: 1,
  operation_id: 'tool:session-1:call_1',
  scope: 'project',
  kind: 'preference',
  duplicate: false,
  undoable: true,
  text_preview: 'Prefers tabs',
  effects: 'committed',
  text: 'the full memory text must never persist through this path',
  lesson_text: 'nor this',
});

test('memory result metadata keeps exactly the allowlisted keys', () => {
  assert.deepEqual(normalizePersistedToolResultMetadata(SAVED), {
    result_kind: 'memory',
    action: 'remember',
    status: 'saved',
    memory_id: 12,
    revision: 1,
    operation_id: 'tool:session-1:call_1',
    scope: 'project',
    kind: 'preference',
    duplicate: false,
    undoable: true,
    text_preview: 'Prefers tabs',
  });
});

test('memory refusals keep their reason and drop unknown enum values', () => {
  assert.deepEqual(normalizeMemoryResultMetadata({
    result_kind: 'memory', action: 'forget', status: 'refused', reason: 'unobserved',
    scope: 'elsewhere', kind: 'secret', memory_id: -4, revision: 1.5,
    operation_id: 'tool:bad id', undoable: 'yes',
  }), { result_kind: 'memory', action: 'forget', status: 'refused', reason: 'unobserved' });
});

test('memory metadata with an unknown action, status or kind is dropped', () => {
  assert.equal(normalizeMemoryResultMetadata({ ...SAVED, result_kind: 'home' }), null);
  assert.equal(normalizeMemoryResultMetadata({ ...SAVED, action: 'erase' }), null);
  assert.equal(normalizeMemoryResultMetadata({ ...SAVED, status: 'done' }), null);
  assert.equal(normalizeMemoryResultMetadata(null), null);
  assert.equal(normalizeMemoryResultMetadata([SAVED]), null);
});

test('a reflection receipt keeps its origin; an unknown origin is dropped', () => {
  assert.equal(normalizePersistedToolResultMetadata({ ...SAVED, origin: 'reflection' }).origin, 'reflection');
  assert.equal(Object.hasOwn(normalizeMemoryResultMetadata({ ...SAVED, origin: 'somewhere' }), 'origin'), false);
  assert.equal(Object.hasOwn(normalizeMemoryResultMetadata({ ...SAVED, origin: 7 }), 'origin'), false);
});

test('the memory text preview is bounded to 80 characters', () => {
  const preview = 'x'.repeat(200);
  const normalized = normalizeMemoryResultMetadata({ ...SAVED, text_preview: preview });
  assert.equal(normalized.text_preview.length, 80);
});
