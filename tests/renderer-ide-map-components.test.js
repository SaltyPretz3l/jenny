'use strict';

/* tests/renderer-ide-map-components.test.js - row 77 phase 2: the File Map's
 * `graph.components` (services/workspace-file-map-components.js) reaches the
 * renderer and the Ask-the-Map summary (serializeGraphSummary in
 * renderer/features/renderer-ide-map-overview.js) lists the components, so
 * the model sees the architecture, not only the top directories. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { serializeGraphSummary, SUMMARY_CHAR_CAP } = require('../renderer/features/renderer-ide-map-overview');
const {
  setupDom, makeSpies, stubSiblings, graphA, makeController, mountAndScan, windowStubFor, fakeStorage, settle,
} = require('./helpers/ide-map-controller-harness');

function component(id, parentId, name, fileCount) {
  return { id, parentId, name, origin: 'box', depth: parentId ? 2 : 1, fileCount, parts: [] };
}

function graphWithComponents() {
  return {
    nodes: [{ id: 'services/a.js', inbound: 3, outbound: 0 }, { id: 'renderer/b.js', inbound: 0, outbound: 1 }],
    edges: [],
    findings: { hubs: [], cycles: [], orphans: [] },
    components: {
      version: 1,
      scopes: [],
      components: [
        component('2', null, 'renderer', 859),
        component('1', null, 'services', 893),
        component('1.1', '1', 'backend', 339),
        component('1.2', '1', 'main', 107),
        component('3', null, 'cli', 15),
      ],
      relations: [
        { scopeId: 'root', from: '1', to: '2', weight: 19 },
        { scopeId: 'root', from: '3', to: '1', weight: 40 },
        { scopeId: '1', from: '1.2', to: '1.1', weight: 65 },
      ],
      outside: [{ id: 'tests', fileCount: 4281 }, { id: 'docs', fileCount: 770 }],
      outsideRelations: [{ from: 'tests', to: '1', files: 1248 }, { from: 'tests', to: '2', files: 1229 }],
    },
  };
}

test('the summary lists root components largest first, with what each opens onto', () => {
  const lines = serializeGraphSummary(graphWithComponents()).split('\n');
  const start = lines.indexOf('Components (source files; 3 at the top level):');
  assert.ok(start > 0, lines.join('\n'));
  assert.deepEqual(lines.slice(start + 1, start + 4), [
    '- services: 893 files; inside: backend 339, main 107',
    '- renderer: 859 files',
    '- cli: 15 files',
  ]);
});

test('the summary names the strongest root links and the groups beside the components', () => {
  const summary = serializeGraphSummary(graphWithComponents());
  assert.match(summary, /\nLinks between components \(importer -> imported: file imports\):\n- cli -> services: 40\n- services -> renderer: 19\n/);
  assert.doesNotMatch(summary, /main -> backend/, 'links inside a component stay out of the root summary');
  assert.match(summary, /\nBeside the components: tests 4281 files \(importing services 1248, renderer 1229\), docs 770 files\.\n/);
  assert.ok(summary.indexOf('Components (') < summary.indexOf('Top directories:'), 'components come before directories');
});

test('without components the summary is unchanged', () => {
  const graph = graphWithComponents();
  for (const components of [undefined, null, { version: 1 }]) {
    const summary = serializeGraphSummary({ ...graph, components });
    assert.doesNotMatch(summary, /Components|Beside the components|Links between/);
    assert.match(summary, /Top directories:/);
  }
});

test('a component line stays bounded, and the whole summary within the cap', () => {
  const graph = graphWithComponents();
  const many = [];
  for (let i = 0; i < 15; i += 1) {
    many.push(component(`r${i}`, null, `root-${'x'.repeat(40)}-${i}`, 100 + i));
    for (let k = 0; k < 20; k += 1) many.push(component(`r${i}.${k}`, `r${i}`, `child-${'y'.repeat(30)}-${k}`, 5 + k));
  }
  graph.components = { ...graph.components, components: many, relations: [] };
  const summary = serializeGraphSummary(graph);
  assert.ok(summary.length <= SUMMARY_CHAR_CAP);
  const componentLines = summary.split('\n').filter((line) => line.startsWith('- root-'));
  assert.equal(componentLines.length, 15);
  for (const line of componentLines) {
    assert.ok(line.length <= 200, `${line.length}: ${line}`);
    assert.match(line, /, \+\d+ more$/);
  }
  assert.match(summary, /Top hubs \(by inbound\):/, 'the hubs still fit after the components');
});

test('the controller hands graph.components through to the rendered graph', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());
  const components = graphWithComponents().components;
  const ctrl = makeController(hostEl, { windowRef: windowStubFor({ ...graphA(), components }) });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  assert.equal(spies.renderAtlasCalls.length, 1);
  assert.deepEqual(spies.renderAtlasCalls[0].graph.components, components);
});

test('the controller keeps components null when the scan carries none', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());
  const ctrl = makeController(hostEl, { windowRef: windowStubFor(graphA()) });
  t.after(() => ctrl.dispose());

  await mountAndScan(ctrl);
  assert.equal(spies.renderAtlasCalls[0].graph.components, null);
});

// ── phase 3: the Components lens in the controller ──────────────────────────

function lensGraph() {
  const leaf = (id, name, files) => ({ ...component(id, null, name, files.length), files });
  return {
    ...graphA(),
    components: {
      version: 1,
      scopes: [{ id: 'root', rung: 'frontier', axis: 'structural', leafReason: '', leafKind: '', ruleCount: 2 }],
      components: [leaf('1', 'services', ['services/a.js', 'services/session.js']), leaf('2', 'renderer', ['renderer/b.js'])],
      relations: [{ scopeId: 'root', from: '2', to: '1', weight: 3 }],
      outside: [],
      outsideRelations: [],
    },
  };
}

test('the lens switch shows the components, forwards search, persists, and a file hands off to the atlas', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());
  const storage = fakeStorage();
  const ctrl = makeController(hostEl, { windowRef: windowStubFor(lensGraph()), storage });
  t.after(() => ctrl.dispose());
  await mountAndScan(ctrl);

  const viewport = hostEl.querySelector('.ide-map-viewport');
  const lensEl = () => hostEl.querySelector('.ide-map-components');
  assert.equal(viewport.classList.contains('is-components'), false, 'atlas is the default lens');
  assert.ok(lensEl().classList.contains('hidden'));
  assert.equal(spies.setStateCalls[0].lens, 'atlas');

  const deps = spies.controlsDepsList[0];
  deps.onLensChange('components');
  assert.ok(viewport.classList.contains('is-components'));
  assert.equal(lensEl().classList.contains('hidden'), false);
  assert.equal(lensEl().querySelectorAll('.ide-components-box').length, 2);
  assert.equal(JSON.parse(storage.getItem('jenny.fileMap.prefs.root_a')).lens, 'components');

  deps.onSearchChange('session');
  assert.match(lensEl().textContent, /1 match/);
  deps.onSearchClear();
  assert.doesNotMatch(lensEl().textContent, /match/);

  const box = Array.from(lensEl().querySelectorAll('.ide-components-box')).find((b) => /services/.test(b.textContent));
  box.dispatchEvent(new hostEl.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
  const file = lensEl().querySelector('[data-file="services/a.js"]');
  file.dispatchEvent(new hostEl.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.equal(viewport.classList.contains('is-components'), false, 'a file row switches back to the atlas');
  assert.equal(spies.setStateCalls[spies.setStateCalls.length - 1].lens, 'atlas', 'the bar follows');
  assert.equal(JSON.parse(storage.getItem('jenny.fileMap.prefs.root_a')).lens, 'atlas');
});

test('a persisted Components lens is restored on mount', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());
  const storage = fakeStorage();
  storage.setItem('jenny.fileMap.prefs.root_a', JSON.stringify({ lens: 'components' }));
  const ctrl = makeController(hostEl, { windowRef: windowStubFor(lensGraph()), storage });
  t.after(() => ctrl.dispose());
  await mountAndScan(ctrl);
  assert.ok(hostEl.querySelector('.ide-map-viewport').classList.contains('is-components'));
  assert.equal(hostEl.querySelectorAll('.ide-components-box').length, 2);
  ctrl.dispose();
  assert.equal(hostEl.querySelector('.ide-map-components'), null, 'dispose removes the lens');
});

test('switching lens re-syncs the search status: the atlas cycles matches, the lens marks its own', async (t) => {
  const { hostEl } = setupDom();
  const spies = makeSpies();
  const restore = stubSiblings(globalThis, spies);
  t.after(() => restore());
  const ctrl = makeController(hostEl, { windowRef: windowStubFor(lensGraph()), storage: fakeStorage() });
  t.after(() => ctrl.dispose());
  await mountAndScan(ctrl);
  const deps = spies.controlsDepsList[0];
  const last = () => spies.setStatusCalls[spies.setStatusCalls.length - 1].msg;

  deps.onSearchChange('a.js');
  assert.match(String(last()), /Enter to cycle/);
  deps.onLensChange('components');
  assert.equal(last(), null, 'Enter-cycling is the atlas\x27s, so the lens clears it');
  deps.onLensChange('atlas');
  assert.match(String(last()), /Enter to cycle/, 'back on the atlas the match count returns');
});
