'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const model = require('../renderer/shared/workbench-layout-model');
const ops = require('../renderer/shared/workbench-layout-ops');
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
  assert.deepEqual(stackOf(out, 'terminal').views, ['terminal', 'problems', 'run', 'test-runner', 'test-output', 'activity']);
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
    'row(explorer+search+source-control,col(E,terminal+problems+run+test-runner+test-output+activity),chat+changes!)',
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
    'row(explorer+search+source-control,col(E,terminal+problems+run+test-runner+test-output+activity!),chat+changes!)',
  );
  const out2 = normalizeLayout({
    v: 1,
    root: spl('split-1', 'col', ch(editor()), ch(stk('stack-1', BOTTOM), 200)),
  });
  assertValid(out2);
  assert.equal(
    shape(out2.root),
    'row(explorer+search+source-control,col(E,terminal+problems+run+test-runner+test-output+activity),chat+changes!)',
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

/* ---------- Board profile (row 150): a second view list for the Board page's workbench ---------- */

const WORKSPACE_ONLY = ['explorer', 'search', 'source-control', 'terminal', 'problems', 'run', 'test-runner', 'test-output', 'activity'];

test('board profile: the default layout is boards | canvas | chat + changes, with nothing from the Workspace', () => {
  const layout = createDefaultLayout('board');
  assert.equal(layout.profile, 'board');
  assert.equal(shape(layout.root), 'row(boards,E,chat+changes)');
  assert.deepEqual(model.listViews(layout), ['boards', 'chat', 'changes']);
  assert.equal(stackOf(layout, 'chat').collapsed, false, 'the chat is docked open on a new Board');
  assert.equal(layout.bind, undefined);
  assert.deepEqual(normalizeLayout(layout, 'board'), layout, 'normalize is idempotent');
});

test('board profile: normalizing never gains a Workspace view and drops any it is handed', () => {
  const raw = {
    v: 1,
    profile: 'board',
    root: spl('split-1', 'row',
      ch(stk('stack-1', ['boards', 'explorer', 'terminal-2'], { active: 'explorer' }), 260),
      ch(editor(), null),
      ch(stk('stack-2', ['chat', 'changes', 'outline'], { active: 'chat', collapsed: true }), 400)),
    bind: { chat: 'editor-1' },
  };
  const out = normalizeLayout(raw, 'board');
  assert.equal(out.profile, 'board');
  assert.equal(shape(out.root), 'row(boards,E,chat+changes!)');
  assert.equal(stackOf(out, 'boards').active, 'boards');
  assert.equal(stackOf(out, 'chat').active, 'chat');
  assert.equal(out.bind, undefined, 'a Board layout has no editor-group bindings');
  WORKSPACE_ONLY.forEach((id) => assert.equal(findView(out, id), null, id));
});

test('board profile: one canvas only, and a lost view is re-homed on its own side', () => {
  const twoEditors = normalizeLayout({ v: 1, root: spl('split-1', 'row', ch(editor('editor-1'), null), ch(editor('editor-2'), 400)) }, 'board');
  assert.equal(shape(twoEditors.root), 'row(boards,E,chat+changes!)', 'the second canvas is dropped; boards left, chat right');
  assert.equal(collectNodes(twoEditors.root).filter((n) => n.kind === 'editor').length, 1);

  const lostChanges = normalizeLayout({
    v: 1,
    root: spl('split-1', 'row', ch(stk('stack-1', ['boards']), 240), ch(editor(), null), ch(stk('stack-2', ['chat']), 380)),
  }, 'board');
  assert.equal(shape(lostChanges.root), 'row(boards,E,chat+changes)', 'changes rejoins the chat stack');
});

test('board profile: the Workspace normalizer ignores a profile field and Board-only views', () => {
  const smuggled = createDefaultLayout('board');
  const out = normalizeLayout(JSON.parse(JSON.stringify(smuggled)));
  assert.equal(out.profile, undefined, 'a stored Workspace layout cannot turn itself into a Board layout');
  assert.equal(findView(out, 'boards'), null);
  ALL_VIEWS.forEach((id) => assert.notEqual(findView(out, id), null, id));
  assert.equal(createDefaultLayout().profile, undefined);
  assert.deepEqual(createDefaultLayout('nonsense'), createDefaultLayout(), 'an unknown profile name is the Workspace');
});

test('board profile: the solver sizes the three columns and honours a collapsed chat', () => {
  const layout = createDefaultLayout('board');
  const open = model.solveLayout(layout, { width: 1400, height: 800 });
  const boards = stackOf(layout, 'boards');
  const chat = stackOf(layout, 'chat');
  assert.equal(open.sizes[boards.id], sizeEntry(layout, boards.id).size);
  assert.equal(open.sizes[chat.id], sizeEntry(layout, chat.id).size);
  const folded = model.solveLayout(model.setCollapsed(layout, chat.id, true), { width: 1400, height: 800 });
  assert.equal(folded.sizes[chat.id], model.STRIP_SIZE);
});

/* ---------- Chat profile (row 190): the Chat room's workbench ---------- */

const CHAT_RIGHT = ['session', 'artifacts', 'changes', 'project'];

test('chat profile: the default layout is chats | panes | the right stack open on Session', () => {
  const layout = createDefaultLayout('chat');
  assert.equal(layout.profile, 'chat');
  assert.equal(shape(layout.root), `row(chats,E,${CHAT_RIGHT.join('+')})`);
  assert.equal(stackOf(layout, 'session').active, 'session');
  assert.equal(stackOf(layout, 'session').collapsed, false, 'a fresh profile starts with the right stack open');
  assert.equal(sizeEntry(layout, stackOf(layout, 'session').id).size, 340);
  assert.equal(layout.bind, undefined);
  assert.deepEqual(normalizeLayout(layout, 'chat'), layout, 'normalize is idempotent');
});

test('chat profile: never admits a Workspace or Board view, keeps its optional views, one centre only', () => {
  const raw = {
    v: 1,
    root: spl('split-1', 'row',
      ch(stk('stack-1', ['chats', 'explorer', 'boards'], { active: 'explorer' }), 300),
      ch(editor('editor-1'), null),
      ch(editor('editor-2'), 300),
      ch(stk('stack-2', ['session', 'chat', 'terminal', 'browser', 'outline', 'terminal-2'], { active: 'browser' }), 360)),
    bind: { terminal: 'editor-1' },
  };
  const out = normalizeLayout(raw, 'chat');
  assert.equal(out.profile, 'chat');
  assert.equal(collectNodes(out.root).filter((n) => n.kind === 'editor').length, 1);
  assert.deepEqual(model.listViews(out), ['chats', 'session', 'terminal', 'browser', 'artifacts', 'changes', 'project']);
  assert.equal(stackOf(out, 'session').active, 'browser', 'an optional view keeps its place and its active state');
  assert.equal(stackOf(out, 'chats').active, 'chats');
  assert.equal(out.bind, undefined);
  ['explorer', 'boards', 'chat', 'outline', 'terminal-2'].forEach((id) => assert.equal(findView(out, id), null, id));
});

test('chat profile: the Workspace and Board normalizers never admit a Chat-only view', () => {
  // Artifacts, Project and Runs are side panel views in the Workspace and the Board too (Wave 4, row 195).
  const chatOnly = ['chats', 'session', 'preview', 'browser', 'live-view'];
  const smuggled = JSON.parse(JSON.stringify(createDefaultLayout('chat')));
  const ws = normalizeLayout(smuggled);
  const board = normalizeLayout(smuggled, 'board');
  assert.equal(ws.profile, undefined);
  assert.equal(board.profile, 'board');
  chatOnly.forEach((id) => {
    assert.equal(findView(ws, id), null, `workspace: ${id}`);
    assert.equal(findView(board, id), null, `board: ${id}`);
  });
  ['tasks', 'notes'].forEach((id) => assert.equal(findView(board, id), null, `board: ${id}`));
  assert.deepEqual(model.CHAT_VIEW_IDS, ['chats', ...CHAT_RIGHT]);
  assert.deepEqual(model.CHAT_OPTIONAL_VIEW_IDS, ['preview', 'browser', 'live-view', 'terminal', 'runs', 'activity']);
});

test('chat profile: a lost fixed view is re-homed into the right stack; an optional one is not', () => {
  const out = normalizeLayout({
    v: 1,
    root: spl('split-1', 'row', ch(stk('stack-1', ['chats']), 320), ch(editor(), null), ch(stk('stack-2', ['project']), 340)),
  }, 'chat');
  assert.equal(shape(out.root), 'row(chats,E,project+session+artifacts+changes)');
  // Row 195: the tabs Project and Runs replaced are no longer views of the room.
  ['tasks', 'notes', 'helpers', 'background'].forEach((id) => assert.equal(findView(normalizeLayout({ v: 1, root: spl('split-1', 'row', ch(stk('stack-1', ['chats']), 320), ch(editor(), null), ch(stk('stack-2', ['session', id]), 340)) }, 'chat'), id), null, id));
  assert.equal(findView(out, 'browser'), null);
  const noLeft = normalizeLayout({ v: 1, root: editor() }, 'chat');
  assert.equal(shape(noLeft.root), `row(chats,E,${CHAT_RIGHT.join('+')}!)`, 'a bare centre regains both stacks');
});

test('row 190 Wave 4: side panel views are optional in the Workspace and the Board: kept where stored, never re-homed, closable', () => {
  const ws = createDefaultLayout();
  assert.equal(findView(ws, 'artifacts'), null, 'the default Workspace has none');
  const withArtifacts = ops.addView(ws, 'artifacts', 'chat');
  const stored = normalizeLayout(JSON.parse(JSON.stringify(withArtifacts)));
  assert.ok(findView(stored, 'artifacts'), 'a stored Artifacts tab survives');
  assert.equal(findView(ops.removeView(stored, 'artifacts'), 'artifacts'), null, 'and its Close takes it out');
  assert.ok(findView(ops.addView(stored, 'project', 'artifacts'), 'project'));
  assert.equal(findView(ops.addView(stored, 'notes', 'artifacts'), 'notes'), null, 'row 195: Notes is inside Project');
  const board = createDefaultLayout('board');
  const boardArtifacts = normalizeLayout(JSON.parse(JSON.stringify(ops.addView(board, 'artifacts', 'chat'))), 'board');
  assert.ok(findView(boardArtifacts, 'artifacts'));
  assert.equal(findView(normalizeLayout(ops.addView(boardArtifacts, 'tasks', 'artifacts'), 'board'), 'tasks'), null, 'the Board has no Tasks view');
  assert.ok(findView(normalizeLayout(JSON.parse(JSON.stringify(ops.addView(boardArtifacts, 'runs', 'artifacts'))), 'board'), 'runs'), 'row 195: Runs opens beside a board');
});
