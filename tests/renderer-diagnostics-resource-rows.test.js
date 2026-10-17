'use strict';

// The Engine and memory facts (formerly the Performance resource rows): model memory, app memory and
// system memory read from status.budgets.resources, formatted by the shared Diagnostics formatters.
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatBytes } = require('../renderer/shell/renderer-diagnostics-format');
const { createOverviewHarness, makeState, readyBackend, MB, GB } = require('./helpers/diagnostics-overview-harness');

function memoryFacts(t, resources, extra) {
  const harness = createOverviewHarness(t);
  harness.render(makeState({ diagnosticsStatus: { backend: readyBackend(), budgets: { available: true, inputs: { usage: false }, resources, ...extra } } }), []);
  const read = (label) => harness.fact(label);
  const text = (label) => read(label).textContent.replace(/\s+/g, ' ').trim();
  return { harness, read, text };
}

test('model, app and system memory read from the resource measurements in order', (t) => {
  const { harness, text } = memoryFacts(t, {
    app_memory_bytes: 412 * MB,
    model_memory: { ram_bytes: 4.1 * GB, vram_bytes: 2 * GB, vram_total_bytes: 8 * GB, models: [{ name: 'alpha', size_bytes: 4.1 * GB }, { name: 'beta', size_bytes: null }] },
    workers: { active: 2, max: 4 },
    retained_caches: { bytes: 184 * MB, items: [{ name: 'Prompt cache' }] },
    system_memory: { percent: 91, pressure: 'high' },
  });
  const labels = Array.from(harness.group('Engine and memory').querySelectorAll('dt')).map((node) => node.textContent);
  assert.deepEqual(labels, ['Engine', 'Model memory', 'App memory', 'System memory']);
  assert.equal(text('App memory'), '412 MB');
  assert.equal(text('Model memory'), '2.0 GB VRAM of 8.0 GB · 4.1 GB RAM');
  assert.equal(text('System memory'), '91% in use high');
  assert.doesNotMatch(harness.text('diagnosticsRuntimeInventory'), /Workers|Retained caches|Prompt cache/, 'only the facts the design keeps');
});

test('missing resource measurements read Not measured', (t) => {
  const { read } = memoryFacts(t, undefined);
  for (const label of ['Model memory', 'App memory', 'System memory']) {
    assert.equal(read(label).textContent.trim(), 'Not measured', label);
    assert.ok(read(label).querySelector('.diagnostics-muted'));
  }
});

test('real zeros are measured; null VRAM and totals are omitted', (t) => {
  const { text } = memoryFacts(t, {
    app_memory_bytes: 0,
    model_memory: { ram_bytes: 0, vram_bytes: null, vram_total_bytes: null, models: [{ name: 'empty', size_bytes: 0 }] },
    system_memory: { percent: 0, pressure: 'normal' },
  });
  assert.equal(text('App memory'), '0 MB');
  assert.equal(text('Model memory'), '0 MB RAM');
  assert.equal(text('System memory'), '0% in use normal');
});

test('critical and unknown pressure keep their meaning', (t) => {
  const critical = memoryFacts(t, { system_memory: { percent: 95, pressure: 'critical' } });
  assert.equal(critical.text('System memory'), '95% in use critical');
  assert.ok(critical.read('System memory').querySelector('svg.inv-state-icon--error'));
  const unknown = memoryFacts(t, { system_memory: { percent: 62, pressure: null } });
  assert.equal(unknown.text('System memory'), '62% in use');
  assert.equal(unknown.read('System memory').querySelector('svg'), null);
});

test('no loaded model reads "No model in memory", not "No model loaded of 32.0 GB"', (t) => {
  const { harness, text } = memoryFacts(t, { model_memory: { ram_bytes: 0, vram_bytes: 0, vram_total_bytes: 32 * GB, models: [] } });
  assert.equal(text('Model memory'), 'No model in memory');
  assert.doesNotMatch(harness.text('diagnosticsRuntimeInventory'), /No model loaded|of 32\.0 GB/);
});

test('formatBytes preserves unknowns and the MB to GB boundary', () => {
  for (const value of [null, undefined, NaN, Infinity, '0']) assert.equal(formatBytes(value), null);
  assert.equal(formatBytes(0), '0 MB');
  assert.equal(formatBytes(1023 * MB), '1,023 MB');
  assert.equal(formatBytes(GB), '1.0 GB');
  assert.equal(formatBytes(4.1 * GB), '4.1 GB');
});
