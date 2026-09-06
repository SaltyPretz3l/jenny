'use strict';

/* Headless coverage for the Exploded View painter (createExplodeView).
 * Loads the REAL module directly under node — it self-resolves the inventory
 * actionButton primitive via require('../inventory/action-button'), so no
 * global stubbing is needed (unlike the controller test, which stubs sibling
 * globals for the controller layer). Drives renderGraph/setSpotlight/
 * setLodTier against a jsdom contentEl and asserts the
 * DOM contract: card/edge classes, incident highlighting, LOD classes,
 * center-anchored positioning math, and — importantly — that node name and
 * import-source strings are HTML-escaped rather than parsed, since the view
 * builds card markup via string concatenation (action-button trustedHtml).
 * Follows repo test conventions: node:test, jsdom JSDOM, t.after()+dispose(),
 * never dom.window.close(). */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const FEATURES = path.join(__dirname, '..', 'renderer', 'features');
function feat(name) { return require(path.join(FEATURES, name)); }

const { createExplodeView } = feat('renderer-ide-explode-view.js');

function makeContentEl() {
  const dom = new JSDOM('<!doctype html><body><div id="content"></div></body>');
  const doc = dom.window.document;
  const contentEl = doc.getElementById('content');
  return { dom, doc, contentEl };
}

// Small 3-node / 2-edge fixture: an exported entry function, an internal
// function it calls, and a data node the internal function reads.
function sampleGraph() {
  return {
    nodes: [
      { id: 'function:checkout@1', kind: 'function', name: 'checkout', zone: 'entry', rank: 0, isExported: true, line: 5 },
      { id: 'function:calc@2', kind: 'function', name: 'calc', zone: 'functions', rank: 0, isExported: false, line: 12 },
      { id: 'data:TAX@3', kind: 'data', name: 'TAX', zone: 'data', rank: 0, isExported: false, dataShape: 'array', line: 1 },
    ],
    edges: [
      { from: 'function:checkout@1', to: 'function:calc@2', kind: 'call', weight: 1 },
      { from: 'function:calc@2', to: 'data:TAX@3', kind: 'read', weight: 1 },
    ],
  };
}

function samplePositions() {
  return {
    'function:checkout@1': { x: 100, y: 100 },
    'function:calc@2': { x: 300, y: 100 },
    'data:TAX@3': { x: 300, y: 300 },
  };
}

test('renderGraph paints one card per node and draws the edges', (t) => {
  const { contentEl } = makeContentEl();
  const view = createExplodeView({ contentEl });
  t.after(() => view.dispose());

  const bounds = view.renderGraph(sampleGraph(), { positions: samplePositions() });

  assert.ok(bounds, 'renderGraph returns bounds');
  assert.equal(contentEl.querySelectorAll('[data-map-node]').length, 3, 'one card per node');
  assert.ok(contentEl.querySelector('.ide-explode-node--hero'), 'exported entry node is the hero');
  assert.equal(contentEl.querySelector('.ide-explode-node--hero').title, 'checkout, function, exported');
  assert.ok(contentEl.querySelector('.ide-explode-edge--call'), 'call edge drawn');
  assert.ok(contentEl.querySelector('.ide-explode-edge--read'), 'read edge drawn');
  // Both edges live inside the single shared svg layer.
  assert.equal(contentEl.querySelectorAll('svg.ide-explode-edges path.ide-explode-edge').length, 2, 'two edge paths total');
});

test('setSpotlight highlights the node, incident edges, and neighbors; clears on null', (t) => {
  const { contentEl } = makeContentEl();
  const view = createExplodeView({ contentEl });
  t.after(() => view.dispose());

  view.renderGraph(sampleGraph(), { positions: samplePositions() });

  const internalId = 'function:calc@2';
  const entryId = 'function:checkout@1';
  const dataId = 'data:TAX@3';

  view.setSpotlight(internalId);

  assert.ok(contentEl.classList.contains('ide-explode-content--spotlit'), 'contentEl marked spotlit');
  assert.ok(contentEl.querySelector(`[data-map-node="${internalId}"]`).classList.contains('is-spotlit'), 'spotlighted card is-spotlit');
  assert.equal(
    contentEl.querySelectorAll('.ide-explode-edge.is-incident').length,
    2,
    'both incident edges (call in, read out) marked is-incident',
  );
  assert.ok(contentEl.querySelector(`[data-map-node="${entryId}"]`).classList.contains('is-incident-node'), 'call-source neighbor marked incident');
  assert.ok(contentEl.querySelector(`[data-map-node="${dataId}"]`).classList.contains('is-incident-node'), 'read-target neighbor marked incident');
  // The spotlighted node itself is not also flagged as an "incident neighbor".
  assert.ok(!contentEl.querySelector(`[data-map-node="${internalId}"]`).classList.contains('is-incident-node'), 'spotlighted node itself is not an incident neighbor');

  view.setSpotlight(null);

  assert.ok(!contentEl.classList.contains('ide-explode-content--spotlit'), 'contentEl spotlit class cleared');
  assert.ok(!contentEl.querySelector(`[data-map-node="${internalId}"]`).classList.contains('is-spotlit'), 'is-spotlit cleared');
  assert.equal(contentEl.querySelectorAll('.ide-explode-edge.is-incident').length, 0, 'is-incident cleared on all edges');
  assert.ok(!contentEl.querySelector(`[data-map-node="${entryId}"]`).classList.contains('is-incident-node'), 'entry neighbor cleared');
  assert.ok(!contentEl.querySelector(`[data-map-node="${dataId}"]`).classList.contains('is-incident-node'), 'data neighbor cleared');
});

test('setLodTier maps scale tiers to presentation classes', (t) => {
  const { contentEl } = makeContentEl();
  const view = createExplodeView({ contentEl });
  t.after(() => view.dispose());

  view.setLodTier('dots');
  assert.ok(contentEl.classList.contains('ide-explode-content--tier-dots'), 'dots tier class present');
  assert.ok(!contentEl.classList.contains('ide-explode-content--tier-pills'), 'pills tier class absent');

  view.setLodTier('pills');
  assert.ok(contentEl.classList.contains('ide-explode-content--tier-pills'), 'pills tier class present');
  assert.ok(!contentEl.classList.contains('ide-explode-content--tier-dots'), 'dots tier class absent');

  view.setLodTier('cards');
  assert.ok(!contentEl.classList.contains('ide-explode-content--tier-dots'), 'dots absent for cards tier');
  assert.ok(!contentEl.classList.contains('ide-explode-content--tier-pills'), 'pills absent for cards tier');

  view.setLodTier('some-unknown-tier');
  assert.ok(!contentEl.classList.contains('ide-explode-content--tier-dots'), 'dots absent for unknown tier');
  assert.ok(!contentEl.classList.contains('ide-explode-content--tier-pills'), 'pills absent for unknown tier');
});

test('escaping: malicious node name and import source render as text, never parsed as HTML', (t) => {
  const { contentEl } = makeContentEl();
  const view = createExplodeView({ contentEl });
  t.after(() => view.dispose());

  const evilName = '<img src=x onerror=alert(1)>';
  const evilSource = '"><script>alert(1)</script>';

  const graph = {
    nodes: [
      { id: 'function:evil@9', kind: 'function', name: evilName, zone: 'functions', rank: 0, isExported: false, line: 1 },
      { id: 'import:mod@10', kind: 'import', name: 'mod', zone: 'imports', rank: 0, isExported: false, source: evilSource, line: 2 },
    ],
    edges: [],
  };
  const positions = {
    'function:evil@9': { x: 100, y: 100 },
    'import:mod@10': { x: 300, y: 100 },
  };

  view.renderGraph(graph, { positions });

  assert.equal(contentEl.querySelector('img'), null, 'malicious name never parses into a real <img>');
  assert.equal(contentEl.querySelector('script'), null, 'malicious import source never parses into a real <script>');

  const nameEl = contentEl.querySelector('[data-map-node="function:evil@9"] .ide-explode-node-name');
  assert.ok(nameEl, 'name span rendered');
  assert.equal(nameEl.textContent, evilName, 'name textContent equals the raw string (was escaped, not stripped)');

  const tagEl = contentEl.querySelector('[data-map-node="import:mod@10"] .ide-explode-node-tag');
  assert.ok(tagEl, 'import source tag chip rendered');
  assert.equal(tagEl.textContent, evilSource, 'tag textContent equals the raw source string (was escaped, not stripped)');
});
