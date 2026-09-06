'use strict';

/* tests/renderer-ide-map-findings.test.js - red-first coverage for
 * renderer/features/renderer-ide-map-findings.js. Uses a REAL-shaped
 * findings object (as produced by services/workspace-file-map-engine.js
 * `findings()`): { hubs: [id,...], cycles: [[id,...],...], orphans: [id,...] }
 * (cycles is an array of arrays, one per distinct cycle). Uses jsdom
 * directly; always dispose via t.after(), never dom.window.close(). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createMapFindings } = require('../renderer/features/renderer-ide-map-findings');

function setupHost() {
  const dom = new JSDOM('<div id="host"></div>');
  const hostEl = dom.window.document.getElementById('host');
  return { dom, hostEl };
}

function makeGraph() {
  return {
    nodes: [
      { id: 'src/a.js', x: 0, y: 0 },
      { id: 'src/b.js', x: 100, y: 0 },
      { id: 'src/c.js', x: 200, y: 0 },
      { id: 'src/orphan.js', x: 300, y: 0 },
    ],
    edges: [],
    findings: {
      hubs: ['src/a.js', 'src/b.js', 'src/c.js'],
      cycles: [['src/a.js', 'src/b.js'], ['src/c.js', 'src/a.js']],
      orphans: ['src/orphan.js'],
    },
  };
}

function fakeView(nodes) {
  // Mirrors the REAL atlas-view accessor (getNodePosition), not internals —
  // a stale nodeIndex-shaped fake previously masked a silent no-op in the
  // chip auto-framing path.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const highlightCalls = [];
  return {
    getNodePosition: (id) => {
      const n = byId.get(id);
      return n ? { x: n.x, y: n.y } : null;
    },
    applyFindingHighlight: (kind, ids) => highlightCalls.push({ kind, ids: Array.from(ids || []) }),
    _highlightCalls: highlightCalls,
  };
}

function fakeTransform() {
  const fitCalls = [];
  return { fitToContent: (bounds) => fitCalls.push(bounds), _fitCalls: fitCalls };
}

test('chips render real counts from graph.findings (hubs/cycles/orphans)', (t) => {
  const { hostEl } = setupHost();
  const graph = makeGraph();
  const view = fakeView(graph.nodes);
  const transform = fakeTransform();
  const findings = createMapFindings({ hostEl, view, transform });
  t.after(() => findings.dispose());

  findings.update(graph);

  const chips = hostEl.querySelectorAll('[data-inv-chip]');
  assert.equal(chips.length, 3, 'expected exactly three chips: hubs, cycles, orphans');

  const hubsChip = hostEl.querySelector('[data-inv-chip="hubs"]');
  const cyclesChip = hostEl.querySelector('[data-inv-chip="cycles"]');
  const orphansChip = hostEl.querySelector('[data-inv-chip="orphans"]');
  assert.equal(hubsChip.querySelector('.inv-chip-count').textContent, '3');
  // cycles count = number of DISTINCT cycle arrays (2), not total ids across them.
  assert.equal(cyclesChip.querySelector('.inv-chip-count').textContent, '2');
  assert.equal(orphansChip.querySelector('.inv-chip-count').textContent, '1');
});

test('clicking the hubs chip highlights implicated nodes and announces via aria-live', (t) => {
  const { hostEl } = setupHost();
  const { dom } = { dom: hostEl.ownerDocument.defaultView };
  const graph = makeGraph();
  const view = fakeView(graph.nodes);
  const transform = fakeTransform();
  const findings = createMapFindings({ hostEl, view, transform });
  t.after(() => findings.dispose());

  findings.update(graph);
  const hubsChip = hostEl.querySelector('[data-inv-chip="hubs"]');
  hubsChip.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }));

  assert.equal(view._highlightCalls.length, 1);
  assert.deepEqual(view._highlightCalls[0], { kind: 'hub', ids: ['src/a.js', 'src/b.js', 'src/c.js'] });
  assert.equal(hubsChip.classList.contains('is-active'), true, 'active chip must carry the is-active class');

  const liveRegion = hostEl.querySelector('[aria-live="polite"]');
  assert.ok(liveRegion, 'expected an aria-live region');
  assert.match(liveRegion.textContent, /3 hubs/);

  // Frames the implicated nodes via the transform's fitToContent.
  assert.equal(transform._fitCalls.length, 1);
  const bounds = transform._fitCalls[0];
  assert.equal(bounds.minX <= 0 && bounds.maxX >= 200, true, 'bounds must cover all three hub node x-positions');
});

test('cycles chip highlights the UNION of ids across every distinct cycle', (t) => {
  const { hostEl } = setupHost();
  const dom = hostEl.ownerDocument.defaultView;
  const graph = makeGraph();
  const view = fakeView(graph.nodes);
  const transform = fakeTransform();
  const findings = createMapFindings({ hostEl, view, transform });
  t.after(() => findings.dispose());

  findings.update(graph);
  const cyclesChip = hostEl.querySelector('[data-inv-chip="cycles"]');
  cyclesChip.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }));

  assert.equal(view._highlightCalls.length, 1);
  assert.equal(view._highlightCalls[0].kind, 'cycle');
  // Union of ['a','b'] and ['c','a'] = {a,b,c} (order-insensitive).
  const idSet = new Set(view._highlightCalls[0].ids);
  assert.deepEqual(idSet, new Set(['src/a.js', 'src/b.js', 'src/c.js']));
});

test('clicking the same chip again clears the highlight (toggle off)', (t) => {
  const { hostEl } = setupHost();
  const dom = hostEl.ownerDocument.defaultView;
  const graph = makeGraph();
  const view = fakeView(graph.nodes);
  const transform = fakeTransform();
  const findings = createMapFindings({ hostEl, view, transform });
  t.after(() => findings.dispose());

  findings.update(graph);
  const orphansChip = hostEl.querySelector('[data-inv-chip="orphans"]');
  orphansChip.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }));
  assert.equal(view._highlightCalls.length, 1);
  assert.deepEqual(view._highlightCalls[0], { kind: 'orphan', ids: ['src/orphan.js'] });

  orphansChip.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }));
  assert.equal(view._highlightCalls.length, 2, 'second click must clear via a second highlight call');
  assert.deepEqual(view._highlightCalls[1], { kind: 'orphan', ids: [] });
  assert.equal(orphansChip.classList.contains('is-active'), false, 'toggled-off chip must lose is-active');
});

test('aria-live summary uses a singular label and raw node ids', (t) => {
  const { hostEl } = setupHost();
  const dom = hostEl.ownerDocument.defaultView;
  const graph = {
    nodes: [{ id: 'src/a&b.js', x: 0, y: 0 }],
    edges: [],
    findings: { hubs: [], cycles: [], orphans: ['src/a&b.js'] },
  };
  const findings = createMapFindings({
    hostEl,
    view: fakeView(graph.nodes),
    transform: fakeTransform(),
  });
  t.after(() => findings.dispose());

  findings.update(graph);
  hostEl.querySelector('[data-inv-chip="orphans"]').dispatchEvent(new dom.MouseEvent('click', { bubbles: true }));

  assert.equal(hostEl.querySelector('[aria-live="polite"]').textContent, '1 orphan: src/a&b.js');
});

test('clicking a different chip clears the previous highlight first', (t) => {
  const { hostEl } = setupHost();
  const dom = hostEl.ownerDocument.defaultView;
  const graph = makeGraph();
  const view = fakeView(graph.nodes);
  const transform = fakeTransform();
  const findings = createMapFindings({ hostEl, view, transform });
  t.after(() => findings.dispose());

  findings.update(graph);
  const hubsChip = hostEl.querySelector('[data-inv-chip="hubs"]');
  const orphansChip = hostEl.querySelector('[data-inv-chip="orphans"]');

  hubsChip.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }));
  orphansChip.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }));

  // hub highlight cleared (empty ids), then orphan highlight applied.
  assert.deepEqual(view._highlightCalls[1], { kind: 'hub', ids: [] });
  assert.deepEqual(view._highlightCalls[2], { kind: 'orphan', ids: ['src/orphan.js'] });
  assert.equal(hubsChip.classList.contains('is-active'), false);
  assert.equal(orphansChip.classList.contains('is-active'), true);
});

test('update() rebuilds chips and clears any active highlight state', (t) => {
  const { hostEl } = setupHost();
  const dom = hostEl.ownerDocument.defaultView;
  const graph = makeGraph();
  const view = fakeView(graph.nodes);
  const transform = fakeTransform();
  const findings = createMapFindings({ hostEl, view, transform });
  t.after(() => findings.dispose());

  findings.update(graph);
  const hubsChip = hostEl.querySelector('[data-inv-chip="hubs"]');
  hubsChip.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }));
  assert.equal(findings._internals.activeChipId, 'hubs');

  findings.update(graph);
  assert.equal(findings._internals.activeChipId, null, 'a fresh update() must reset the active chip');
  assert.equal(hostEl.querySelector('[data-inv-chip="hubs"]').classList.contains('is-active'), false);
});

test('clear() empties the host and dispose() removes listeners', (t) => {
  const { hostEl } = setupHost();
  const graph = makeGraph();
  const view = fakeView(graph.nodes);
  const transform = fakeTransform();
  const findings = createMapFindings({ hostEl, view, transform });

  findings.update(graph);
  assert.ok(hostEl.querySelectorAll('[data-inv-chip]').length > 0);
  findings.clear();
  assert.equal(hostEl.innerHTML, '');

  findings.dispose();
  assert.equal(hostEl.innerHTML, '');
  // dispose is idempotent.
  findings.dispose();
});
