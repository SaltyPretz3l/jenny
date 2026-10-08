'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { budgetDisplayRows, formatBytes } = require('../renderer/shell/renderer-diagnostics-performance-utils');
const MB = 1024 * 1024;
const GB = 1024 * MB;

test('resource rows precede Usage, token, cost and tool rows in order', () => {
  const rows = budgetDisplayRows({
    available: true, inputs: { usage: true },
    resources: {
      app_memory_bytes: 412 * MB,
      model_memory: { ram_bytes: 4.1 * GB, vram_bytes: 2 * GB, vram_total_bytes: 8 * GB,
        models: [{ name: 'alpha', size_bytes: 4.1 * GB }, { name: 'beta', size_bytes: null }] },
      workers: { active: 2, max: 4 },
      retained_caches: { bytes: 184 * MB, items: [{ name: 'Prompt cache' }, { name: 'File index' }] },
      system_memory: { percent: 91, pressure: 'high' },
    },
    usage: { session_total_tokens: 21, cumulative_total_tokens: 44, session_provider_cost_usd: 0.21, cumulative_provider_cost_usd: 0.44 },
    items: [{ kind: 'tool_pressure', id: 'read_file', error_count: 2, slow_count: 3 },
      { kind: 'tool_pressure', id: 'web_fetch', error_count: 0, slow_count: 1 },
      { kind: 'resource_pressure', status: 'high' }, { kind: 'slow_operations', count: 5 }],
  });
  assert.deepEqual(rows.map((row) => row.label), ['App memory', 'Model memory', 'Workers', 'Retained caches',
    'System memory pressure', 'Usage', 'Session tokens', 'Cumulative tokens', 'Session provider cost', 'Cumulative provider cost', 'read_file', 'web_fetch']);
  assert.equal(rows[0].sub, "Jenny's own windows and helpers");
  assert.equal(rows[0].value, '412 MB');
  assert.equal(rows[1].sub, '2 models loaded');
  assert.equal(rows[1].subTitle, 'alpha \u00b7 4.1 GB\nbeta \u00b7 Not measured on this build');
  assert.equal(rows[1].value, '4.1 GB RAM \u00b7 2.0 GB VRAM');
  assert.equal(rows[1].valueSmall, 'of 8.0 GB');
  assert.equal(rows[2].value, '2');
  assert.equal(rows[2].valueSmall, 'of 4');
  assert.equal(rows[3].sub, 'Prompt cache \u00b7 File index');
  assert.equal(rows[4].sub, '91% of system RAM in use');
  assert.equal(rows[4].value, 'High');
  assert.equal(rows[4].tone, 'warn');
  assert.deepEqual(rows[5], { group: 'usage', label: 'Usage' });
  assert.equal(rows[10].value, '2 errors \u00b7 3 slow');
  assert.equal(rows[10].tone, 'error');
  assert.equal(rows[11].tone, '');
});

test('missing resource measurements retain unavailable rows', () => {
  assert.deepEqual(budgetDisplayRows({ available: false }), []);
  const rows = budgetDisplayRows({ available: true });
  assert.equal(rows.length, 5, 'no Usage heading when nothing follows it');
  for (const row of rows.slice(0, 5)) {
    assert.equal(row.state, 'unavailable');
    assert.equal(row.value, 'Not measured on this build');
  }
});

test('real zeros are measured and null VRAM and totals are omitted', () => {
  const rows = budgetDisplayRows({ available: true, resources: {
    app_memory_bytes: 0,
    model_memory: { ram_bytes: 0, vram_bytes: null, vram_total_bytes: null, models: [{ name: 'empty', size_bytes: 0 }] },
    workers: { active: 0, max: 0 }, retained_caches: { bytes: 0, items: [] },
    system_memory: { percent: 0, pressure: 'normal' },
  } });
  assert.equal(rows[0].value, '0 MB');
  assert.equal(rows[1].value, '0 MB RAM');
  assert.equal(rows[1].sub, '1 model loaded');
  assert.equal(rows[1].valueSmall, '');
  assert.equal(rows[2].value, '0');
  assert.equal(rows[2].valueSmall, 'of 0');
  assert.equal(rows[3].value, '0 MB');
  assert.equal(rows[4].value, 'Normal');
  assert.equal(rows[4].tone, '');
  for (const row of rows.slice(0, 5)) assert.equal(row.state, '');
});

test('cache sublabels are bounded and critical and unknown pressure keep their meaning', () => {
  const rows = budgetDisplayRows({ available: true, resources: {
    retained_caches: { bytes: 1, items: [{ name: 'a'.repeat(70) }] },
    system_memory: { percent: 95, pressure: 'critical' },
  } });
  assert.equal(rows[3].sub, 'a'.repeat(59) + '…');
  assert.equal(rows[3].sub.length, 60);
  const short = budgetDisplayRows({ available: true, resources: {
    retained_caches: { bytes: 1, items: [{ name: 'kv' }, { name: 'prefix' }] },
  } })[3];
  assert.equal(short.sub, 'kv · prefix');
  const exact = budgetDisplayRows({ available: true, resources: {
    retained_caches: { bytes: 1, items: [{ name: 'a'.repeat(60) }] },
  } })[3];
  assert.equal(exact.sub, 'a'.repeat(60));
  const empty = budgetDisplayRows({ available: true, resources: {
    retained_caches: { bytes: 1, items: [] },
  } })[3];
  assert.equal(empty.sub, '');
  assert.equal(rows[4].value, 'Critical');
  assert.equal(rows[4].tone, 'error');
  const unknown = budgetDisplayRows({ available: true, resources: { system_memory: { percent: 62, pressure: null } } })[4];
  assert.equal(unknown.sub, '62% of system RAM in use');
  assert.equal(unknown.state, 'unavailable');
});

test('formatBytes preserves unknowns and the MB to GB boundary', () => {
  for (const value of [null, undefined, NaN, Infinity, '0']) assert.equal(formatBytes(value), null);
  assert.equal(formatBytes(0), '0 MB');
  assert.equal(formatBytes(1023 * MB), '1,023 MB');
  assert.equal(formatBytes(GB), '1.0 GB');
  assert.equal(formatBytes(4.1 * GB), '4.1 GB');
});
