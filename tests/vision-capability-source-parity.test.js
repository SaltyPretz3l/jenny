'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  HEURISTIC_VISION_SOURCES,
} = require('../renderer/chat/renderer-composer-vision-gate');

const EVIDENCE_SOURCES = [
  'server_props',
  'provider_contract',
  'unsupported',
  'api_show',
  'runtime',
  'status',
  'catalog',
];
const EXPECTED_SIDECAR_SOURCES = [
  'model_name',
  'provider_contract',
  'server_props',
  'unsupported',
];

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', ...relativePath), 'utf8');
}

function requireMatch(source, pattern, description) {
  const match = source.match(pattern);
  assert.ok(match, `${description} is present`);
  return match;
}

function scrapeSidecarVisionSources() {
  const vllmSource = readSource(['sidecar', 'ai', 'engines', 'vllm_engine.py']);
  const vllmMatch = requireMatch(
    vllmSource,
    /"vision":\s*"([^"]+)"\s+if\s+props_vision\s+is\s+not\s+None\s+else\s+"([^"]+)"/,
    'vLLM vision capability source assignment',
  );

  const chatgptSource = readSource(['sidecar', 'ai', 'engines', 'chatgpt_subscription.py']);
  const chatgptMatch = requireMatch(
    chatgptSource,
    /"vision":\s*"([^"]+)"/,
    'ChatGPT vision capability source assignment',
  );

  const ollamaSource = readSource(['sidecar', 'ai', 'engines', 'ollama_metadata.py']);
  const detectVisionBlock = requireMatch(
    ollamaSource,
    /def detect_vision\([\s\S]*?(?=\r?\n\r?\ndef )/,
    'Ollama detect_vision implementation',
  )[0];
  const ollamaSources = [...detectVisionBlock.matchAll(/return\s+(?:True|False),\s*"([^"]+)"/g)]
    .map((match) => match[1]);

  return new Set([vllmMatch[1], vllmMatch[2], chatgptMatch[1], ...ollamaSources]);
}

test('sidecar vision capability sources match renderer source vocabulary', () => {
  const sidecarSources = scrapeSidecarVisionSources();

  for (const source of sidecarSources) {
    assert.ok(
      HEURISTIC_VISION_SOURCES.has(source) || EVIDENCE_SOURCES.includes(source),
      `unknown vision capability source "${source}" would silently hard-block Send`,
    );
  }
  assert.deepEqual(
    [...sidecarSources].sort(),
    EXPECTED_SIDECAR_SOURCES,
    `sidecar vision capability sources changed: ${[...sidecarSources].sort().join(', ')}`,
  );
});

test('renderer keeps heuristic and evidence-backed vision sources distinct', () => {
  assert.equal(HEURISTIC_VISION_SOURCES.has('model_name'), true);
  assert.equal(HEURISTIC_VISION_SOURCES.has('catalog_absent'), true);
  for (const source of ['server_props', 'provider_contract', 'unsupported']) {
    assert.equal(HEURISTIC_VISION_SOURCES.has(source), false);
  }
});
