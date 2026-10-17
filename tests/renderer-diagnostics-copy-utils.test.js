'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createLogRenderer } = require('../renderer/shell/renderer-diagnostics-render-utils');
const { buildTraceTimingMarkup } = require('../renderer/shell/renderer-observability-markup-utils');

function paintInventory(t, render = createLogRenderer) {
  const dom = new JSDOM(['diagnosticsRuntimeInventory', 'diagnosticsOverall'].map((id) => `<div id="${id}"></div>`).join(''));
  const previous = { document: global.document, window: global.window };
  Object.assign(global, { document: dom.window.document, window: dom.window });
  let paint;
  dom.window.requestAnimationFrame = (callback) => { paint = callback; return 1; };
  const state = {
    ui: { activeView: 'logs', logs: { activeTab: 'overview' } }, logs: [],
    diagnosticsStatus: { backend: { phase: 'ready' } },
    diagnosticsSnapshot: { active_run: { run_id: 'current', sources: {
      electron: { state: 'observed', count: 1, dropped: 2 },
      renderer: { state: 'observed', count: 1 }, sidecar: { state: 'observed', count: 1 },
    }, integrity: { complete: true } } },
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

test('Runtime facts use product wording, keep technical identifiers in titles and have no shell or plugin rows', (t) => {
  const host = paintInventory(t);
  assert.doesNotMatch(host.textContent, /Companion|Planner/);
  assert.equal(valueFor(host, 'Shell'), undefined, 'the shell row restated settings and is gone');
  assert.equal(valueFor(host, 'App').title, 'electron');
  assert.equal(valueFor(host, 'Local engine').title, 'sidecar');
  for (const label of ['Plugins', 'Recovery', 'Distribution']) assert.equal(valueFor(host, label), undefined);
});

test('Overview status line, runtime facts and record counts use translation keys', (t) => {
  // Every module that captures the translator at load time is loaded again under the stub.
  const paths = ['../renderer/shell/renderer-diagnostics-render-utils',
    '../renderer/shell/renderer-diagnostics-overview', '../renderer/shell/renderer-diagnostics-runtime-facts',
    '../renderer/shell/renderer-diagnostics-activity', '../renderer/shell/renderer-diagnostics-format',
    '../renderer/shell/renderer-diagnostics-performance-utils'].map(require.resolve);
  const cached = paths.map((path) => require.cache[path]);
  const previous = global.jennyI18n;
  const translations = {
    'diagnostics.inventory.workspace': 'Espace',
    'diagnostics.facts.recordsThisLaunch': 'Enregistrements de ce lancement',
    'diagnostics.source.droppedCount': '{count} perdus',
    'diagnostics.status.working': 'Jenny fonctionne',
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
  assert.equal(doc.querySelectorAll('.diagnostics-group h4')[2].textContent, 'Enregistrements de ce lancement');
  assert.match(valueFor(host, 'App').textContent, /2 perdus/);
  assert.equal(doc.querySelector('#diagnosticsOverall h3').textContent, 'Jenny fonctionne');
});

test('trace timing preserves explicit null durations as unavailable while real zero stays zero', (t) => {
  const dom = new JSDOM(buildTraceTimingMarkup({ available: true, recent: [
    { stream_id: 'unknown', duration_ms: null, provider_timing: {
      time_to_first_chunk_ms: null, time_to_first_visible_token_ms: null, request_duration_ms: null,
    } },
    { stream_id: 'zero', duration_ms: 0, provider_timing: { time_to_first_visible_token_ms: 0 } },
  ] }));
  t.after(() => dom.window.close());
  const rows = new Map(Array.from(dom.window.document.querySelectorAll('tbody tr'))
    .map((row) => [row.querySelector('[data-observability-trace]').getAttribute('data-observability-trace'), row]));
  const durations = (id) => Array.from(rows.get(id).cells).slice(2, 4).map((cell) => cell.textContent);
  assert.deepEqual(durations('unknown'), ['\u2014', '\u2014']);
  assert.doesNotMatch(rows.get('unknown').textContent, /\b0 ?ms\b/);
  assert.deepEqual(durations('zero'), ['0 ms', '0 ms']);
});
