'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const MODULES = [
  '../renderer/shell/renderer-diagnostics-format',
  '../renderer/shell/renderer-phase-percentiles-utils',
  '../renderer/shell/renderer-observability-markup-utils',
  '../renderer/shell/renderer-diagnostics-performance-utils',
].map((path) => require.resolve(path));
const page = require('../renderer/shell/renderer-diagnostics-page');

// The Performance section's markup, as index.html lays it out.
const SECTION_HTML = '<section class="diagnostics-performance">'
  + '<div id="diagnosticsResetControl"><button type="button" id="phasePercentilesResetButton">Reset timings</button></div>'
  + '<div id="diagnosticsPerformanceEmpty" hidden></div>'
  + '<div id="diagnosticsPerformanceGroups">'
  + '<section id="diagnosticsChatTiming"><h4 id="diagnosticsChatTimingHeading">Chat timing</h4><div id="phasePercentilesTable"></div></section>'
  + '<section id="diagnosticsOverTarget" hidden><h4>Over target</h4><div id="slowOperationsList"></div></section>'
  + '<section id="diagnosticsTools"><h4>Tools</h4><div id="toolLatencyTable"></div></section>'
  + '<section id="diagnosticsRecentChats"><h4>Recent chats</h4><div id="recentTracesList"></div></section>'
  + '</div></section>';

// Loads the renderer modules fresh so a stub locale is in place when they capture their translator.
function loadSection(t, { translate } = {}) {
  const previousI18n = globalThis.jennyI18n;
  const dom = new JSDOM(SECTION_HTML);
  if (translate) {
    globalThis.jennyI18n = {
      t: (key, fallback, params) => translate(String(fallback).replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? params[name] : match))),
      tn: (key, count, params, one, other) => translate(String(count === 1 ? one : other).replace(/\{(\w+)\}/g, (match, name) => (params && name in params ? params[name] : match))),
    };
  }
  MODULES.forEach((path) => { delete require.cache[path]; });
  const section = require('../renderer/shell/renderer-diagnostics-performance-utils');
  t.after(() => {
    if (previousI18n === undefined) delete globalThis.jennyI18n; else globalThis.jennyI18n = previousI18n;
    MODULES.forEach((path) => { delete require.cache[path]; });
    dom.window.close();
  });
  const doc = dom.window.document;
  return {
    doc,
    text: (id) => doc.getElementById(id).textContent.replace(/\s+/g, ' ').trim(),
    render(state, backend = { phase: 'ready' }, extra = {}) {
      section.renderPerformanceSection(state, { backend, paintMarkup: page.paintMarkup, document: doc, ...extra });
    },
  };
}

const PHASES = {
  phases: {
    provider_request_start_to_first_chunk: { count: 12, p50: 100, p95: 300, p99: 900 },
    first_chunk_to_first_visible_token: { count: 12, p50: 25, p95: 100, p99: 120 },
    completion_to_terminal_persist: { count: 11, p50: 400, p95: 1500, p99: 1600 },
  },
  targets: {
    provider_request_start_to_first_chunk: { p50: 150, p95: 400 },
    first_chunk_to_first_visible_token: { p50: 20, p95: 100 },
    completion_to_terminal_persist: { p50: 100, p95: 300 },
  },
};

const TOOLS = { available: true, tools: { read_file: { count: 3, error_count: 0, error_rate: 0, latency_ms: { p50: 10, p95: 20, p99: 30 }, error_codes: {} } } };
const SLOW = { available: true, count: 1, items: [{ kind: 'tool', id: 'read_file', metric: 'p95', observed_ms: 2400, threshold_ms: 1000, count: 3 }] };
const TRACES = { available: true, count: 1, recent: [{ stream_id: 's1', terminal_status: 'completed', duration_ms: 900, model: 'qwen3', provider_timing: {}, tool_events: { total: 0 } }] };

function stateOf({ payload = null, error = '', loadedAt = payload ? 1 : 0, status = {} } = {}) {
  return { phasePercentiles: { payload, error, loading: false, loadedAt }, diagnosticsStatus: status };
}

function hiddenIds(view) {
  return ['diagnosticsPerformanceEmpty', 'diagnosticsPerformanceGroups', 'diagnosticsChatTiming', 'diagnosticsOverTarget',
    'diagnosticsTools', 'diagnosticsRecentChats', 'diagnosticsResetControl'].filter((id) => view.doc.getElementById(id).hidden);
}

test('before anything has loaded the section says it is checking, never that timings could not be loaded', (t) => {
  const view = loadSection(t);
  view.render(stateOf());
  const note = view.text('diagnosticsPerformanceEmpty');
  assert.equal(note, 'Checking…');
  assert.doesNotMatch(note, /could not be loaded|unavailable|measured/i);
  assert.equal(view.doc.querySelectorAll('#diagnosticsPerformanceEmpty .inv-empty-note').length, 1);
  assert.deepEqual(hiddenIds(view), ['diagnosticsPerformanceGroups', 'diagnosticsChatTiming', 'diagnosticsOverTarget',
    'diagnosticsTools', 'diagnosticsRecentChats', 'diagnosticsResetControl']);
});

test('sources that report themselves unavailable say timings could not be loaded, not that nothing was measured', (t) => {
  const view = loadSection(t);
  const off = { available: false };
  view.render(stateOf({ status: { tool_observability: off, slow_operations: off, trace_timing: off } }));
  assert.equal(view.text('diagnosticsPerformanceEmpty'), 'Timings could not be loaded.');
});

test('a previous launch says timings cover the current launch only, with no tables and no Reset', (t) => {
  const view = loadSection(t);
  view.render(stateOf({ payload: PHASES, status: { tool_observability: TOOLS, slow_operations: SLOW, trace_timing: TRACES } }),
    { phase: 'ready' }, { prior: true });
  assert.equal(view.text('diagnosticsPerformanceEmpty'), 'Timings cover the current launch only.');
  const hidden = hiddenIds(view);
  assert.ok(hidden.includes('diagnosticsPerformanceGroups') && hidden.includes('diagnosticsResetControl'), hidden.join());
});

test('nothing measured after loading is one sentence with the next step for the engine state', (t) => {
  const view = loadSection(t);
  const loaded = stateOf({ payload: { phases: {}, targets: {} }, status: {
    tool_observability: { available: true, tools: {} }, slow_operations: { available: true, items: [] }, trace_timing: { available: true, recent: [] },
  } });
  view.render(loaded, { phase: 'ready' });
  assert.equal(view.text('diagnosticsPerformanceEmpty'), 'No chats measured in this launch yet. Send a chat and its timings appear here.');
  assert.equal(view.doc.getElementById('diagnosticsPerformanceEmpty').hidden, false);
  assert.equal(view.doc.getElementById('diagnosticsResetControl').hidden, true, 'nothing to reset');
  assert.equal(view.doc.getElementById('diagnosticsPerformanceGroups').hidden, true);
  view.render(loaded, { phase: 'model_loading' });
  assert.equal(view.text('diagnosticsPerformanceEmpty'), 'No chats measured in this launch yet. Timings start once the engine is ready.');
});

test('only groups with rows show, and the count sits in the Chat timing heading', (t) => {
  const view = loadSection(t);
  view.render(stateOf({ payload: PHASES, status: { tool_observability: TOOLS, slow_operations: SLOW, trace_timing: { available: true, recent: [] } } }));
  assert.deepEqual(hiddenIds(view), ['diagnosticsPerformanceEmpty', 'diagnosticsRecentChats']);
  assert.equal(view.doc.querySelector('#diagnosticsChatTimingHeading .diagnostics-group-count').textContent, '12 chats · 3 of 9 steps measured');
  assert.equal(view.doc.querySelectorAll('#phasePercentilesTable tbody tr').length, 3, 'unmeasured steps are not rows');
  assert.equal(view.doc.querySelector('#phasePercentilesTable').textContent.includes('Context assembly'), false);
  view.render(stateOf({ payload: PHASES, status: { tool_observability: TOOLS, trace_timing: TRACES } }));
  assert.deepEqual(hiddenIds(view), ['diagnosticsPerformanceEmpty', 'diagnosticsOverTarget']);
  assert.equal(view.doc.querySelectorAll('#diagnosticsChatTimingHeading .diagnostics-group-count').length, 1, 'repaint never stacks counts');
});

test('a single measured chat reads in the singular', (t) => {
  const view = loadSection(t);
  view.render(stateOf({ payload: { phases: { provider_request_start_to_first_chunk: { count: 1, p50: 1, p95: 1, p99: 1 } }, targets: {} } }));
  assert.match(view.doc.querySelector('.diagnostics-group-count').textContent, /^1 chat · 1 of 9 steps measured$/);
});

test('Reset timings is offered only while there are phase timings to reset', (t) => {
  const view = loadSection(t);
  view.render(stateOf({ payload: PHASES }));
  assert.equal(view.doc.getElementById('diagnosticsResetControl').hidden, false);
  view.render(stateOf({ payload: { phases: {}, targets: {} }, status: { tool_observability: TOOLS } }));
  assert.equal(view.doc.getElementById('diagnosticsResetControl').hidden, true);
  assert.equal(view.doc.getElementById('diagnosticsTools').hidden, false, 'tool rows still show');
});

test('a cleared phase payload is not brought back by the stale status facet', (t) => {
  const view = loadSection(t);
  const stale = { phase_percentiles: { available: true, ...PHASES }, tool_observability: { available: true, tools: {} } };
  view.render(stateOf({ payload: null, status: stale }));
  assert.equal(view.doc.querySelectorAll('#phasePercentilesTable tbody tr').length, 3, 'before the dedicated payload ever loads the facet stands in');
  view.render(stateOf({ payload: { phases: {}, targets: {} }, loadedAt: 5, status: stale }));
  assert.equal(view.doc.querySelectorAll('#phasePercentilesTable tbody tr').length, 0);
  assert.equal(view.doc.getElementById('diagnosticsChatTiming').hidden, true);
});

test('verdicts come from the measured value: on target is quiet, near limit and over target carry an icon', (t) => {
  const view = loadSection(t);
  view.render(stateOf({ payload: PHASES }));
  const rows = new Map(Array.from(view.doc.querySelectorAll('#phasePercentilesTable tbody tr')).map((row) => [row.cells[0].textContent, row]));
  const nearLimit = rows.get('First chunk to first visible token').querySelector('[data-verdict]');
  assert.equal(nearLimit.dataset.verdict, 'warn');
  assert.ok(nearLimit.querySelector('svg.inv-state-icon--warn'));
  const overTarget = rows.get('Completion to terminal persist').querySelector('[data-verdict]');
  assert.equal(overTarget.dataset.verdict, 'fail');
  assert.ok(overTarget.querySelector('svg.inv-state-icon--error'));
  const onTarget = rows.get('Provider start to first chunk').querySelector('[data-verdict]');
  assert.equal(onTarget.dataset.verdict, 'pass');
  assert.equal(onTarget.querySelector('svg'), null, 'on target carries no icon');
});

test('the verdict tone survives a translated interface because it never reads the words', (t) => {
  const view = loadSection(t, { translate: (text) => '«' + text + '»' });
  view.render(stateOf({ payload: PHASES }));
  const verdicts = Array.from(view.doc.querySelectorAll('#phasePercentilesTable [data-verdict]')).map((node) => [node.dataset.verdict, node.textContent]);
  assert.deepEqual(verdicts.map((pair) => pair[0]).sort(), ['fail', 'pass', 'warn']);
  verdicts.forEach((pair) => assert.match(pair[1], /^«.+»$/, 'the word itself is translated'));
  assert.ok(view.doc.querySelector('[data-verdict="fail"] svg.inv-state-icon--error'));
  assert.ok(view.doc.querySelector('[data-verdict="warn"] svg.inv-state-icon--warn'));
  assert.match(view.doc.querySelector('#phasePercentilesTable th').textContent, /^«Step»$/);
  assert.match(view.doc.querySelector('#phasePercentilesTable tbody td').textContent, /^«.+»$/, 'step labels are translatable');
});

test('unknown durations read as an em dash, never 0 or TBD', (t) => {
  const view = loadSection(t);
  view.render(stateOf({ payload: { phases: { provider_request_start_to_first_chunk: { count: 2, p50: null, p95: 'oops', p99: undefined } },
    targets: { provider_request_start_to_first_chunk: { p50: 150, p95: null } } } }));
  const row = view.doc.querySelector('#phasePercentilesTable tbody tr');
  assert.deepEqual(Array.from(row.cells).slice(1, 4).map((cell) => cell.textContent), ['—', '—', '—']);
  assert.equal(row.cells[4].textContent, '150 ms / —');
  assert.doesNotMatch(row.textContent, /TBD|\b0 ?ms\b/);
  assert.equal(row.cells[5].textContent, '', 'a step with no usable target has no verdict');
});

test('column titles carry the percentile names and the low-value columns can fold away', (t) => {
  const view = loadSection(t);
  view.render(stateOf({ payload: PHASES }));
  const headers = Array.from(view.doc.querySelectorAll('#phasePercentilesTable th'));
  assert.deepEqual(headers.map((th) => th.getAttribute('title')), [null, 'P50', 'P95', 'P99', 'P50 / P95', null]);
  assert.deepEqual(headers.slice(0, 5).map((th) => th.textContent), ['Step', 'Typical', 'Slow', 'Slowest', 'Target']);
  assert.deepEqual(headers.map((th) => th.classList.contains('diagnostics-col-wide')), [false, false, false, true, true, false]);
});

test('a failed refresh stays visible: over data it is a note above the groups, without data it replaces the empty sentence', (t) => {
  const view = loadSection(t);
  view.render(stateOf({ payload: PHASES, error: 'reset failed' }));
  assert.equal(view.doc.getElementById('diagnosticsPerformanceEmpty').hidden, false);
  assert.equal(view.text('diagnosticsPerformanceEmpty'), 'Timings could not be refreshed. reset failed');
  assert.equal(view.doc.getElementById('diagnosticsPerformanceGroups').hidden, false);
  view.render(stateOf({ payload: { phases: {}, targets: {} }, error: 'bridge down' }));
  assert.equal(view.text('diagnosticsPerformanceEmpty'), 'Timings could not be loaded. bridge down');
  assert.equal(view.doc.getElementById('diagnosticsPerformanceGroups').hidden, true);
  view.render(stateOf({ payload: PHASES }));
  assert.equal(view.doc.getElementById('diagnosticsPerformanceEmpty').hidden, true, 'the note clears with the error');
});

test('repainting identical state leaves the timing table nodes alone', (t) => {
  const view = loadSection(t);
  const state = stateOf({ payload: PHASES });
  view.render(state);
  const table = view.doc.querySelector('#phasePercentilesTable table');
  view.render(state);
  assert.equal(view.doc.querySelector('#phasePercentilesTable table'), table);
});
