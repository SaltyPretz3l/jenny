'use strict';

// Row 38 item 1 (variant B): the merge attaches Electron's classified load
// failure to the one card it names. Split from model-library-merge.test.js
// (at the 600-line ratchet).
const test = require('node:test');
const assert = require('node:assert/strict');

const merge = require('../renderer/shell/model-library/model-library-merge.js');

function mergeLibrary(overrides = {}) {
  return merge.mergeModelLibrary({
    installed: [], ollamaTags: [], recommendations: [],
    hardware: { gpu: { type: 'cuda', name: 'Test GPU', vram_mb: 16384 } },
    memory: { totalMb: 32768, availableMb: 24576 },
    activeModel: '', preferredLocalModel: '',
    ...overrides,
  });
}

test('load failure attaches only to the matching canonical card and unknown failures attach nowhere', () => {
  const failure = { cause: 'timeout', model: 'QWEN3:8B', at: '2026-10-07T12:00:00Z' };
  const inputs = { installed: [{ id: 'qwen3:8b' }, { id: 'other:latest' }] };
  const result = mergeLibrary({ ...inputs, loadFailure: failure });
  assert.equal(result.cards.find((card) => card.tag === 'qwen3:8b').loadFailure, failure);
  assert.equal(Object.hasOwn(result.cards.find((card) => card.tag === 'other:latest'), 'loadFailure'), false);
  for (const loadFailure of [null, { ...failure, model: 'unknown:8b' }]) {
    assert.equal(mergeLibrary({ ...inputs, loadFailure }).cards.some((card) => Object.hasOwn(card, 'loadFailure')), false);
  }
  const bare = { ...failure, model: 'other' };
  assert.equal(mergeLibrary({ ...inputs, loadFailure: bare }).cards.find((card) => card.tag === 'other:latest').loadFailure, bare);
  const catalogFailure = { ...failure, model: 'catalog:8b' };
  const catalogResult = mergeLibrary({ ...inputs, recommendations: [{ pullTag: 'catalog:8b' }], loadFailure: catalogFailure });
  assert.equal(catalogResult.cards.find((card) => card.tag === 'catalog:8b').loadFailure, catalogFailure);
});

test('load failure attaches to an untagged library GGUF own card across casing', () => {
  const row = {
    id: 'MyModel', size: 5, engine_type: 'openai-compatible', available: true,
    libraryGguf: true, ownCardKey: 'MyModel',
  };
  for (const model of ['mymodel', 'mymodel:latest']) {
    const failure = { cause: 'timeout', model, at: '2026-10-07T12:00:00Z' };
    const result = mergeLibrary({ installed: [row, { id: 'other:latest' }], loadFailure: failure });
    const ownCard = result.cards.find((card) => card.key === 'MyModel');
    assert.equal(ownCard.libraryGguf, true);
    assert.equal(ownCard.loadFailure, failure);
    assert.equal(Object.hasOwn(result.cards.find((card) => card.key === 'other:latest'), 'loadFailure'), false);
  }
});

// Astra wave-2 review (2026-10-07): an Ollama card and an own-card GGUF of the same name are
// separate models; a failure reported with the exact key stays on that one card only.
test('a failure whose model matches a card key exactly does not spill onto a same-name own card', () => {
  const own = { id: 'x', size: 5, engine_type: 'openai-compatible', available: true, libraryGguf: true, ownCardKey: 'x' };
  const failure = { cause: 'memory', model: 'x:latest', at: '2026-10-07T12:00:00Z' };
  const result = mergeLibrary({ installed: [{ id: 'x:latest' }, own], loadFailure: failure });
  assert.equal(result.cards.find((card) => card.key === 'x:latest').loadFailure, failure);
  assert.equal(Object.hasOwn(result.cards.find((card) => card.key === 'x'), 'loadFailure'), false);
});
