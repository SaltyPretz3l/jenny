'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createLogRenderer } = require('../renderer/shell/renderer-diagnostics-render-utils');
const { buildTraceTimingMarkup } = require('../renderer/shell/renderer-observability-markup-utils');

function paintInventory(t, render = createLogRenderer) {
  const dom = new JSDOM(['diagnosticsRuntimeInventory', 'diagnosticsOverall', 'diagnosticsSourceCoverage',
    'performanceAnomaliesContainer'].map((id) => `<div id="${id}"></div>`).join(''));
  const previous = { document: global.document, window: global.window };
  Object.assign(global, { document: dom.window.document, window: dom.window });
  let paint;
  dom.window.requestAnimationFrame = (callback) => { paint = callback; return 1; };
  const state = {
    ui: { activeView: 'logs', logs: { activeTab: 'overview' } }, logs: [],
    diagnosticsStatus: { backend: { phase: 'ready' }, slow_operations: { available: true, items: [
      { id: 'read_file', observed_ms: 20, threshold_ms: 10 },
    ] } },
    diagnosticsSnapshot: { active_run: { run_id: 'current' }, sources: {
      electron: { state: 'observed', count: 1, dropped: 2 },
      renderer: { state: 'observed', count: 1 }, sidecar: { state: 'observed', count: 1 },
    }, integrity: { complete: true } },
    harness: { snapshot: { shell: { companion: { mode: 'planner' } } } },
  };
  const renderer = render({ state });
  t.after(() => { renderer.dispose(); dom.window.close(); Object.assign(global, previous); });
  renderer.renderLogs();
  paint();
  return dom.window.document.getElementById('diagnosticsRuntimeInventory');
}

function valueFor(host, label) {
  return Array.from(host.querySelectorAll('dt')).find((node) => node.textContent === label)?.nextElementSibling;
}

test('Inventory uses product wording, retains technical identifiers in titles and has no plugin rows', (t) => {
  const host = paintInventory(t);
  assert.doesNotMatch(host.textContent, /Companion/);
  assert.equal(valueFor(host, 'Shell').textContent, 'Planner');
  assert.match(valueFor(host, 'Shell').title, /planner/);
  for (const label of ['Plugins', 'Recovery', 'Distribution']) assert.equal(valueFor(host, label), undefined);
});

test('Overview inventory, source counts, and performance copy use translation keys', (t) => {
  const paths = ['../renderer/shell/renderer-diagnostics-render-utils',
    '../renderer/shell/renderer-diagnostics-performance-utils'].map(require.resolve);
  const cached = paths.map((path) => require.cache[path]);
  const previous = global.jennyI18n;
  const translations = {
    'diagnostics.inventory.workspace': 'Espace',
    'diagnostics.source.events': 'Evenements',
    'diagnostics.source.droppedCount': '{count} perdus',
    'diagnostics.performance.observedAndTarget': '{observed} mesure / {target} cible',
  };
  global.jennyI18n = { t: (key, fallback, params = {}) => (translations[key] || fallback)
    .replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match) };
  paths.forEach((path) => { delete require.cache[path]; });
  t.after(() => {
    paths.forEach((path, index) => { require.cache[path] = cached[index]; });
    global.jennyI18n = previous;
  });
  const localized = require(paths[0]);
  const host = paintInventory(t, localized.createLogRenderer);
  assert.ok(valueFor(host, 'Espace'));
  const doc = host.ownerDocument;
  assert.match(doc.getElementById('diagnosticsSourceCoverage').textContent, /Evenements/);
  assert.match(doc.querySelector('.diagnostics-source-drop').textContent, /2 perdus/);
  assert.match(doc.getElementById('performanceAnomaliesContainer').textContent, /20ms mesure \/ 10ms cible/);
});

test('trace timing preserves explicit null durations as unavailable while real zero stays zero', (t) => {
  const dom = new JSDOM(buildTraceTimingMarkup({ available: true, recent: [
    { stream_id: 'unknown', duration_ms: null, provider_timing: {
      time_to_first_chunk_ms: null, time_to_first_visible_token_ms: null, request_duration_ms: null,
    } },
    { stream_id: 'zero', duration_ms: 0, provider_timing: { time_to_first_chunk_ms: 0 } },
  ] }, new Set(['unknown'])));
  t.after(() => dom.window.close());
  const unknown = dom.window.document.querySelector('[data-trace-stream="unknown"]');
  assert.equal(unknown.querySelector('.observability-trace-duration').textContent, '\u2014');
  assert.doesNotMatch(unknown.textContent, /\b0ms\b/);
  assert.match(unknown.querySelector('.observability-trace-meta').textContent, /\u2014/);
  const total = Array.from(unknown.querySelectorAll('.observability-trace-detail-row'))
    .find((row) => row.firstElementChild.textContent === 'Total request');
  assert.equal(total.lastElementChild.textContent, '\u2014');
  assert.equal(dom.window.document.querySelector('[data-trace-stream="zero"] .observability-trace-duration').textContent, '0ms');
});
