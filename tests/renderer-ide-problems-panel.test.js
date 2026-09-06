'use strict';

/* Tier-2 Problems / diagnostics panel: marker view-model (grouping/sorting),
 * severity counts, click-to-reveal, the live onMarkersChanged refresh, and the
 * controller wiring (renderIde branch + empty state). The standalone-DOM cases
 * drive the panel factory directly with a fake editor host that hands back the
 * path-centric view-models the host emits (the jenny-workspace URI->path mapping
 * itself is covered in renderer-ide-editor-host-markers.test.js); the last case
 * uses the full jsdom harness to prove the controller constructs + renders it. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeProblemsPanel } = require('../renderer/features/renderer-ide-problems-panel');
const actionButton = require('../renderer/inventory/action-button');
const { createHarness, settle } = require('./helpers/renderer-ide-harness');

// Stands in for the editor host's diagnostics surface: getMarkers returns the
// path-centric view-models the host would emit, onMarkersChanged captures the
// callback so a test can fire it. state.markers is mutable.
function fakeEditorHost(state) {
  return {
    getMarkers: () => state.markers,
    onMarkersChanged: (cb) => {
      state.cb = cb;
      return { dispose() { state.disposed = true; } };
    },
  };
}

// Monaco MarkerSeverity codes -> the host's bucket strings, so call sites can
// keep expressing severity in the familiar 8/4/2/1 enum values.
const SEVERITY_NAME = { 8: 'error', 4: 'warning', 2: 'info', 1: 'hint' };

function marker(path, severity, line, message, extra) {
  return Object.assign({
    path,
    severity: SEVERITY_NAME[severity] || 'info',
    message,
    line,
    column: 1,
    source: 'ts',
    code: '',
  }, extra || {});
}

function setup(markers, opts = {}) {
  // The panel was re-homed from the rail into the bottom panel's shared content
  // host (#ideBottomPanelContent), gated on bottomPanelOpen + activeView.
  const dom = new JSDOM('<!doctype html><body><div id="ideBottomPanelContent"></div></body>');
  const panelEl = dom.window.document.getElementById('ideBottomPanelContent');
  const ide = {
    bottomPanelOpen: opts.open !== false,
    bottomPanelActiveView: opts.activeView || 'problems',
  };
  const calls = { reveal: [], render: 0 };
  const state = { markers: markers || [] };
  const panel = createIdeProblemsPanel({
    getDom: () => ({ ideBottomPanelContent: panelEl }),
    getIde: () => ide,
    getMountEl: () => panelEl,
    isActivePanel: () => ide.bottomPanelOpen && ide.bottomPanelActiveView === 'problems',
    actionButton,
    // markers === undefined simulates a host with no diagnostics surface (the
    // textarea fallback / pre-boot) - the panel must degrade to the empty state.
    editorHost: markers === undefined ? {} : fakeEditorHost(state),
    // Mirrors the controller: renderIde re-renders the active view (renderPanel
    // internally guards on isActivePanel).
    requestRender: () => {
      calls.render += 1;
      panel.renderPanel();
    },
    onReveal: (path, line, column) => calls.reveal.push({ path, line, column }),
  });
  panel.bindEvents();
  // The controller renders the active view once after activate; mirror that so
  // the standalone cases have an initial paint to assert against.
  panel.renderPanel();
  return { dom, panelEl, panel, calls, ide, state };
}

test('empty state renders when there are no markers', () => {
  const { panelEl } = setup([]);
  assert.ok(panelEl.querySelector('.ide-prb-empty'), 'empty notice rendered');
  assert.match(panelEl.textContent, /No problems detected in open files/);
  assert.equal(panelEl.querySelector('.ide-prb-group'), null, 'no file groups');
});

test('groups markers by file, sorts rows by location, shows a severity summary', () => {
  const { panelEl } = setup([
    marker('src/app.js', 8, 12, 'Cannot find name foo', { code: '2304' }),
    marker('src/app.js', 4, 3, 'Unused variable bar'),
    marker('lib/util.css', 2, 1, 'Unknown property'),
  ]);

  // Summary chips: one error, one warning, one info.
  assert.equal(panelEl.querySelector('.ide-prb-chip[data-diag-severity="error"] .ide-prb-chip-count').textContent, '1');
  assert.equal(panelEl.querySelector('.ide-prb-chip[data-diag-severity="warning"] .ide-prb-chip-count').textContent, '1');
  assert.equal(panelEl.querySelector('.ide-prb-chip[data-diag-severity="info"] .ide-prb-chip-count').textContent, '1');

  // Two file groups; the error-bearing file sorts first (worst severity).
  const groups = [...panelEl.querySelectorAll('.ide-prb-group')];
  assert.equal(groups.length, 2);
  assert.equal(groups[0].querySelector('.ide-prb-file-name').textContent, 'app.js');
  assert.equal(groups[0].querySelector('.ide-prb-file-dir').textContent, 'src');
  assert.equal(groups[0].querySelector('.ide-prb-file-count').textContent, '2');

  // Within app.js the rows are sorted by line (warning @3 before error @12).
  const rows = [...groups[0].querySelectorAll('.ide-prb-row')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.idePrbLine, '3');
  assert.equal(rows[1].dataset.idePrbLine, '12');
  assert.match(rows[1].textContent, /Cannot find name foo/);
  assert.match(rows[1].textContent, /Ln 12, Col 1/);
  assert.match(rows[1].textContent, /ts\(2304\)/, 'source + code hint');
});

test('summary chips expose an accessible severity name, not just a bare count (WIDE-056b)', () => {
  const { panelEl } = setup([
    marker('src/app.js', 8, 12, 'Cannot find name foo'),
    marker('src/app.js', 8, 20, 'Cannot find name baz'),
    marker('src/app.js', 4, 3, 'Unused variable bar'),
  ]);

  const errorChip = panelEl.querySelector('.ide-prb-chip[data-diag-severity="error"]');
  const warningChip = panelEl.querySelector('.ide-prb-chip[data-diag-severity="warning"]');
  assert.match(errorChip.getAttribute('aria-label'), /2 errors/i, 'plural count + severity name announced');
  assert.match(warningChip.getAttribute('aria-label'), /1 warning\b/i, 'singular count + severity name announced');
  // The icon and bare count stay hidden from AT - the chip's aria-label is the
  // single source of truth for the accessible name.
  assert.equal(errorChip.querySelector('.ide-prb-chip-icon').getAttribute('aria-hidden'), 'true');
  assert.equal(errorChip.querySelector('.ide-prb-chip-count').getAttribute('aria-hidden'), 'true');
});

test('clicking a marker row reveals its path/line/column', () => {
  const { panelEl, calls } = setup([
    marker('src/app.js', 8, 12, 'Cannot find name foo', { column: 7 }),
  ]);
  const row = panelEl.querySelector('.ide-prb-row');
  row.click();
  assert.deepEqual(calls.reveal, [{ path: 'src/app.js', line: 12, column: 7 }]);
});

test('clicking a file header reveals the first problem in that file', () => {
  const { panelEl, calls } = setup([
    marker('src/app.js', 4, 9, 'warn'),
    marker('src/app.js', 8, 2, 'err'),
  ]);
  panelEl.querySelector('.ide-prb-file').click();
  // First problem after sort is the err @ line 2.
  assert.deepEqual(calls.reveal, [{ path: 'src/app.js', line: 2, column: 1 }]);
});

test('getCounts reports per-severity totals for the statusbar badge', () => {
  const { panel } = setup([
    marker('a.js', 8, 1, 'e1'),
    marker('a.js', 8, 2, 'e2'),
    marker('b.js', 4, 1, 'w1'),
    marker('b.js', 2, 1, 'i1'),
    marker('b.js', 1, 1, 'h1'),
  ]);
  assert.deepEqual(panel.getCounts(), { error: 2, warning: 1, info: 1, hint: 1, total: 5 });
});

test('does not render when the bottom panel shows a different view', () => {
  const { panelEl } = setup([marker('a.js', 8, 1, 'e')], { activeView: 'terminal' });
  assert.equal(panelEl.innerHTML, '', 'no render off-panel');
});

test('live onMarkersChanged refresh re-renders with the new marker set', () => {
  const { panelEl, panel, state } = setup([marker('a.js', 8, 1, 'e1')]);
  assert.equal(panel.getCounts().total, 1);
  state.markers = [marker('a.js', 8, 1, 'e1'), marker('a.js', 4, 5, 'w1')];
  state.cb(); // fire the host's onMarkersChanged fan-out
  assert.equal(panel.getCounts().total, 2);
  assert.equal([...panelEl.querySelectorAll('.ide-prb-row')].length, 2);
});

test('dispose detaches the markers subscription and the click listener', () => {
  const { panel, state, calls, panelEl } = setup([marker('a.js', 8, 1, 'e')]);
  panel.dispose();
  assert.equal(state.disposed, true, 'onMarkersChanged disposable released');
  panelEl.querySelector('.ide-prb-file')?.click();
  assert.equal(calls.reveal.length, 0, 'click no longer reveals after dispose');
});

test('without a diagnostics surface the panel degrades to the empty state', () => {
  const { panelEl, panel } = setup(undefined); // editorHost with no getMarkers
  panel.renderPanel();
  assert.ok(panelEl.querySelector('.ide-prb-empty'), 'empty state without markers');
  assert.deepEqual(panel.getCounts(), { error: 0, warning: 0, info: 0, hint: 0, total: 0 });
});

test('controller wires the Problems bottom-panel view and renders its empty state', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'README.md': 'r' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  harness.state.ui.ide.bottomPanelOpen = true;
  harness.state.ui.ide.bottomPanelActiveView = 'problems';
  harness.controller.renderIde();
  await settle();

  const panel = harness.getDom().ideBottomPanelContent;
  assert.ok(panel.querySelector('.ide-prb'), 'problems panel rendered into the shared bottom host');
  assert.ok(panel.querySelector('.ide-prb-empty'), 'empty state (no Monaco in jsdom)');
});
