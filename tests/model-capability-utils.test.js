/* Unit tests for renderer/shared/model-capability-utils.js — the name-pattern
 * heuristics behind the small-model plan-mode composer hint. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SMALL_MODEL_PARAM_THRESHOLD_B,
  isPlanCapableModel,
  formatModelLabel,
} = require('../renderer/shared/model-capability-utils');

test('threshold constant is 7B effective params', () => {
  assert.equal(SMALL_MODEL_PARAM_THRESHOLD_B, 7);
});

test('small dense local models are not plan-capable', () => {
  assert.equal(isPlanCapableModel('gemma4-e4b-it-q6_k:latest'), false);
  assert.equal(isPlanCapableModel('gemma4-e2b'), false);
  assert.equal(isPlanCapableModel('llama3.2:3b'), false);
});

test('MoE tags with small active params classify small despite a big total', () => {
  // 35B total / 3B active — the "35b" must not false-pass the size match.
  assert.equal(isPlanCapableModel('qwen3.6-35b-a3b'), false);
  assert.equal(isPlanCapableModel('qwen3.6:35b-a3b-ud-q4_k_xl'), false);
});

test('unknown or empty names err toward small (hint shows)', () => {
  assert.equal(isPlanCapableModel(''), false);
  assert.equal(isPlanCapableModel(null), false);
  assert.equal(isPlanCapableModel('mystery-model'), false);
});

test('large dense models are plan-capable', () => {
  assert.equal(isPlanCapableModel('some-70b-instruct'), true);
  assert.equal(isPlanCapableModel('qwen3.6:32b'), true);
  assert.equal(isPlanCapableModel('mistral-small-24b-instruct'), true);
});

test('formatModelLabel strips tag + quant + suffix noise', () => {
  const label = formatModelLabel('gemma4-e4b-it-q6_k:latest');
  assert.ok(label.length > 0);
  assert.ok(!label.includes(':latest'));
  assert.ok(!/q6/i.test(label));
  assert.equal(formatModelLabel(''), 'the current model');
});
