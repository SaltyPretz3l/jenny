'use strict';

/* tests/renderer-ide-map-atlas-view.test.js - coverage for the Living Atlas
 * view (renderer/features/renderer-ide-map-atlas-view.js): district DOM +
 * header buttons, the single shared dots svg (pointer-events-free circles),
 * viewport-culled tile materialization with the hard cap, the spatial-index
 * hit test, selection rays (out/in), blast spotlight, git/finding/activity
 * decoration classes, layer/tier class gating, and the bucket strip chrome.
 * jsdom directly (standalone leaf renderer module); dispose via t.after(). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createAtlasView, renderBucketStrip } = require('../renderer/features/renderer-ide-map-atlas-view');

function setupDom() {
  const dom = new JSDOM('<div id="content"></div><div id="strip"></div>');
  const previousWindow = globalThis.window;
  globalThis.window = dom.window;
  const contentEl = dom.window.document.getElementById('content');
  const stripEl = dom.window.document.getElementById('strip');
  return {
    dom,
    contentEl,
    stripEl,
    teardown() {
      globalThis.window = previousWindow;
    },
  };
}

// Two districts side by side: renderer at x 0..300, services at x 400..700.
function sampleLayout() {
  return {
    districts: [
      {
        key: 'renderer', label: 'renderer', depth: 1, parentKey: null,
        x: 0, y: 0, w: 300, h: 200, directCount: 2, fileCount: 2, flattened: false,
        langMix: [{ cls: 'js', count: 2 }],
        health: { capRed: 0, capAmber: 0, hubs: 0, cycles: 0, orphans: 0 },
      },
      {
        key: 'services', label: 'services', depth: 1, parentKey: null,
        x: 400, y: 0, w: 300, h: 200, directCount: 2, fileCount: 2, flattened: false,
        langMix: [{ cls: 'js', count: 1 }, { cls: 'py', count: 1 }],
        health: { capRed: 1, capAmber: 0, hubs: 0, cycles: 0, orphans: 0 },
      },
    ],
    positions: {
      'renderer/a.js': { x: 80, y: 80 },
      'renderer/b.test.js': { x: 80, y: 130 },
      'services/x.js': { x: 480, y: 80 },
      'services/y.py': { x: 480, y: 130 },
    },
    buckets: [],
    bounds: { minX: 0, minY: 0, maxX: 700, maxY: 200 },
  };
}

function sampleGraph() {
  return {
    nodes: [
      { id: 'renderer/a.js', label: 'a.js', inbound: 1, outbound: 1 },
      { id: 'renderer/b.test.js', label: 'b.test.js', isTest: true, inbound: 0, outbound: 1 },
      { id: 'services/x.js', label: 'x.js', inbound: 2, outbound: 0 },
      { id: 'services/y.py', label: 'y.py', inbound: 0, outbound: 0 },
    ],
    edges: [
      { from: 'renderer/a.js', to: 'services/x.js', kind: 'import' },
      { from: 'renderer/b.test.js', to: 'renderer/a.js', kind: 'import' },
    ],
  };
}

function mount(t) {
  const { contentEl, stripEl, teardown } = setupDom();
  const view = createAtlasView({ contentEl });
  t.after(() => { view.dispose(); teardown(); });
  view.renderAtlas(sampleGraph(), sampleLayout());
  return { view, contentEl, stripEl };
}

test('renderAtlas: district divs with header buttons, one dot circle per file, no tiles at regions tier', (t) => {
  const { view, contentEl } = mount(t);
  const districts = contentEl.querySelectorAll('[data-map-district]');
  assert.equal(districts.length, 2);
  const headers = contentEl.querySelectorAll('button[data-map-district-header]');
  assert.equal(headers.length, 2);
  assert.deepEqual([...headers].map((header) => header.title), ['Zoom to renderer', 'Zoom to services']);
  assert.equal(contentEl.querySelectorAll('.ide-atlas-dot').length, 4);
  assert.equal(contentEl.querySelectorAll('[data-map-node]').length, 0);
  assert.equal(view.getTier(), 'regions');
  assert.ok(contentEl.classList.contains('ide-atlas--tier-regions'));
  // Test file carries the test class on its dot.
  assert.ok(contentEl.querySelector('.ide-atlas-dot--test'));
  // Bounds pass through.
  assert.deepEqual(view.getBounds(), { minX: 0, minY: 0, maxX: 700, maxY: 200 });
});

test('setTier tiles materializes tiles; dots tier drops them again', (t) => {
  const { view, contentEl } = mount(t);
  view.setTier('tiles');
  assert.equal(contentEl.querySelectorAll('[data-map-node]').length, 4);
  assert.equal(view.getNodeElement('renderer/a.js').title, 'renderer/a.js — 1 inbound, 1 outbound');
  assert.ok(contentEl.classList.contains('ide-atlas--tier-tiles'));
  view.setTier('dots');
  assert.equal(contentEl.querySelectorAll('[data-map-node]').length, 0);
  assert.equal(view.getRenderedSet().size, 0);
});

test('viewport culling: tiles materialize only for districts intersecting the rect', (t) => {
  const { view, contentEl } = mount(t);
  view.setTier('tiles');
  view.setViewportRect({ x: 350, y: 0, w: 400, h: 200 }); // services only
  const ids = [...contentEl.querySelectorAll('[data-map-node]')].map((el) => el.dataset.mapNode).sort();
  assert.deepEqual(ids, ['services/x.js', 'services/y.py']);
  view.setViewportRect(null); // null = no culling
  assert.equal(contentEl.querySelectorAll('[data-map-node]').length, 4);
});

test('hitTest: nearest node within the hit radius, deepest district otherwise, null off-map', (t) => {
  const { view } = mount(t);
  assert.deepEqual(view.hitTest(82, 84), { kind: 'node', id: 'renderer/a.js' });
  assert.deepEqual(view.hitTest(150, 170), { kind: 'district', id: 'renderer' });
  assert.equal(view.hitTest(2000, 2000), null);
  // hideTests removes test files from hit results.
  view.setHideTests(true);
  assert.notDeepEqual(view.hitTest(80, 130), { kind: 'node', id: 'renderer/b.test.js' });
});

test('setSelection draws out/in rays, marks focus + targets, and clears on null', (t) => {
  const { view, contentEl } = mount(t);
  view.setTier('tiles');
  view.setSelection('renderer/a.js', {
    dependencies: ['services/x.js'],
    dependents: ['renderer/b.test.js'],
  });
  assert.ok(contentEl.classList.contains('ide-atlas--spotlit'));
  assert.equal(contentEl.querySelectorAll('.ide-atlas-ray--out').length, 1);
  assert.equal(contentEl.querySelectorAll('.ide-atlas-ray--in').length, 1);
  const focusTile = view.getNodeElement('renderer/a.js');
  assert.ok(focusTile.classList.contains('is-selected'));
  const depTile = view.getNodeElement('services/x.js');
  assert.ok(depTile.classList.contains('is-ray-target'));
  view.setSelection(null);
  assert.ok(!contentEl.classList.contains('ide-atlas--spotlit'));
  assert.equal(contentEl.querySelectorAll('.ide-atlas-ray--out').length, 0);
});

test('setSpotlightSet lights focus + members and replaces any selection', (t) => {
  const { view, contentEl } = mount(t);
  view.setTier('tiles');
  view.setSelection('services/x.js', { dependencies: [], dependents: [] });
  view.setSpotlightSet('renderer/a.js', ['renderer/b.test.js']);
  assert.ok(view.getNodeElement('renderer/a.js').classList.contains('is-spotlit'));
  assert.ok(view.getNodeElement('renderer/b.test.js').classList.contains('is-incident-node'));
  assert.ok(!view.getNodeElement('services/x.js').classList.contains('is-selected'));
  assert.equal(contentEl.querySelectorAll('.ide-atlas-ray--out').length, 0);
  view.setSpotlightSet(null, []);
  assert.ok(!contentEl.classList.contains('ide-atlas--spotlit'));
});

test('git + finding + activity decorations land on dots and tiles', (t) => {
  const { view, contentEl } = mount(t);
  view.setTier('tiles');
  view.applyGitStatus({ 'renderer/a.js': 'modified', 'services/x.js': 'added' });
  assert.ok(view.getNodeElement('renderer/a.js').classList.contains('ide-atlas-tile--git-modified'));
  assert.equal(contentEl.querySelectorAll('.ide-atlas-dot--git-added').length, 1);

  view.applyFindingHighlight('hub', ['services/x.js']);
  assert.ok(view.getNodeElement('services/x.js').classList.contains('ide-atlas-node--finding-hub'));
  view.applyFindingHighlight(null, []);
  assert.ok(!view.getNodeElement('services/x.js').classList.contains('ide-atlas-node--finding-hub'));

  view.applyActivity({
    heat: new Map([['renderer/a.js', { kind: 'edit', recency: 1 }]]),
    editedIds: new Set(['renderer/a.js']),
  });
  const hot = view.getNodeElement('renderer/a.js');
  assert.ok(hot.classList.contains('is-heat'));
  assert.ok(hot.classList.contains('is-heat-edit'));
  view.applyActivity({ heat: new Map(), editedIds: new Set() });
  assert.ok(!hot.classList.contains('is-heat'));
});

test('decorations survive re-materialization (tile rebuilt with current state)', (t) => {
  const { view } = mount(t);
  view.applyGitStatus({ 'services/x.js': 'modified' });
  view.setTier('tiles');
  assert.ok(view.getNodeElement('services/x.js').classList.contains('ide-atlas-tile--git-modified'));
});

test('setLayerState + setHideTests toggle the content gate classes', (t) => {
  const { view, contentEl } = mount(t);
  view.setTier('tiles');
  view.setLayerState({ activity: true, health: true, deps: false });
  assert.ok(contentEl.classList.contains('ide-atlas--layer-activity'));
  assert.ok(contentEl.classList.contains('ide-atlas--layer-health'));
  assert.ok(!contentEl.classList.contains('ide-atlas--layer-deps'));
  view.setHideTests(true);
  assert.ok(contentEl.classList.contains('ide-atlas--hide-tests'));
  assert.equal(view.getNodeElement('renderer/b.test.js'), null, 'hidden test tile is removed from DOM');
  assert.equal(view.getRenderedSet().has('renderer/b.test.js'), false);
  assert.equal(view.isNodeNavigable('renderer/b.test.js'), false);
  assert.equal(view.ensureTileFor('renderer/b.test.js'), null, 'hidden tests cannot be force-materialized');
  view.setHideTests(false);
  assert.ok(view.getNodeElement('renderer/b.test.js'), 'showing tests rematerializes the tile');
});

test('hiding a hovered test clears hover classes before forgetting its id', (t) => {
  const { view, contentEl } = mount(t);
  view.setTier('tiles');
  view.setHover('renderer/b.test.js');
  assert.ok(contentEl.querySelector('.ide-atlas-dot--test').classList.contains('is-hover'));

  view.setHideTests(true);
  view.setHideTests(false);

  assert.ok(!contentEl.querySelector('.ide-atlas-dot--test').classList.contains('is-hover'));
  assert.ok(!view.getNodeElement('renderer/b.test.js').classList.contains('is-hover'));
});

test('reduced motion skips activity pulse creation', (t) => {
  const { view, contentEl } = mount(t);
  contentEl.ownerDocument.defaultView.matchMedia = () => ({ matches: true });

  view.applyActivity({
    heat: new Map([['renderer/a.js', { kind: 'read', recency: 1 }]]),
    editedIds: new Set(),
  });

  assert.equal(contentEl.querySelectorAll('.ide-atlas-pulse').length, 0);
});

test('ensureTileFor materializes a focusable tile regardless of tier/viewport', (t) => {
  const { view } = mount(t);
  assert.equal(view.getNodeElement('renderer/a.js'), null);
  const el = view.ensureTileFor('renderer/a.js');
  assert.ok(el);
  assert.equal(el.tabIndex, -1, 'new tiles are never independently tabbable');
  assert.equal(view.getNodeElement('renderer/a.js'), el);
  assert.equal(view.ensureTileFor('missing.js'), null);
});

test('tile cap: materialization never exceeds MAX_TILES', (t) => {
  const { contentEl, teardown } = setupDom();
  const view = createAtlasView({ contentEl });
  t.after(() => { view.dispose(); teardown(); });
  const cap = view._internals.MAX_TILES;
  const n = cap + 50;
  const nodes = [];
  const positions = {};
  for (let i = 0; i < n; i += 1) {
    const id = `flat/f${i}.js`;
    nodes.push({ id, label: `f${i}.js` });
    positions[id] = { x: (i % 100) * 10, y: Math.floor(i / 100) * 10 };
  }
  view.renderAtlas({ nodes, edges: [] }, {
    districts: [{
      key: 'flat', label: 'flat', depth: 1, parentKey: null,
      x: 0, y: 0, w: 1100, h: 300, directCount: n, fileCount: n, flattened: false,
      langMix: [{ cls: 'js', count: n }],
      health: { capRed: 0, capAmber: 0, hubs: 0, cycles: 0, orphans: 0 },
    }],
    positions,
    buckets: [],
    bounds: { minX: 0, minY: 0, maxX: 1100, maxY: 300 },
  });
  view.setTier('tiles');
  assert.equal(view.getRenderedSet().size, cap);
});

test('renderBucketStrip: chips for buckets, hidden when empty', (t) => {
  const { stripEl, teardown } = setupDom();
  t.after(teardown);
  renderBucketStrip(stripEl, [
    { key: 'node_modules', label: 'node_modules', count: 5800 },
    { key: 'dist', label: 'dist', count: 1200 },
  ]);
  assert.ok(!stripEl.classList.contains('hidden'));
  const chips = stripEl.querySelectorAll('[data-map-bucket]');
  assert.equal(chips.length, 2);
  assert.ok(stripEl.textContent.includes('node_modules'));
  assert.ok(stripEl.textContent.includes('5800'));
  renderBucketStrip(stripEl, []);
  assert.ok(stripEl.classList.contains('hidden'));
  assert.equal(stripEl.innerHTML, '');
});

test('dispose clears everything and is idempotent', (t) => {
  const { view, contentEl } = mount(t);
  view.dispose();
  view.dispose();
  assert.equal(contentEl.children.length, 0);
  assert.equal(view.hitTest(80, 80), null);
});
