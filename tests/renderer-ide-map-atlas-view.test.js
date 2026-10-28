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

const { createAtlasView, middleEllipsis } = require('../renderer/features/renderer-ide-map-atlas-view');

function setupDom() {
  const dom = new JSDOM('<div id="content"></div>');
  const previousWindow = globalThis.window;
  globalThis.window = dom.window;
  const contentEl = dom.window.document.getElementById('content');
  return {
    dom,
    contentEl,
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
  const { contentEl, teardown } = setupDom();
  const view = createAtlasView({ contentEl });
  t.after(() => { view.dispose(); teardown(); });
  view.renderAtlas(sampleGraph(), sampleLayout());
  return { view, contentEl };
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

// ── 2026-10-26 atlas fit pass: per-tile width, middle ellipsis, dot hiding ──

const px7 = (text) => String(text).length * 7;

test('middleEllipsis: a name that fits is returned unchanged', () => {
  assert.equal(middleEllipsis('a.js', 200, px7), 'a.js');
  assert.equal(middleEllipsis('exactly-fits.js', 15 * 7, px7), 'exactly-fits.js');
});

test('middleEllipsis: long names keep the extension and up to four trailing stem chars', () => {
  const out = middleEllipsis('renderer-ide-map-atlas-view.js', 150, px7);
  assert.ok(out.includes('…'));
  assert.ok(out.endsWith('view.js'), out);
  assert.ok(px7(out) <= 150, out);
  assert.equal(out, 'renderer-ide-…view.js', 'the head takes every leading char that fits');
});

test('middleEllipsis: a dotfile keeps its extension and its leading dot in the head', () => {
  assert.equal(middleEllipsis('.gp_check.js', 70, px7), '.gp…heck.js');
});

test('middleEllipsis: no extension (or a dot-first / overlong extension) keeps trailing chars', () => {
  assert.equal(middleEllipsis('LONGFILENAMEWITHOUTEXTENSION', 105, px7), 'LONGFILENA…SION');
  const dotOnly = middleEllipsis('.gitignore-and-more-stuff', 84, px7);
  assert.ok(dotOnly.endsWith('tuff'), dotOnly);
  const longExt = middleEllipsis('archive.tar-compressed-long', 84, px7);
  assert.ok(longExt.endsWith('long'), longExt);
});

test('middleEllipsis: a tiny budget still keeps at least three head chars', () => {
  const out = middleEllipsis('component.test.js', 10, px7);
  assert.ok(out.startsWith('com…'), out);
  assert.ok(out.endsWith('.js'));
  assert.ok(out.length < 'component.test.js'.length);
});

test('middleEllipsis is also on the module API', () => {
  const mod = require('../renderer/features/renderer-ide-map-atlas-view');
  assert.equal(typeof mod.middleEllipsis, 'function');
});

test('tiles are sized and centred from the layout width, defaulting to 132', (t) => {
  const { contentEl, teardown } = setupDom();
  const view = createAtlasView({ contentEl });
  t.after(() => { view.dispose(); teardown(); });
  const layout = sampleLayout();
  layout.positions['renderer/a.js'] = { x: 80, y: 80, w: 200 };
  view.renderAtlas(sampleGraph(), layout);
  const sized = view.ensureTileFor('renderer/a.js');
  assert.equal(sized.style.width, '200px');
  assert.equal(sized.style.left, '-20px', 'centred on x with w / 2');
  const plain = view.ensureTileFor('services/x.js');
  assert.equal(plain.style.width, '132px');
  assert.equal(plain.style.left, '414px');
});

test('tile labels are middle-cut only when the measured text overflows, full path stays in the title', (t) => {
  const { contentEl, teardown } = setupDom();
  const view = createAtlasView({ contentEl, measureLabel: (text) => String(text).length * 8 });
  t.after(() => { view.dispose(); teardown(); });
  const graph = {
    nodes: [
      { id: 'renderer/a.js', label: 'a.js' },
      { id: 'renderer/very-long-label-name.js', label: 'very-long-label-name.js' },
    ],
    edges: [],
  };
  const layout = sampleLayout();
  layout.positions = {
    'renderer/a.js': { x: 80, y: 80, w: 132 },
    'renderer/very-long-label-name.js': { x: 80, y: 130, w: 132 },
  };
  view.renderAtlas(graph, layout);
  const short = view.ensureTileFor('renderer/a.js');
  assert.equal(short.querySelector('.ide-atlas-tile-name').textContent, 'a.js');
  const long = view.ensureTileFor('renderer/very-long-label-name.js');
  const text = long.querySelector('.ide-atlas-tile-name').textContent;
  assert.ok(text.includes('…') && text.endsWith('.js'), text);
  assert.ok(text.length * 8 <= 132 - 30, 'fits the tile width minus the chrome');
  assert.ok(long.title.includes('renderer/very-long-label-name.js'));
  assert.ok(long.getAttribute('aria-label').includes('renderer/very-long-label-name.js'));
});

test('a tile hides its own dot: is-under-tile is set on materialize and cleared on cull', (t) => {
  const { view, contentEl } = mount(t);
  const ids = ['renderer/a.js', 'renderer/b.test.js', 'services/x.js', 'services/y.py'];
  const dotOf = (id) => [...contentEl.querySelectorAll('circle.ide-atlas-dot')][ids.indexOf(id)];
  assert.ok(!dotOf('services/x.js').classList.contains('is-under-tile'));
  view.setTier('tiles');
  for (const id of ids) {
    assert.ok(dotOf(id).classList.contains('is-under-tile'), id);
  }
  view.setViewportRect({ x: 350, y: 0, w: 400, h: 200 }); // services only
  assert.ok(!dotOf('renderer/a.js').classList.contains('is-under-tile'), 'culled tile uncovers its dot');
  assert.ok(dotOf('services/x.js').classList.contains('is-under-tile'));
  view.setTier('dots');
  assert.equal(contentEl.querySelectorAll('.is-under-tile').length, 0);
});

test('ensureTileFor marks the dot, and a re-render starts clean', (t) => {
  const { view, contentEl } = mount(t);
  view.ensureTileFor('renderer/a.js');
  assert.equal(contentEl.querySelectorAll('circle.is-under-tile').length, 1);
  view.renderAtlas(sampleGraph(), sampleLayout());
  assert.equal(contentEl.querySelectorAll('.is-under-tile').length, 0);
});

test('the root district header shows its layout label bare; other districts read "label/"', (t) => {
  const { contentEl, teardown } = setupDom();
  const view = createAtlasView({ contentEl });
  t.after(() => { view.dispose(); teardown(); });
  const layout = sampleLayout();
  layout.districts.push({
    key: '.', label: 'Top level', depth: 1, parentKey: null,
    x: 800, y: 0, w: 200, h: 100, directCount: 1, fileCount: 1, flattened: false,
    langMix: [{ cls: 'js', count: 1 }],
    health: { capRed: 0, capAmber: 0, hubs: 0, cycles: 0, orphans: 0 },
  });
  view.renderAtlas(sampleGraph(), layout);
  const names = [...contentEl.querySelectorAll('.ide-atlas-district-name')].map((el) => el.textContent);
  assert.deepEqual(names, ['renderer/', 'services/', 'Top level']);
});

test('dispose clears everything and is idempotent', (t) => {
  const { view, contentEl } = mount(t);
  view.dispose();
  view.dispose();
  assert.equal(contentEl.children.length, 0);
  assert.equal(view.hitTest(80, 80), null);
});

// ── 2026-10-22 review fixes: decoration passes touch only changed ids ──────

test('getAllNodeIds is one stable Set per render (the rail caches its resolver on it)', (t) => {
  const { view } = mount(t);
  const first = view.getAllNodeIds();
  assert.equal(view.getAllNodeIds(), first);
  assert.equal(first.size, 4);
  view.renderAtlas(sampleGraph(), sampleLayout());
  assert.notEqual(view.getAllNodeIds(), first, 'a re-render hands out a new Set');
});

test('clearing a selection touches only the ids that carried state classes', (t) => {
  const { view, contentEl } = mount(t);
  const dots = contentEl.querySelectorAll('circle.ide-atlas-dot');
  const bystander = dots[3]; // services/y.py, never selected
  bystander.classList.add('is-selected');
  view.setSelection('renderer/a.js', { dependencies: ['services/x.js'], dependents: [] });
  view.setSelection(null);
  assert.equal(contentEl.querySelectorAll('.is-ray-target').length, 0);
  assert.ok(bystander.classList.contains('is-selected'), 'an unrelated dot was never visited');
});

test('git and heat passes restyle only the ids whose state changed', (t) => {
  const { view, contentEl } = mount(t);
  view.applyGitStatus({ 'renderer/a.js': 'modified' });
  const dot = contentEl.querySelector('circle.ide-atlas-dot--git-modified');
  dot.classList.remove('ide-atlas-dot--git-modified');
  view.applyGitStatus({ 'renderer/a.js': 'modified' });
  assert.ok(!dot.classList.contains('ide-atlas-dot--git-modified'), 'an unchanged status is not re-applied');
  view.applyGitStatus({});
  view.applyGitStatus({ 'renderer/a.js': 'added' });
  assert.ok(dot.classList.contains('ide-atlas-dot--git-added'));

  const heat = new Map([['renderer/a.js', { kind: 'read' }]]);
  view.applyActivity({ heat, editedIds: new Set() });
  dot.classList.remove('is-heat');
  view.applyActivity({ heat, editedIds: new Set() });
  assert.ok(!dot.classList.contains('is-heat'), 'unchanged heat is not re-applied');
  view.applyActivity({ heat, editedIds: new Set(['renderer/a.js']) });
  assert.ok(dot.classList.contains('is-heat-edit'), 'an edit flip restyles');
});

test('a tile materialized after an activity paint carries the heat classes', (t) => {
  const { view } = mount(t);
  view.applyActivity({
    heat: new Map([['services/x.js', { kind: 'edit' }]]),
    editedIds: new Set(['services/x.js']),
  });
  view.setTier('tiles');
  const tile = view.getNodeElement('services/x.js');
  assert.ok(tile.classList.contains('is-heat'));
  assert.ok(tile.classList.contains('is-heat-edit'));
});
