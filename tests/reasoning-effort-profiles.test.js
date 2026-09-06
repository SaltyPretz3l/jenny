'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildReasoningEffortOptions,
  getReasoningEffortProfile,
  normalizeManagedReasoningEffortForModel,
  normalizeReasoningEffort,
  normalizeReasoningEffortForModel,
  supportsOllamaGradedThinking,
} = require('../reasoning-effort-profiles');

test('reasoning-effort-profiles.js prefixes stay in lockstep with model_name.py QWEN38_MODEL_PREFIXES', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const jsSource = fs.readFileSync(path.join(repoRoot, 'reasoning-effort-profiles.js'), 'utf8');
  const pythonSource = fs.readFileSync(path.join(repoRoot, 'sidecar', 'ai', 'engines', 'model_name.py'), 'utf8');
  const jsMatch = jsSource.match(
    /^\s*const OLLAMA_GRADED_THINKING_MODEL_PREFIXES = Object\.freeze\(\[([^\]\r\n]+)\]\);\s*$/m,
  );
  const pythonMatch = pythonSource.match(/^QWEN38_MODEL_PREFIXES = \(([^)\r\n]+)\)\s*$/m);

  assert.ok(jsMatch, 'OLLAMA_GRADED_THINKING_MODEL_PREFIXES literal not found in reasoning-effort-profiles.js');
  assert.ok(pythonMatch, 'QWEN38_MODEL_PREFIXES literal not found in sidecar/ai/engines/model_name.py');

  const jsPrefixes = new Set([...jsMatch[1].matchAll(/(['"])(.*?)\1/g)].map((match) => match[2]));
  const pythonPrefixes = new Set([...pythonMatch[1].matchAll(/(['"])(.*?)\1/g)].map((match) => match[2]));
  assert.deepEqual(
    jsPrefixes,
    pythonPrefixes,
  );
});

test('ChatGPT reasoning choices are model-specific and keep Use default distinct', () => {
  assert.deepEqual(
    buildReasoningEffortOptions('gpt-5.6-sol').map((option) => option.value),
    ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.deepEqual(
    buildReasoningEffortOptions('gpt-5.5').map((option) => option.value),
    ['default', 'low', 'medium', 'high', 'xhigh'],
  );
  assert.equal(buildReasoningEffortOptions('gpt-5.6-sol')[0].label, 'Use default');
});

test('unsupported models expose Use default only and invalid stored efforts normalize safely', () => {
  assert.deepEqual(buildReasoningEffortOptions('gemma3:4b'), [
    { value: 'default', label: 'Use default' },
  ]);
  assert.equal(normalizeReasoningEffortForModel('max', 'gpt-5.5'), 'default');
  assert.equal(normalizeReasoningEffortForModel('xhigh', 'gpt-5.5'), 'xhigh');
});

test('Codex CLI choices include its transport-supported low-end levels', () => {
  assert.deepEqual(getReasoningEffortProfile('codex-cli/default').efforts, [
    'none', 'minimal', 'low', 'medium', 'high', 'xhigh',
  ]);
  assert.equal(normalizeReasoningEffort('automatic'), 'default');
});

test('declared provider metadata overrides conservative catalog defaults', () => {
  const capabilities = {
    default_reasoning_effort: 'low',
    reasoning_efforts: ['minimal', 'low'],
  };
  assert.deepEqual(
    buildReasoningEffortOptions('future-model', capabilities).map((option) => option.value),
    ['default', 'minimal', 'low'],
  );
});

test('Qwen3.8 declared metadata exposes provider-native effort labels', () => {
  const capabilities = {
    default_reasoning_effort: 'medium',
    reasoning_efforts: ['none', 'low', 'medium', 'high', 'max'],
  };
  assert.deepEqual(
    buildReasoningEffortOptions('qwen3.8:27b-q3-k-s', capabilities),
    [
      { value: 'default', label: 'Use default' },
      { value: 'none', label: 'None' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Maximum' },
    ],
  );
});

test('historical Ultra preferences migrate to Maximum without advertising delegation', () => {
  assert.equal(normalizeReasoningEffort('ultra'), 'max');
  assert.equal(buildReasoningEffortOptions('gpt-5.6-sol').some((option) => option.value === 'ultra'), false);
});

test('managed Ollama clamp discards graded efforts on non-qwen3.8 models (CMP-AI-0005 leak)', () => {
  // Regression: a graded level chosen while qwen3.8 was active must not ride
  // into ornith15/gemma requests when the user switches back (owner-hit
  // 2026-08-31; graded thinking is qwen3.8-family only in the Ollama engine).
  assert.equal(
    normalizeManagedReasoningEffortForModel('medium', 'ollama', { modelId: 'ornith15:9b-q6-256k' }),
    'default',
  );
  assert.equal(
    normalizeManagedReasoningEffortForModel('high', 'ollama', { modelId: 'batiai/gemma4-e4b:q6' }),
    'default',
  );
  assert.equal(
    normalizeManagedReasoningEffortForModel('medium', 'ollama', { modelId: 'qwen3.5:14b' }),
    'default',
  );
  // Explicit off stays off everywhere; qwen3.8 keeps its graded ladder.
  assert.equal(
    normalizeManagedReasoningEffortForModel('none', 'ollama', { modelId: 'ornith15:9b-q6-256k' }),
    'none',
  );
  assert.equal(
    normalizeManagedReasoningEffortForModel('medium', 'ollama', { modelId: 'qwen3.8:27b-ud-iq3-s' }),
    'medium',
  );
  assert.equal(
    normalizeManagedReasoningEffortForModel('medium', 'ollama', { modelId: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-IQ3_S' }),
    'medium',
  );
  // Non-Ollama paths are untouched.
  assert.equal(
    normalizeManagedReasoningEffortForModel('high', 'chatgpt', { modelId: 'gpt-5.5' }),
    'high',
  );
  assert.equal(supportsOllamaGradedThinking('qwen-3.8-preview'), true);
  assert.equal(supportsOllamaGradedThinking('qwen3.6:35b'), false);
});
