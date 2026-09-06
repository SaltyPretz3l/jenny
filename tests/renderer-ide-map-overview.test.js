'use strict';

/* tests/renderer-ide-map-overview.test.js - coverage for
 * renderer/features/renderer-ide-map-overview.js (P5 scope): the pure
 * deriveOverview/serializeGraphSummary helpers plus the DOM-facing
 * createMapOverview panel (update/show/hide/isVisible + the Ask-the-Map
 * composer affordance). JSDOM directly; always dispose via t.after(), never
 * dom.window.close(). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createMapOverview,
  deriveOverview,
  serializeGraphSummary,
  SUMMARY_CHAR_CAP,
} = require('../renderer/features/renderer-ide-map-overview');

function makeSmallGraph() {
  return {
    nodes: [
      { id: 'src/a.js', inbound: 0, outbound: 2, importance: 0.9, isTest: false },
      { id: 'src/b.js', inbound: 1, outbound: 1, importance: 0.5, isTest: false },
      { id: 'src/dir/c.py', inbound: 1, outbound: 0, importance: 0.2, isTest: false },
      { id: 'src/dir/d.test.js', inbound: 0, outbound: 0, importance: 0.1, isTest: true },
    ],
    edges: [
      { from: 'src/a.js', to: 'src/b.js', kind: 'import' },
      { from: 'src/b.js', to: 'src/dir/c.py', kind: 'import' },
    ],
    findings: { hubs: ['src/b.js'], cycles: [], orphans: ['src/dir/d.test.js'] },
  };
}

test('deriveOverview computes exact stats for a known small graph', () => {
  const graph = makeSmallGraph();
  const result = deriveOverview(graph);
  assert.deepEqual(result, {
    fileCount: 4,
    edgeCount: 2,
    topDirs: [
      { dir: 'src', count: 2 },
      { dir: 'src/dir', count: 2 },
    ],
    languages: [
      { lang: 'js', count: 3 },
      { lang: 'py', count: 1 },
    ],
    entryPoints: ['src/a.js', 'src/dir/d.test.js'],
    hubs: 1,
    cycles: 0,
    orphans: 1,
  });
});

test('deriveOverview on an empty/null graph returns all-zero shape', () => {
  const result = deriveOverview(null);
  assert.deepEqual(result, {
    fileCount: 0,
    edgeCount: 0,
    topDirs: [],
    languages: [],
    entryPoints: [],
    hubs: 0,
    cycles: 0,
    orphans: 0,
  });
});

test('serializeGraphSummary includes stats, top dirs, and top hubs', () => {
  const graph = makeSmallGraph();
  const summary = serializeGraphSummary(graph);
  assert.match(summary, /^Project: 4 files, 2 edges\./);
  assert.match(summary, /Findings: 1 hub\(s\), 0 cycle\(s\), 1 orphan\(s\)\./);
  assert.match(summary, /- src \(2\)/);
  assert.match(summary, /- src\/b\.js \(in:1, out:1\)/);
  assert.equal(summary.length <= SUMMARY_CHAR_CAP, true);
});

test('serializeGraphSummary enforces the hard size cap and truncates on a line boundary', () => {
  // Force overflow with a handful of pathologically long hub ids (only the
  // top 10 hubs are ever emitted, so overflow must come from line LENGTH,
  // not line count).
  const longSegment = 'x'.repeat(500);
  const bigNodes = [];
  for (let i = 0; i < 10; i += 1) {
    bigNodes.push({
      id: `src/${longSegment}_${i}/module.js`,
      inbound: 10 - i,
      outbound: 1,
      importance: 0.5,
      isTest: false,
    });
  }
  const bigGraph = { nodes: bigNodes, edges: [], findings: { hubs: [], cycles: [], orphans: [] } };
  const summary = serializeGraphSummary(bigGraph);

  assert.equal(summary.length <= SUMMARY_CHAR_CAP, true);
  assert.match(summary, /… \(truncated\)$/);
  // The marker itself must never be split mid-line: the line immediately
  // before it is a complete "- path (...)" entry, not a partial fragment.
  const lines = summary.split('\n');
  const markerIndex = lines.indexOf('… (truncated)');
  assert.equal(markerIndex > 0, true);
  assert.match(lines[markerIndex - 1], /^(- |Project:|Findings:|Top directories:|Top hubs)/);
});

function setupHost() {
  const dom = new JSDOM('<div id="host"></div>');
  const hostEl = dom.window.document.getElementById('host');
  return { dom, hostEl };
}

test('createMapOverview: markup uses only inventory primitives (no raw <button>/<input>)', (t) => {
  const { hostEl } = setupHost();
  const panel = createMapOverview({ hostEl, onAsk: () => {} });
  t.after(() => panel.dispose());
  panel.update(makeSmallGraph());

  assert.equal(hostEl.querySelectorAll('button').length > 0, true);
  // Every rendered <button> must come from the inventory action-button/chip
  // primitives (data-action or data-inv-chip), never a hand-authored raw one.
  const buttons = Array.from(hostEl.querySelectorAll('button'));
  const allTagged = buttons.every(
    (btn) => btn.hasAttribute('data-action') || btn.hasAttribute('data-inv-chip')
  );
  assert.equal(allTagged, true);
});

test('createMapOverview: hidden by default via show()/hide()/isVisible()', (t) => {
  const { hostEl } = setupHost();
  hostEl.classList.add('hidden');
  const panel = createMapOverview({ hostEl, onAsk: () => {} });
  t.after(() => panel.dispose());

  assert.equal(panel.isVisible(), false);
  panel.show();
  assert.equal(panel.isVisible(), true);
  assert.equal(hostEl.classList.contains('hidden'), false);
  panel.hide();
  assert.equal(panel.isVisible(), false);
  assert.equal(hostEl.classList.contains('hidden'), true);
});

test('createMapOverview: Ask Jenny fires onAsk with the question + a bounded summary', (t) => {
  const { hostEl } = setupHost();
  const asked = [];
  const panel = createMapOverview({
    hostEl,
    onAsk: (payload) => asked.push(payload),
  });
  t.after(() => panel.dispose());
  panel.update(makeSmallGraph());

  const input = hostEl.querySelector('.ide-map-overview-question .inv-text-field-control');
  assert.equal(Boolean(input), true);
  input.value = 'What imports src/b.js?';

  const askBtn = hostEl.querySelector('[data-action="ask"]');
  assert.equal(Boolean(askBtn), true);
  askBtn.dispatchEvent(new hostEl.ownerDocument.defaultView.Event('click', { bubbles: true }));

  assert.equal(asked.length, 1);
  assert.deepEqual(
    { kind: asked[0].kind, question: asked[0].question },
    { kind: 'file_map_query', question: 'What imports src/b.js?' }
  );
  assert.match(asked[0].summary, /^Project: 4 files, 2 edges\./);
});

test('createMapOverview: close button calls hide() and onClose', (t) => {
  const { hostEl } = setupHost();
  let closed = 0;
  const panel = createMapOverview({
    hostEl,
    onAsk: () => {},
    onClose: () => { closed += 1; },
  });
  t.after(() => panel.dispose());
  panel.update(makeSmallGraph());
  panel.show();

  const closeBtn = hostEl.querySelector('[data-action="close"]');
  assert.equal(closeBtn.title, 'Close overview');
  assert.equal(Boolean(closeBtn), true);
  closeBtn.dispatchEvent(new hostEl.ownerDocument.defaultView.Event('click', { bubbles: true }));

  assert.equal(panel.isVisible(), false);
  assert.equal(closed, 1);
});

test('createMapOverview: dispose() clears hostEl and is idempotent', (t) => {
  const { hostEl } = setupHost();
  const panel = createMapOverview({ hostEl, onAsk: () => {} });
  panel.update(makeSmallGraph());
  assert.equal(hostEl.innerHTML !== '', true);

  panel.dispose();
  assert.equal(hostEl.innerHTML, '');
  assert.doesNotThrow(() => panel.dispose());
});
