'use strict';

/* tests/renderer-ide-map-components-lens.test.js - row 77 phase 3: the File
 * Map's Components lens view (renderer/features/renderer-ide-map-components-lens.js)
 * over a hand-built graph.components. JSDOM directly; always dispose via
 * t.after(), never dom.window.close(). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createComponentsLens } = require('../renderer/features/renderer-ide-map-components-lens');

function box(id, parentId, name, files, label) {
  const c = { id, parentId, name, origin: 'box', depth: parentId ? 2 : 1, fileCount: 0, label: label || { kind: 'folder', text: name }, parts: [] };
  if (Array.isArray(files)) { c.files = files; c.fileCount = files.length; } else c.fileCount = files;
  return c;
}

const range = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}.js`);

function makeGraph() {
  return {
    nodes: [],
    edges: [],
    meta: {},
    components: {
      version: 1,
      scopes: [
        { id: 'root', rung: 'frontier', axis: 'structural', leafReason: '', leafKind: '', ruleCount: 4 },
        { id: '1', rung: 'segment', axis: 'structural', leafReason: '', leafKind: '', ruleCount: 2 },
        { id: '1.2', rung: 'leaf', axis: '', leafReason: 'small: 3 files', leafKind: 'small', ruleCount: 0 },
      ],
      components: [
        box('1', null, 'services', 9),
        box('1.1', '1', 'backend', range('services/backend/session-', 6)),
        box('1.2', '1', 'main', ['services/main/a.js', 'services/main/b.js', 'services/main/session-c.js']),
        box('2', null, 'renderer', range('renderer/r', 5)),
        box('3', null, 'scripts', range('scripts/s', 4)),
        box('4', null, 'Loose files', ['main.js', 'start.js'], { kind: 'loose', dir: '' }),
      ],
      relations: [
        { scopeId: 'root', from: '3', to: '1', weight: 40 },
        { scopeId: 'root', from: '1', to: '2', weight: 19 },
        { scopeId: 'root', from: '4', to: '1', weight: 6 },
        { scopeId: '1', from: '1.2', to: '1.1', weight: 12 },
      ],
      outside: [{ id: 'tests', fileCount: 30 }, { id: 'docs', fileCount: 4 }],
      outsideRelations: [{ from: 'tests', to: '1', files: 12 }, { from: 'tests', to: '2', files: 9 }],
    },
  };
}

function setup(t, extra = {}) {
  const dom = new JSDOM('<div class="ide-map-viewport"><div class="ide-map-controls"></div></div>');
  const document = dom.window.document;
  const viewportEl = document.querySelector('.ide-map-viewport');
  const calls = { reveal: [], atlas: 0 };
  const observers = [];
  class FakeResizeObserver {
    constructor(cb) { this.cb = cb; this.connected = true; observers.push(this); }
    observe() {}
    disconnect() { this.connected = false; }
  }
  const windowRef = { ResizeObserver: FakeResizeObserver, requestAnimationFrame: (fn) => fn(), cancelAnimationFrame: () => {} };
  const lens = createComponentsLens({
    viewportEl,
    controlsEl: document.querySelector('.ide-map-controls'),
    windowRef,
    onRevealFile: (path) => calls.reveal.push(path),
    onShowAtlas: () => { calls.atlas += 1; },
    ...extra,
  });
  t.after(() => lens.dispose());
  const lensEl = () => viewportEl.querySelector('.ide-map-components');
  const boxes = () => Array.from(lensEl().querySelectorAll('.ide-components-box'));
  const boxNamed = (name) => boxes().find((b) => b.querySelector('.ide-components-name').textContent === name);
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const over = (el) => el.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }));
  const key = (k) => lensEl().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  return { dom, document, viewportEl, lens, lensEl, boxes, boxNamed, click, over, key, calls, observers };
}

test('the root draws one box per component, importers above, with honest labels', (t) => {
  const s = setup(t);
  s.lens.update(makeGraph());
  s.lens.show();
  assert.equal(s.lens.isVisible(), true);
  assert.equal(s.lensEl().classList.contains('hidden'), false);
  const rows = Array.from(s.lensEl().querySelectorAll('.ide-components-row'))
    .map((row) => Array.from(row.querySelectorAll('.ide-components-name')).map((n) => n.textContent));
  assert.deepEqual(rows, [['scripts', 'Top-level files'], ['services'], ['renderer']]);
  assert.ok(s.boxNamed('Top-level files').classList.contains('ide-components-box--loose'));
  assert.match(s.lensEl().querySelector('.ide-components-caption').textContent, /^20 files in 4 components · grouped by folder/);
  assert.match(s.boxNamed('services').textContent, /9 files/);
  assert.equal(s.lensEl().querySelectorAll('.ide-components-arrow').length, 3);
});

test('a box opens onto its components; Escape and the breadcrumb go back', (t) => {
  const s = setup(t);
  s.lens.update(makeGraph());
  s.lens.show();
  s.click(s.boxNamed('services'));
  assert.deepEqual(s.boxes().map((b) => b.querySelector('.ide-components-name').textContent).sort(), ['backend', 'main']);
  assert.equal(s.lensEl().querySelector('[aria-current="page"]').textContent, 'services');
  s.key('Escape');
  assert.equal(s.boxes().length, 4);
  s.click(s.boxNamed('services'));
  s.click(s.lensEl().querySelector('.ide-components-crumb'));
  assert.equal(s.boxes().length, 4, 'the first crumb is the root');
});

test('a leaf opens onto its files; a file hands off to the atlas', (t) => {
  const s = setup(t);
  s.lens.update(makeGraph());
  s.lens.show();
  s.click(s.boxNamed('services'));
  s.click(s.boxNamed('main'));
  const rows = Array.from(s.lensEl().querySelectorAll('.ide-components-file'));
  assert.deepEqual(rows.map((r) => r.querySelector('.ide-components-file-name').textContent), ['a.js', 'b.js', 'session-c.js']);
  assert.match(s.lensEl().querySelector('.ide-components-caption').textContent, /3 files · small enough to read as one list · in services\/main\//);
  s.click(rows[1]);
  assert.deepEqual(s.calls.reveal, ['services/main/b.js']);
});

test('hovering a box names its links; hovering tests counts what imports each box', (t) => {
  const s = setup(t);
  s.lens.update(makeGraph());
  s.lens.show();
  s.over(s.boxNamed('services'));
  const status = s.viewportEl.querySelector('.ide-components-status').textContent;
  assert.match(status, /services · imports renderer 19 · imported by scripts 40, Top-level files 6/);
  assert.ok(s.boxNamed('services').classList.contains('is-hover'));
  const chips = Array.from(s.viewportEl.querySelectorAll('.ide-components-beside .ide-atlas-bucket-chip'));
  assert.deepEqual(chips.map((c) => c.textContent.replace(/\s+/g, ' ').trim()), ['tests 30', 'docs 4']);
  s.over(chips[0]);
  assert.match(s.boxNamed('services').textContent, /12 test files import this/);
  assert.ok(s.boxNamed('scripts').classList.contains('is-dim'));
});

test('search marks the boxes holding matches and dims the rest', (t) => {
  const s = setup(t);
  s.lens.update(makeGraph());
  s.lens.show();
  s.lens.setSearch('session');
  assert.match(s.boxNamed('services').textContent, /7 matches/);
  assert.ok(s.boxNamed('renderer').classList.contains('is-dim'));
  s.lens.setSearch('');
  assert.equal(s.boxes().some((b) => b.classList.contains('is-dim')), false);
});

test('no components: the lens says so and offers the atlas; none at all: nothing to group', (t) => {
  const s = setup(t);
  s.lens.update({ nodes: [], edges: [], meta: { componentsError: 'boom' }, components: null });
  s.lens.show();
  assert.match(s.lensEl().textContent, /Components aren.t available for this map/);
  s.click(s.lensEl().querySelector('[data-action="show-atlas"]'));
  assert.equal(s.calls.atlas, 1);
  s.lens.update({ nodes: [], edges: [], meta: {}, components: { version: 1, scopes: [], components: [], relations: [], outside: [], outsideRelations: [] } });
  assert.match(s.lensEl().textContent, /No source files to group/);
});

test('a rescan that renumbers the components keeps the open one (F3)', (t) => {
  const s = setup(t);
  s.lens.update(makeGraph());
  s.lens.show();
  s.click(s.boxNamed('services'));
  const next = makeGraph();
  for (const c of next.components.components) {
    c.id = c.id.replace(/^1/, '9');
    if (c.parentId) c.parentId = c.parentId.replace(/^1/, '9');
  }
  for (const r of next.components.relations) {
    r.from = r.from.replace(/^1/, '9'); r.to = r.to.replace(/^1/, '9'); r.scopeId = r.scopeId.replace(/^1/, '9');
  }
  next.components.scopes.forEach((sc) => { sc.id = sc.id.replace(/^1/, '9'); });
  s.lens.update(next);
  assert.equal(s.lensEl().querySelector('[aria-current="page"]').textContent, 'services');
  assert.equal(s.boxes().length, 2);
});

test('a partial map says so; dispose removes the lens and disconnects its observers', (t) => {
  const s = setup(t);
  const graph = makeGraph();
  graph.meta.truncated = true;
  s.lens.update(graph);
  s.lens.show();
  assert.match(s.lensEl().querySelector('.ide-components-caption').textContent, /· partial map$/);
  assert.ok(s.observers.length >= 1);
  s.lens.dispose();
  assert.equal(s.viewportEl.querySelector('.ide-map-components'), null);
  assert.equal(s.viewportEl.querySelector('.ide-components-status'), null);
  assert.ok(s.observers.every((o) => !o.connected));
  s.lens.dispose();
});

test('with no graph the lens stays hidden so the map state panel shows', (t) => {
  const s = setup(t);
  s.lens.show();
  assert.equal(s.lens.isVisible(), true);
  assert.ok(s.lensEl().classList.contains('hidden'), 'nothing to draw before the first scan');
  s.lens.update(makeGraph());
  assert.equal(s.lensEl().classList.contains('hidden'), false);
  s.lens.update(null);
  assert.ok(s.lensEl().classList.contains('hidden'), 'a failed or empty scan hands back to the state panel');
});

test('a rescan keeps keyboard focus on the same box and the same file row', (t) => {
  const s = setup(t);
  s.lens.update(makeGraph());
  s.lens.show();
  s.boxNamed('renderer').focus();
  s.lens.update(makeGraph());
  assert.equal(s.document.activeElement, s.boxNamed('renderer'));
  s.click(s.boxNamed('services'));
  s.click(s.boxNamed('main'));
  s.lensEl().querySelector('[data-file="services/main/b.js"]').focus();
  s.lens.update(makeGraph());
  assert.equal(s.document.activeElement.getAttribute('data-file'), 'services/main/b.js');
});

test('a long leaf lists its files a page at a time; search puts the matches first', (t) => {
  const s = setup(t);
  const graph = makeGraph();
  const big = graph.components.components.find((c) => c.id === '2');
  big.files = range('renderer/r', 450);
  big.fileCount = 450;
  s.lens.update(graph);
  s.lens.show();
  s.click(s.boxNamed('renderer'));
  const rows = () => s.lensEl().querySelectorAll('.ide-components-file');
  const more = () => s.lensEl().querySelector('[data-action="more-files"]');
  assert.equal(rows().length, 200);
  assert.match(s.lensEl().querySelector('.ide-components-caption').textContent, /^450 files/);
  assert.equal(more().textContent.trim(), 'Show 200 more files');
  s.click(more());
  assert.equal(rows().length, 400);
  assert.equal(s.document.activeElement, rows()[200], 'focus moves to the first new row');
  assert.equal(more().textContent.trim(), 'Show 50 more files');
  s.lens.update(graph);
  assert.equal(rows().length, 400, 'a rescan keeps the pages already shown');
  s.click(more());
  assert.equal(rows().length, 450);
  assert.equal(more(), null);

  s.key('Escape');
  s.click(s.boxNamed('renderer'));
  assert.equal(rows().length, 200, 'reopening starts at the first page');
  s.lens.setSearch('r449');
  assert.equal(rows()[0].getAttribute('data-file'), 'renderer/r449.js');
  assert.ok(rows()[0].classList.contains('is-match'));
});

test('hovering a beside chip marks the boxes in place, without redrawing them', (t) => {
  const s = setup(t);
  s.lens.update(makeGraph());
  s.lens.show();
  const before = s.boxes();
  const chip = s.viewportEl.querySelector('.ide-components-beside [data-beside="tests"]');
  s.over(chip);
  assert.deepEqual(s.boxes(), before, 'the same box elements');
  assert.match(s.boxNamed('renderer').textContent, /9 test files import this/);
  assert.ok(s.boxNamed('scripts').classList.contains('is-dim'));
  s.viewportEl.querySelector('.ide-components-beside').dispatchEvent(new s.dom.window.MouseEvent('mouseleave'));
  assert.deepEqual(s.boxes(), before);
  assert.equal(s.lensEl().querySelector('.ide-components-extra'), null);
  assert.equal(s.boxes().some((b) => b.classList.contains('is-dim')), false);
});
