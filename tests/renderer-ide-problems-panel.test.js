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
const { createFakeTimers } = require('./helpers/fake-timers');
const { JSDOM } = require('jsdom');

const { createIdeProblemsPanel } = require('../renderer/features/renderer-ide-problems-panel');
const actionButton = require('../renderer/inventory/action-button');
const textField = require('../renderer/inventory/text-field');
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
  // The panel mounts into its own workbench host (#wbView-problems), gated on
  // the view being visible (open + active in its stack).
  const dom = new JSDOM('<!doctype html><body><div id="wbView-problems"></div></body>');
  const panelEl = dom.window.document.getElementById('wbView-problems');
  const ide = {
    open: opts.open !== false,
    activeView: opts.activeView || 'problems',
    activeTabPath: opts.activeTabPath || '',
  };
  const calls = { reveal: [], render: 0 };
  const state = { markers: markers || [] };
  // Deterministic coalescing timer: flushTimers() runs whatever is pending.
  const timers = createFakeTimers();
  const flushTimers = timers.runPending;
  const panel = createIdeProblemsPanel({
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    getDom: () => ({}),
    getIde: () => ide,
    getMountEl: () => panelEl,
    isActivePanel: () => ide.open && ide.activeView === 'problems',
    actionButton,
    textField: opts.textField || textField,
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
    getTaskProblems: opts.taskProblems ? () => opts.taskProblems : undefined,
  });
  panel.bindEvents();
  // The controller renders the active view once after activate; mirror that so
  // the standalone cases have an initial paint to assert against.
  panel.renderPanel();
  return { dom, panelEl, panel, calls, ide, state, timers, flushTimers };
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

test('clicking a file header toggles its group instead of revealing', () => {
  const { panelEl, calls } = setup([
    marker('src/app.js', 4, 9, 'warn'),
    marker('src/app.js', 8, 2, 'err'),
  ]);
  panelEl.querySelector('.ide-prb-file').click();
  assert.deepEqual(calls.reveal, []);
  assert.equal(panelEl.querySelectorAll('.ide-prb-row').length, 0, 'group collapsed');
  assert.equal(panelEl.querySelector('.ide-prb-file').getAttribute('aria-expanded'), 'false');
  panelEl.querySelector('.ide-prb-file').click();
  assert.equal(panelEl.querySelectorAll('.ide-prb-row').length, 2, 'group expanded again');
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
  assert.equal(panel.getBadgeCount(), 3, 'the tab badge counts errors and warnings only');
});

test('getBadgeCount is zero without errors or warnings, so the Problems tab hides (F7)', () => {
  assert.equal(setup([]).panel.getBadgeCount(), 0);
  assert.equal(setup([marker('a.js', 2, 1, 'i1'), marker('a.js', 1, 1, 'h1')]).panel.getBadgeCount(), 0);
  assert.equal(setup([marker('a.js', 4, 1, 'w1')]).panel.getBadgeCount(), 1);
});

test('does not render when the bottom panel shows a different view', () => {
  const { panelEl } = setup([marker('a.js', 8, 1, 'e')], { activeView: 'terminal' });
  assert.equal(panelEl.innerHTML, '', 'no render off-panel');
});

test('live onMarkersChanged refresh re-renders with the new marker set', () => {
  const { panelEl, panel, state, flushTimers } = setup([marker('a.js', 8, 1, 'e1')]);
  assert.equal(panel.getCounts().total, 1);
  state.markers = [marker('a.js', 8, 1, 'e1'), marker('a.js', 4, 5, 'w1')];
  state.cb(); // fire the host's onMarkersChanged fan-out
  flushTimers(); // the coalescing window closes
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

test('controller hides the Problems view while there are no problems (F7)', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'README.md': 'r' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const doc = harness.dom.window.document;
  assert.equal(doc.querySelector('[data-wb-tab="problems"]'), null, 'no Problems tab without markers (no Monaco in jsdom)');
  assert.ok(doc.querySelector('[data-wb-tab="terminal"]'), 'its stack still shows the other bottom views');
  assert.equal(harness.viewHost('problems')?.isConnected === true, false, 'the host is parked, not shown');
});

test('hasMarkers counts every severity, so info and hints keep the Problems tab (F7)', () => {
  assert.equal(setup([]).panel.hasMarkers(), false);
  assert.equal(setup([marker('a.js', 2, 1, 'i1'), marker('a.js', 1, 1, 'h1')]).panel.hasMarkers(), true);
  assert.equal(setup([marker('a.js', 4, 1, 'w1')]).panel.hasMarkers(), true);
});

test('a burst of marker events coalesces into one cache drop and one render', () => {
  const { panel, state, calls, timers, flushTimers } = setup([marker('a.js', 8, 1, 'e1')]);
  const rendersBefore = calls.render;
  for (let i = 0; i < 20; i += 1) state.cb(); // e.g. the TS worker settling many files
  assert.equal(calls.render, rendersBefore, 'no render per event');
  assert.equal(timers.pending(), 1, 'one pending flush for the whole burst');
  state.markers = [marker('a.js', 8, 1, 'e1'), marker('b.js', 4, 2, 'w')];
  flushTimers();
  assert.equal(calls.render, rendersBefore + 1, 'exactly one render for the burst');
  assert.equal(panel.getCounts().total, 2, 'the flush dropped the cached model');
});

test('dispose cancels a pending coalesced refresh', () => {
  const { panel, state, calls, timers } = setup([marker('a.js', 8, 1, 'e1')]);
  const rendersBefore = calls.render;
  state.cb();
  panel.dispose();
  assert.equal(timers.pending(), 0, 'the pending flush was cleared');
  assert.equal(calls.render, rendersBefore);
});

/* ---- F8 / Shift+F8 marker walk (row 82) ----------------------------------- */

// Walk order below: a.js 1:5, a.js 10:1, a.js 20:3, b.js 2:1.
function walkPanel(markers, cursor, reveals) {
  return createIdeProblemsPanel({
    getIde: () => ({}),
    escapeHtml: (v) => String(v),
    editorHost: Object.assign(fakeEditorHost({ markers }), {
      getActivePath: () => cursor.path,
      getCursorInfo: () => ({ lineNumber: cursor.line, column: cursor.column }),
    }),
    onReveal: (path, line, column) => reveals.push(`${path}:${line}:${column}`),
  });
}

const WALK_MARKERS = [
  marker('b.js', 8, 2, 'e'),
  marker('a.js', 4, 10, 'w'),
  marker('a.js', 8, 20, 'e', { column: 3 }),
  marker('a.js', 1, 1, 'h', { column: 5 }),
];

test('nextProblem walks path, line, column order from the cursor and wraps', () => {
  const reveals = [];
  const cursor = { path: 'a.js', line: 10, column: 1 };
  const panel = walkPanel(WALK_MARKERS, cursor, reveals);
  panel.nextProblem(); // strictly after 10:1
  cursor.line = 20; cursor.column = 3;
  panel.nextProblem(); // crosses into b.js
  cursor.path = 'b.js'; cursor.line = 2; cursor.column = 1;
  panel.nextProblem(); // wraps to the very first
  assert.deepEqual(reveals, ['a.js:20:3', 'b.js:2:1', 'a.js:1:5']);
});

test('previousProblem walks backwards from the cursor and wraps to the last', () => {
  const reveals = [];
  const cursor = { path: 'a.js', line: 10, column: 1 };
  const panel = walkPanel(WALK_MARKERS, cursor, reveals);
  panel.previousProblem(); // strictly before 10:1
  cursor.line = 1; cursor.column = 5;
  panel.previousProblem(); // nothing earlier: wraps to b.js
  assert.deepEqual(reveals, ['a.js:1:5', 'b.js:2:1']);
});

test('the walk starts at the file top when the active file has no markers and no cursor', () => {
  const reveals = [];
  const panel = createIdeProblemsPanel({
    getIde: () => ({ activeTabPath: 'c.js' }),
    escapeHtml: (v) => String(v),
    editorHost: fakeEditorHost({ markers: WALK_MARKERS }),
    onReveal: (path, line, column) => reveals.push(`${path}:${line}:${column}`),
  });
  panel.nextProblem(); // c.js sorts after b.js, so the walk wraps to the first marker
  panel.previousProblem(); // and before it is b.js 2:1
  assert.deepEqual(reveals, ['a.js:1:5', 'b.js:2:1']);
});

test('nextProblem and previousProblem do nothing without markers', () => {
  const reveals = [];
  const panel = walkPanel([], { path: 'a.js', line: 1, column: 1 }, reveals);
  assert.equal(panel.nextProblem(), null);
  assert.equal(panel.previousProblem(), null);
  assert.deepEqual(reveals, []);
});

// --- Toolbar: filter, severity chips, Active file only, Collapse All, Enter ---

const TWO_FILES = () => [
  marker('src/a.js', 8, 1, 'boom is not defined', { source: 'ts', code: '2304' }),
  marker('lib/b.js', 4, 1, 'careful with this', { source: 'eslint' }),
];
const rowPaths = (panelEl) => [...panelEl.querySelectorAll('.ide-prb-row')].map((r) => r.dataset.idePrbPath);
const typeInto = (panelEl, value) => {
  const input = panelEl.querySelector('[data-ide-prb-filter]');
  input.value = value;
  input.dispatchEvent(new panelEl.ownerDocument.defaultView.Event('input', { bubbles: true }));
};

test('Warnings chip off hides warning rows and the chip reports aria-pressed', () => {
  const { panelEl } = setup(TWO_FILES());
  const chip = () => panelEl.querySelector('[data-ide-prb-severity="warning"]');
  assert.equal(chip().getAttribute('aria-pressed'), 'true');
  chip().click();
  assert.deepEqual(rowPaths(panelEl), ['src/a.js']);
  assert.equal(chip().getAttribute('aria-pressed'), 'false');
  assert.match(panelEl.querySelector('.ide-prb-filter-status').textContent, /Showing 1 of 2/);
});

test('text filter matches message, source, code and path, case-insensitively', () => {
  const { panelEl, flushTimers } = setup(TWO_FILES());
  const type = (value) => { typeInto(panelEl, value); flushTimers(); }; // the 150 ms filter debounce closes
  type('BOOM');
  assert.deepEqual(rowPaths(panelEl), ['src/a.js'], 'message');
  type('lib/');
  assert.deepEqual(rowPaths(panelEl), ['lib/b.js'], 'path');
  type('eslint');
  assert.deepEqual(rowPaths(panelEl), ['lib/b.js'], 'source');
  type('2304');
  assert.deepEqual(rowPaths(panelEl), ['src/a.js'], 'code');
});

test('Info chip covers hint markers', () => {
  const { panelEl } = setup([marker('a.js', 2, 1, 'note'), marker('a.js', 1, 2, 'tiny hint'), marker('a.js', 8, 3, 'err')]);
  assert.equal(panelEl.querySelector('[data-ide-prb-severity="info"] .ide-prb-chip-count').textContent, '2', 'info + hint');
  panelEl.querySelector('[data-ide-prb-severity="info"]').click();
  assert.equal(panelEl.querySelectorAll('.ide-prb-row').length, 1, 'info and hint both hidden');
  assert.match(panelEl.textContent, /Showing 1 of 3/);
});

test('Active file only shows the active editor file, and nothing without one', () => {
  const { panelEl, ide } = setup(TWO_FILES(), { activeTabPath: 'lib/b.js' });
  panelEl.querySelector('[data-ide-prb-active-only]').click();
  assert.deepEqual(rowPaths(panelEl), ['lib/b.js']);
  panelEl.querySelector('[data-ide-prb-active-only]').click();
  assert.equal(panelEl.querySelectorAll('.ide-prb-row').length, 2, 'toggles back off');
  ide.activeTabPath = '';
  panelEl.querySelector('[data-ide-prb-active-only]').click();
  assert.equal(panelEl.querySelectorAll('.ide-prb-row').length, 0);
  assert.match(panelEl.querySelector('.ide-prb-filter-status').textContent, /No problems match the current filters/);
});

test('Collapse All collapses every group, then switches to Expand All', () => {
  const { panelEl } = setup(TWO_FILES());
  const button = () => panelEl.querySelector('[data-ide-prb-action="collapse-all"]');
  assert.equal(button().title, 'Collapse All');
  button().click();
  assert.equal(panelEl.querySelectorAll('.ide-prb-row').length, 0);
  assert.equal(panelEl.querySelectorAll('.ide-prb-file').length, 2, 'headers stay');
  assert.equal(button().title, 'Expand All');
  button().click();
  assert.equal(panelEl.querySelectorAll('.ide-prb-row').length, 2);
  assert.equal(button().title, 'Collapse All');
});

test('collapsed state is pruned when a file loses its markers', () => {
  const { panelEl, state, flushTimers } = setup(TWO_FILES());
  panelEl.querySelector('[data-ide-prb-action="collapse-all"]').click();
  state.markers = [state.markers[0]];
  state.cb();
  flushTimers();
  state.markers = TWO_FILES(); // lib/b.js returns
  state.cb();
  flushTimers();
  assert.deepEqual(rowPaths(panelEl), ['lib/b.js'], 'b.js came back expanded, a.js stayed collapsed');
});

test('Clear filters resets text, chips and active-only', () => {
  const { panelEl, flushTimers } = setup(TWO_FILES());
  typeInto(panelEl, 'nothing-matches-this');
  flushTimers();
  panelEl.querySelector('[data-ide-prb-severity="error"]').click();
  panelEl.querySelector('[data-ide-prb-active-only]').click();
  assert.equal(panelEl.querySelectorAll('.ide-prb-row').length, 0);
  panelEl.querySelector('[data-ide-prb-action="clear-filters"]').click();
  assert.equal(panelEl.querySelectorAll('.ide-prb-row').length, 2);
  assert.equal(panelEl.querySelector('[data-ide-prb-filter]').value, '');
  assert.equal(panelEl.querySelector('[data-ide-prb-severity="error"]').getAttribute('aria-pressed'), 'true');
  assert.equal(panelEl.querySelector('[data-ide-prb-active-only]').getAttribute('aria-pressed'), 'false');
  assert.equal(panelEl.querySelector('.ide-prb-filter-status'), null);
});

test('the filter input keeps its node, value and focus across a markers-changed re-render', () => {
  const { panelEl, state, flushTimers } = setup(TWO_FILES());
  const input = panelEl.querySelector('[data-ide-prb-filter]');
  input.focus();
  typeInto(panelEl, 'boom');
  state.markers = [...TWO_FILES(), marker('src/a.js', 8, 9, 'boom again')];
  state.cb();
  flushTimers();
  assert.equal(panelEl.querySelector('[data-ide-prb-filter]'), input, 'same DOM node');
  assert.equal(input.value, 'boom');
  assert.equal(panelEl.ownerDocument.activeElement, input, 'focus kept');
  assert.equal(panelEl.querySelectorAll('.ide-prb-row').length, 2);
});

test('an input mid-composition is not filtered until compositionend', () => {
  const { panelEl, flushTimers } = setup(TWO_FILES());
  const win = panelEl.ownerDocument.defaultView;
  const input = panelEl.querySelector('[data-ide-prb-filter]');
  input.dispatchEvent(new win.Event('compositionstart', { bubbles: true }));
  typeInto(panelEl, 'boom');
  flushTimers();
  assert.equal(panelEl.querySelectorAll('.ide-prb-row').length, 2, 'no filtering mid-composition');
  input.dispatchEvent(new win.Event('compositionend', { bubbles: true }));
  flushTimers();
  assert.equal(panelEl.querySelectorAll('.ide-prb-row').length, 1);
  assert.equal(panelEl.querySelector('[data-ide-prb-filter]'), input);
});

test('Enter on a focused row opens its location; Enter on a header toggles it', () => {
  const { panelEl, calls } = setup([marker('src/app.js', 8, 12, 'Cannot find name foo', { column: 7 })]);
  const win = panelEl.ownerDocument.defaultView;
  const press = (el, key) => {
    const event = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
  };
  const rowEvent = press(panelEl.querySelector('.ide-prb-row'), 'Enter');
  assert.equal(rowEvent.defaultPrevented, true, 'native click suppressed so it fires once');
  assert.deepEqual(calls.reveal, [{ path: 'src/app.js', line: 12, column: 7 }]);
  press(panelEl.querySelector('.ide-prb-file'), 'Enter');
  assert.equal(panelEl.querySelectorAll('.ide-prb-row').length, 0, 'header Enter collapses');
  assert.equal(calls.reveal.length, 1);
});

test('ArrowDown/ArrowUp move focus between headers and rows', () => {
  const { panelEl } = setup([marker('a.js', 8, 1, 'e1'), marker('a.js', 4, 2, 'w1')]);
  const win = panelEl.ownerDocument.defaultView;
  const head = panelEl.querySelector('.ide-prb-file');
  head.focus();
  head.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  const first = panelEl.querySelector('.ide-prb-row');
  assert.equal(panelEl.ownerDocument.activeElement, first);
  first.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  assert.equal(panelEl.ownerDocument.activeElement, head);
});

test('filters never change the badge counts, hasMarkers or the summary chips', () => {
  const { panelEl, panel } = setup(TWO_FILES());
  panelEl.querySelector('[data-ide-prb-severity="warning"]').click();
  panelEl.querySelector('[data-ide-prb-severity="error"]').click();
  assert.equal(panelEl.querySelectorAll('.ide-prb-row').length, 0);
  assert.equal(panel.getBadgeCount(), 2);
  assert.equal(panel.hasMarkers(), true);
  assert.deepEqual(panel.getCounts(), { error: 1, warning: 1, info: 0, hint: 0, total: 2 });
  assert.equal(panelEl.querySelectorAll('.ide-prb-summary .ide-prb-chip').length, 2);
});

test('the toolbar is absent with no markers and no active filter', () => {
  const { panelEl } = setup([]);
  assert.equal(panelEl.querySelector('.ide-prb-toolbar'), null);
  assert.ok(panelEl.querySelector('.ide-prb-empty'));
});

test('a focused chip keeps focus after toggling', () => {
  const { panelEl } = setup(TWO_FILES());
  panelEl.querySelector('[data-ide-prb-severity="warning"]').focus();
  panelEl.querySelector('[data-ide-prb-severity="warning"]').click();
  assert.equal(panelEl.ownerDocument.activeElement, panelEl.querySelector('[data-ide-prb-severity="warning"]'));
});

test('R2: the Tasks source adds closed-file task problems beside the editor markers and refreshes on change', () => {
  const tasks = { markers: [marker('tests/test_a.py', 8, 12, 'AssertionError: assert 2 == 3', { source: 'pytest' })], cb: null };
  const taskProblems = {
    getMarkers: () => tasks.markers,
    onChange: (cb) => { tasks.cb = cb; return { dispose() { tasks.cb = null; } }; },
  };
  const { panelEl, panel, calls, flushTimers } = setup([marker('src/a.ts', 4, 2, 'Unused')], { taskProblems });
  assert.deepEqual(panel.getCounts(), { error: 1, warning: 1, info: 0, hint: 0, total: 2 });
  assert.equal(panel.hasMarkers(), true);
  const rows = [...panelEl.querySelectorAll('.ide-prb-row')];
  assert.equal(rows.length, 2);
  const taskRow = rows.find((row) => row.dataset.idePrbPath === 'tests/test_a.py');
  assert.ok(taskRow, 'the closed file is listed');
  assert.equal(taskRow.querySelector('.ide-prb-row-source').textContent, 'pytest');
  taskRow.click();
  assert.deepEqual(calls.reveal.pop(), { path: 'tests/test_a.py', line: 12, column: 1 });

  tasks.markers = [];
  assert.equal(typeof tasks.cb, 'function', 'the panel listens to the Tasks source');
  tasks.cb();
  flushTimers();
  assert.equal(panelEl.querySelectorAll('.ide-prb-row').length, 1, 'a cleared task run leaves the editor markers');
  panel.dispose();
  assert.equal(tasks.cb, null, 'dispose unsubscribes');
});

/* ---- Cleanup wave (row 82 deferred T4, T10, T14) --------------------------- */

test('T4: 3,000 markers render at most 1,000 rows with a "Showing the first" line', () => {
  const many = [];
  for (let file = 0; file < 30; file += 1) {
    for (let line = 1; line <= 100; line += 1) many.push(marker(`src/f${String(file).padStart(2, '0')}.js`, 8, line, `e${line}`));
  }
  const { panelEl, panel } = setup(many);
  assert.equal(panel.getCounts().total, 3000, 'the counts stay whole');
  assert.ok(panelEl.querySelectorAll('.ide-prb-row').length <= 1000, 'at most 1,000 rows in the DOM');
  assert.match(panelEl.querySelector('.ide-prb-filter-status').textContent, /Showing the first 1,?000 of 3,?000/);
});

test('T4: five quick keystrokes in the filter rebuild the panel once', () => {
  let builds = 0;
  const { panelEl, flushTimers } = setup(TWO_FILES(), { textField: (opts) => { builds += 1; return textField(opts); } });
  const before = builds;
  for (const value of ['b', 'bo', 'boo', 'boom', 'boom ']) typeInto(panelEl, value);
  assert.equal(builds, before, 'no rebuild per keystroke');
  flushTimers();
  assert.equal(builds, before + 1, 'one rebuild once the 150 ms window closes');
  assert.deepEqual(rowPaths(panelEl), ['src/a.js']);
});

test('T10: the empty-state hint names Run output beside the editor languages', () => {
  const { panelEl } = setup([]);
  assert.match(panelEl.querySelector('.ide-prb-empty-hint').textContent, /Run output/);
});

test('T14: F8 starts from the focused group\'s file and line, never a mix of two groups', () => {
  const reveals = [];
  const panel = createIdeProblemsPanel({
    getIde: () => ({ activeTabPath: 'a.js' }),
    escapeHtml: (v) => String(v),
    editorHost: Object.assign(fakeEditorHost({ markers: [marker('a.js', 8, 3, 'a3'), marker('b.js', 8, 2, 'b2'), marker('b.js', 8, 8, 'b8')] }), {
      getActivePath: () => 'a.js',
      getCursorInfo: () => ({ lineNumber: 1, column: 1 }),
      getFocusedPath: () => 'b.js',
      getFocusedCursorInfo: () => ({ lineNumber: 5, column: 1 }),
    }),
    onReveal: (path, line, column) => reveals.push(`${path}:${line}:${column}`),
  });
  panel.nextProblem();
  panel.previousProblem();
  assert.deepEqual(reveals, ['b.js:8:1', 'b.js:2:1']);
});

test('T4: one getMarkers() scan per refresh, shared by the panel render and the tree badges snapshot', () => {
  const { panel, state, flushTimers } = setup([marker('a.js', 8, 1, 'e1')]);
  let list = [marker('a.js', 8, 1, 'e1'), marker('b.js', 4, 2, 'w')];
  let scans = 0;
  Object.defineProperty(state, 'markers', { get() { scans += 1; return list; } });
  state.cb();
  assert.equal(panel.getMarkerSnapshot().length, 2, 'a reader inside the coalescing window sees the new markers');
  flushTimers();
  assert.equal(panel.getCounts().total, 2);
  assert.equal(scans, 1, 'the render reuses the snapshot the badges took');
  list = [];
  state.cb();
  flushTimers();
  assert.deepEqual(panel.getMarkerSnapshot(), []);
  assert.equal(scans, 2);
});
