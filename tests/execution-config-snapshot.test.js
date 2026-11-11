'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeKnowledgeRoots } = require('../services/backend/execution-config-snapshot');

test('knowledge roots are trimmed, and a missing list is empty', () => {
  assert.deepEqual(normalizeKnowledgeRoots({ knowledge_roots: [' C:/notes '] }), ['C:/notes']);
  assert.deepEqual(normalizeKnowledgeRoots(null), []);
});

test('too many roots are refused', () => {
  assert.throws(() => normalizeKnowledgeRoots({ knowledge_roots: Array(33).fill('a') }), /exceeds its bound/);
});

test('blank, non-text and oversized roots are refused', () => {
  for (const bad of ['   ', 7, 'a'.repeat(4097)]) {
    assert.throws(() => normalizeKnowledgeRoots({ knowledge_roots: [bad] }), /invalid path/);
  }
});
