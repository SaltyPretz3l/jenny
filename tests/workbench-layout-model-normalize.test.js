'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../renderer/shared/workbench-layout-model');
const fx = require('./helpers/workbench-layout-fixtures');

const {
  SIZE_MAX,
  MAX_EDITOR_GROUPS,
  createDefaultLayout,
  normalizeLayout,
  findView,
  findStack,
} = model;
const {
  LEFT,
  BOTTOM,
  CHAT,
  shape,
  collectNodes,
  stackOf,
  sizeEntry,
  stk,
  editor,
  spl,
  ch,
  assertValid,
  mulberry32,
  ALL_VIEWS,
} = fx;

/* ---------- normalizeLayout ---------- */

test('normalizeLayout accepts a valid layout unchanged and returns a fresh object', () => {
  const layout = createDefaultLayout();
  const out = normalizeLayout(layout);
  assert.deepEqual(out, layout);
  assert.notEqual(out, layout);
  assert.notEqual(out.root, layout.root);
});

test('normalizeLayout drops unknown and duplicate views (first wins)', () => {
  const raw = {
    v: 1,
    root: spl(
      'split-1',
      'row',
      ch(stk('stack-1', ['explorer', 'bogus', 'explorer', 'search', 7, null]), 300),
      ch(
        spl(
          'split-2',
          'col',
          ch(editor()),
          ch(stk('stack-2', ['terminal', 'search', 'problems', 'run', 'test-runner']), 220),
        ),
      ),
      ch(stk('stack-3', ['chat', 'changes', 'chat']), 380),
    ),
  };
  const out = normalizeLayout(raw);
  assertValid(out);
  assert.deepEqual(stackOf(out, 'explorer').views, ['explorer', 'search', 'source-control']);
  assert.deepEqual(stackOf(out, 'terminal').views, ['terminal', 'problems', 'run', 'test-runner', 'test-output']);
  assert.deepEqual(stackOf(out, 'chat').views, ['chat', 'changes']);
});

test('normalizeLayout drops empty view stacks and collapses single-child splits', () => {
  const raw = {
    v: 1,
    root: spl(
      'split-1',
      'row',
      ch(stk('stack-1', []), 300),
      ch(
        spl(
          'split-2',
          'col',
          ch(spl('split-3', 'row', ch(editor()))),
          ch(stk('stack-2', BOTTOM), 220),
        ),
      ),
      ch(stk('stack-3', ['bogus']), 380),
    ),
  };
  const out = normalizeLayout(raw);
  assertValid(out);
  // The empty stacks are gone and the lone-child split dissolved; the missing views were
  // re-homed by the append rule.
  assert.equal(
    shape(out.root),
    'row(explorer+search+source-control,col(E,terminal+problems+run+test-runner+test-output),chat+changes!)',
  );
});

test('normalizeLayout appends missing views to their homes', () => {
  const raw = {
    v: 1,
    root: spl(
      'split-1',
      'row',
      ch(stk('stack-1', ['explorer']), 300),
      ch(spl('split-2', 'col', ch(editor()), ch(stk('stack-2', ['terminal']), 220))),
      ch(stk('stack-3', ['chat']), 380),
    ),
  };
  const out = normalizeLayout(raw);
  assertValid(out);
  assert.deepEqual(stackOf(out, 'explorer').views, LEFT);
  assert.deepEqual(stackOf(out, 'terminal').views, BOTTOM);
  assert.deepEqual(stackOf(out, 'chat').views, CHAT);
});

test('normalizeLayout creates missing home stacks (left edge, collapsed bottom, collapsed right edge)', () => {
  const raw = { v: 1, root: editor() };
  const out = normalizeLayout(raw);
  assertValid(out);
  assert.equal(
    shape(out.root),
    'row(explorer+search+source-control,col(E,terminal+problems+run+test-runner+test-output!),chat+changes!)',
  );
  const out2 = normalizeLayout({
    v: 1,
    root: spl('split-1', 'col', ch(editor()), ch(stk('stack-1', BOTTOM), 200)),
  });
  assertValid(out2);
  assert.equal(
    shape(out2.root),
    'row(explorer+search+source-control,col(E,terminal+problems+run+test-runner+test-output),chat+changes!)',
  );
});

test('normalizeLayout keeps a view wherever it already is', () => {
  const raw = {
    v: 1,
    root: spl(
      'split-1',
      'row',
      ch(stk('stack-1', ['explorer', 'search']), 300),
      ch(spl('split-2', 'col', ch(editor()), ch(stk('stack-2', [...BOTTOM, 'source-control']), 220))),
      ch(stk('stack-3', CHAT), 380),
    ),
  };
  const out = normalizeLayout(raw);
  assertValid(out);
  // source-control was present (in a bottom stack); it is not duplicated or moved.
  assert.deepEqual(stackOf(out, 'source-control').views, [...BOTTOM, 'source-control']);
});

test('normalizeLayout clamps sizes to the stack minimum and SIZE_MAX', () => {
  const raw = {
    v: 1,
    root: spl(
      'split-1',
      'row',
      ch(stk('stack-1', LEFT), 12.7),
      ch(spl('split-2', 'col', ch(editor()), ch(stk('stack-2', BOTTOM), 5))),
      ch(stk('stack-3', CHAT), 99999),
    ),
  };
  const out = normalizeLayout(raw);
  assertValid(out);
  assert.equal(out.root.children[0].size, 200);
  assert.equal(out.root.children[2].size, SIZE_MAX);
  assert.equal(sizeEntry(out, findView(out, 'terminal').stackId).size, 120);
  const rounded = normalizeLayout({
    v: 1,
    root: spl(
      'split-1',
      'row',
      ch(stk('stack-1', LEFT), 333.6),
      ch(spl('split-2', 'col', ch(editor()), ch(stk('stack-2', BOTTOM), 222))),
      ch(stk('stack-3', CHAT), 380),
    ),
  });
  assert.equal(rounded.root.children[0].size, 334);
});

test('normalizeLayout repairs the flexible-child rule', () => {
  // Two null children, none holding the editor -> editor column is the flex child.
  const raw = {
    v: 1,
    root: spl(
      'split-1',
      'row',
      ch(stk('stack-1', LEFT), null),
      ch(spl('split-2', 'col', ch(editor(), 300), ch(stk('stack-2', BOTTOM), 220)), 640),
      ch(stk('stack-3', CHAT), null),
    ),
  };
  const out = normalizeLayout(raw);
  assertValid(out);
  assert.equal(out.root.children[1].size, null);
  assert.notEqual(out.root.children[0].size, null);
  assert.notEqual(out.root.children[2].size, null);
  assert.equal(out.root.children[1].node.children[0].size, null);

  // No editor-holding child with a null size and no editor in some split -> last child.
  const noEditorSplit = normalizeLayout({
    v: 1,
    root: spl(
      'split-1',
      'row',
      ch(spl('split-2', 'col', ch(stk('stack-1', LEFT), 200), ch(stk('stack-2', ['terminal']), 200)), 300),
      ch(editor(), 400),
      ch(stk('stack-3', CHAT), 380),
    ),
  });
  assertValid(noEditorSplit);
  const inner = noEditorSplit.root.children[0].node;
  assert.equal(inner.t, 'split');
  assert.equal(inner.children[0].size !== null, true);
  assert.equal(inner.children[1].size, null);
});

test('normalizeLayout fixes active, collapsed and editor stack fields', () => {
  const raw = {
    v: 1,
    root: spl(
      'split-1',
      'row',
      ch(stk('stack-1', LEFT, { active: 'terminal', collapsed: 'yes' }), 300),
      ch({ t: 'stack', id: 'editor-1', kind: 'editor', views: ['chat'], active: 'x', collapsed: true }),
      ch(stk('stack-3', [...BOTTOM, ...CHAT], { active: null }), 300),
    ),
  };
  const out = normalizeLayout(raw);
  assertValid(out);
  const left = stackOf(out, 'explorer');
  assert.equal(left.active, 'explorer');
  assert.equal(left.collapsed, false);
  const ed = collectNodes(out.root).find((n) => n.kind === 'editor');
  assert.deepEqual(ed.views, []);
  assert.equal(ed.active, null);
  assert.equal(ed.collapsed, false);
});

test('normalizeLayout regenerates clashing or invalid ids', () => {
  const raw = {
    v: 1,
    root: spl(
      'split-1',
      'row',
      ch(stk('stack-1', LEFT), 300),
      ch(spl('split-1', 'col', ch(editor()), ch(stk('stack-1', BOTTOM), 220))),
      ch(stk('', CHAT), 380),
    ),
  };
  const out = normalizeLayout(raw);
  assertValid(out);
  const ids = collectNodes(out.root).map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(findStack(out, 'stack-1').views[0], 'explorer');
  const again = normalizeLayout(out);
  assert.deepEqual(again, out);
});

test('normalizeLayout keeps up to MAX_EDITOR_GROUPS editor stacks', () => {
  const many = {
    v: 1,
    root: spl(
      'split-1',
      'row',
      ch(stk('stack-1', LEFT), 300),
      ch(editor('editor-1')),
      ch(editor('editor-2'), 400),
      ch(editor('editor-3'), 400),
      ch(editor('editor-4'), 400),
      ch(editor('editor-5'), 400),
    ),
  };
  const out = normalizeLayout(many);
  assertValid(out);
  assert.equal(collectNodes(out.root).filter((n) => n.kind === 'editor').length, MAX_EDITOR_GROUPS);
});

test('normalizeLayout rejects unsalvageable input', () => {
  assert.equal(normalizeLayout(null), null);
  assert.equal(normalizeLayout(undefined), null);
  assert.equal(normalizeLayout('layout'), null);
  assert.equal(normalizeLayout(42), null);
  assert.equal(normalizeLayout([]), null);
  assert.equal(normalizeLayout({}), null);
  assert.equal(normalizeLayout({ v: 2, root: editor() }), null);
  assert.equal(normalizeLayout({ v: 1 }), null);
  assert.equal(normalizeLayout({ v: 1, root: null }), null);
  // No editor stack anywhere.
  assert.equal(
    normalizeLayout({
      v: 1,
      root: spl('split-1', 'row', ch(stk('stack-1', LEFT), 300), ch(stk('stack-2', CHAT))),
    }),
    null,
  );
});

test('normalizeLayout rejects oversized and too-deep trees', () => {
  const children = [ch(editor())];
  for (let i = 0; i < 1000; i += 1) children.push(ch(stk(`stack-${i + 1}`, ['explorer']), 300));
  assert.equal(normalizeLayout({ v: 1, root: spl('split-1', 'row', ...children) }), null);

  let deep = editor();
  for (let i = 0; i < 8; i += 1) {
    deep = spl(`split-${i + 1}`, i % 2 ? 'row' : 'col', ch(deep), ch(stk(`stack-${i + 1}`, ['terminal']), 200));
  }
  assert.equal(normalizeLayout({ v: 1, root: deep }), null);

  const cyclic = { v: 1, root: spl('split-1', 'row') };
  cyclic.root.children.push({ node: cyclic.root, size: null });
  assert.equal(normalizeLayout(cyclic), null);
});

test('normalizeLayout never throws on random junk and always returns valid layouts', () => {
  const rand = mulberry32(20261006);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const junkValue = () =>
    pick([
      null,
      undefined,
      true,
      false,
      0,
      -1,
      1e12,
      NaN,
      Infinity,
      'row',
      'col',
      'stack',
      'split',
      '',
      'explorer',
      'chat',
      [],
      {},
      [1, 2, 3],
      { node: null },
    ]);
  const randomView = () => pick([...ALL_VIEWS, 'bogus', '', 3, null]);
  const randomNode = (depth) => {
    const r = rand();
    if (depth > 4 || r < 0.35) {
      const kind = rand() < 0.2 ? 'editor' : pick(['views', 'views', 'views', 'weird', 7]);
      const views = [];
      const n = Math.floor(rand() * 5);
      for (let i = 0; i < n; i += 1) views.push(randomView());
      return {
        t: rand() < 0.9 ? 'stack' : junkValue(),
        id: rand() < 0.7 ? `stack-${Math.floor(rand() * 4)}` : junkValue(),
        kind,
        views: rand() < 0.9 ? views : junkValue(),
        active: rand() < 0.5 ? pick(views.length ? views : [null]) : junkValue(),
        collapsed: rand() < 0.5 ? rand() < 0.5 : junkValue(),
      };
    }
    const kids = [];
    const n = Math.floor(rand() * 4);
    for (let i = 0; i < n; i += 1) {
      kids.push(
        rand() < 0.9
          ? { node: randomNode(depth + 1), size: rand() < 0.4 ? null : rand() < 0.8 ? rand() * 900 : junkValue() }
          : junkValue(),
      );
    }
    return {
      t: 'split',
      id: rand() < 0.7 ? `split-${Math.floor(rand() * 4)}` : junkValue(),
      dir: rand() < 0.9 ? pick(['row', 'col']) : junkValue(),
      children: rand() < 0.95 ? kids : junkValue(),
    };
  };
  let accepted = 0;
  for (let i = 0; i < 200; i += 1) {
    const raw = rand() < 0.1 ? junkValue() : { v: rand() < 0.95 ? 1 : junkValue(), root: randomNode(0) };
    let out;
    assert.doesNotThrow(() => {
      out = normalizeLayout(raw);
    });
    if (out === null) continue;
    accepted += 1;
    assertValid(out);
    assert.deepEqual(normalizeLayout(out), out, 'normalize is idempotent');
  }
  assert.ok(accepted >= 20, `fuzz produced only ${accepted} salvageable layouts`);
});
