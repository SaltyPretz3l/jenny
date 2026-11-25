'use strict';
// new-test-file: row 200's Strata card in the model library merge (moved out of model-library-merge.test.js at its 600-line cap)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const merge = require('../renderer/shell/model-library/model-library-merge.js');

const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'model-recommendation-catalog.json'), 'utf8'));

function mergeLibrary(overrides = {}) {
  return merge.mergeModelLibrary({
    installed: [],
    ollamaTags: [],
    recommendations: [],
    hardware: { gpu: { type: 'cuda', name: 'Test GPU', vram_mb: 16384 } },
    memory: { totalMb: 32768, availableMb: 24576 },
    catalogMeta: { catalogVersion: catalog.catalogVersion },
    activeModel: '',
    preferredLocalModel: '',
    ...overrides,
  });
}

const STRATA_INPUT = {
  id: 'inkling-2-mini-sq-20', displayName: 'Inkling 2 Mini', aliases: ['inkling-2-mini-sq-20', 'inkling-2-mini'], params: '26.4B', quant: 'SQ-20',
  contextLength: 114432, sizeBytes: 19346685952 + 636526592,
  manager: { state: 'stopped', alias: '', port: 0, identityRetained: false, lastError: '' }, lock: null,
};

test('a Strata input becomes one installed Inkling card: its fields, no VRAM figure, no recommendation, the Strata engine', () => {
  const { cards } = mergeLibrary({ strata: STRATA_INPUT });
  const [card] = cards.filter((entry) => entry.selectedEngine === 'strata');
  assert.equal(cards.length, 1);
  assert.equal(card.key, 'inkling-2-mini-sq-20:latest');
  assert.equal(card.tag, 'inkling-2-mini-sq-20');
  assert.equal(card.displayName, 'Inkling 2 Mini');
  assert.equal(card.params, '26.4B');
  assert.equal(card.quant, 'SQ-20');
  assert.equal(card.contextLength, 114432);
  assert.equal(card.sizeBytes, 19346685952 + 636526592);
  assert.equal(card.engineType, 'openai-compatible');
  assert.equal(card.installed, true);
  assert.equal(card.vramRequiredMb, 0);
  assert.equal(card.fitState, 'unknown');
  assert.equal(card.recommended, false);
  assert.equal(card.serving, false);
  assert.equal(card.loadFailure, undefined);
  const serving = mergeLibrary({ strata: { ...STRATA_INPUT, manager: { ...STRATA_INPUT.manager, state: 'ready', alias: 'inkling-2-mini', port: 8035 } } }).cards[0];
  assert.equal(serving.serving, true);
  assert.equal(serving.servingPort, 8035);
  assert.equal(serving.active, true);
});

test('the engine model list entry for the Strata model does not become a second "Not in catalog" card', () => {
  const { cards } = mergeLibrary({
    strata: STRATA_INPUT,
    installed: [{ id: 'inkling-2-mini-sq-20', managed: 'strata', engine_type: 'openai-compatible' }],
  });
  assert.equal(cards.filter((entry) => entry.key === 'inkling-2-mini-sq-20:latest').length, 1);
  assert.equal(cards[0].selectedEngine, 'strata');
});

test('a failed native pack or a Windows block locks the Strata row with its reason; a real load failure wins', () => {
  const pack = mergeLibrary({ strata: { ...STRATA_INPUT, lock: { kind: 'pack', message: 'the SQ-20 pack failed its check. See Engines and providers.' } } }).cards[0];
  assert.deepEqual(pack.loadFailure, { cause: 'other', message: 'the SQ-20 pack failed its check. See Engines and providers.', context: null, at: '', engine: 'openai-compatible', model: 'inkling-2-mini-sq-20', managed: 'strata' });
  const blocked = mergeLibrary({ strata: { ...STRATA_INPUT, lock: { kind: 'blocked', message: 'Windows blocked the engine. See Engines and providers.' } } }).cards[0];
  assert.equal(blocked.loadFailure.message, 'Windows blocked the engine. See Engines and providers.');
  const real = { cause: 'timeout', message: 'slow', context: null, at: '', engine: 'openai-compatible', model: 'inkling-2-mini-sq-20' };
  const both = mergeLibrary({ strata: { ...STRATA_INPUT, lock: { kind: 'pack', message: 'x' } }, loadFailure: real }).cards[0];
  assert.equal(both.loadFailure, real);
});

test('a null or empty Strata source changes nothing', () => {
  const plain = mergeLibrary();
  assert.deepEqual(mergeLibrary({ strata: null }), plain);
  assert.deepEqual(mergeLibrary({ strata: {} }), plain);
  assert.equal(mergeLibrary({ strata: STRATA_INPUT, ninfer: null }).cards.length, 1);
});
