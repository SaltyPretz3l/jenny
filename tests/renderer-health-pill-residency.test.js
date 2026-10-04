'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatEngineModel } = require('../renderer/shell/renderer-health-pill-markup-utils');

for (const [engine, residency, kind] of [['chatgpt', 'remote', 'cloud'], ['codex-cli', 'cli', 'CLI']]) {
  test(`health popover describes ${engine} as configured`, () => {
    const markup = formatEngineModel({ runtime: {
      engine, model: 'x', model_loaded: false,
      local_runtime: { model: { residency, configured: true, loaded: null } },
    } });
    assert.match(markup.html, new RegExp(`Configured \\(${kind}\\)`));
    assert.doesNotMatch(markup.html, /loaded/i);
    assert.equal(markup.valueClass, 'success');
    // The existing health facade supplies engine/model even when it strips new fields.
    assert.match(formatEngineModel({ runtime: { engine, model: 'x' } }).html, /Configured/);
  });
  test(`health popover describes an unconfigured ${engine}`, () => {
    const markup = formatEngineModel({ runtime: { engine, local_runtime: {
      model: { residency, configured: false, loaded: null },
    } } });
    assert.match(markup.html, /Not configured/);
    assert.doesNotMatch(markup.html, /loaded/i);
    assert.equal(markup.valueClass, 'muted');
  });
}

test('status normalization keeps cloud/CLI residency and never reports their weights as unloaded', () => {
  const { normalizeLocalRuntime } = require('../services/backend/managed-sidecar-status');
  for (const residency of ['remote', 'cli']) {
    const normalized = normalizeLocalRuntime({
      engine: { type: residency === 'remote' ? 'chatgpt' : 'codex-cli' },
      model: { id: 'gpt-x', loaded: null, configured: true, residency },
      readiness: { status: 'ready', ready: true, model_loaded: null },
    });
    assert.equal(normalized.model.residency, residency);
    assert.equal(normalized.model.configured, true);
    assert.equal(normalized.model.loaded, null);
    assert.equal(normalized.readiness.model_loaded, null);
  }
  // Before the sidecar reports residency, the engine type alone keeps the popover honest.
  for (const [engine, residency] of [['chatgpt', 'remote'], ['codex-cli', 'cli']]) {
    const early = normalizeLocalRuntime(null, { engine, model: 'gpt-x' });
    assert.equal(early.model.residency, residency);
    assert.equal(early.model.loaded, null);
    assert.match(formatEngineModel({ runtime: { engine, model: 'gpt-x', local_runtime: early } }).html, /Configured/);
  }
  const local = normalizeLocalRuntime({ engine: { type: 'ollama' }, model: { id: 'gemma', loaded: true } });
  assert.equal(local.model.residency, 'local');
  assert.equal(local.model.loaded, true);
});
