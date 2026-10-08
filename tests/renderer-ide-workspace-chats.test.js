'use strict';

/* Workspace chats (row 40 W6b): pane 0's ledger index and Git links, the debounced marker
 * refresh, and the second chat (chat-2 / changes-2) joining the layout tree, hosting pane 1's
 * root and keeping its own unread cue. Real layout ops and Changes dock module; fake workbench
 * and pane composition. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../renderer/shared/workbench-layout-model');
const ops = require('../renderer/shared/workbench-layout-ops');
const dockChanges = require('../renderer/features/renderer-ide-chat-dock-changes');
const changesView = require('../renderer/features/renderer-changes-view');
const { createIdeWorkspaceChats } = require('../renderer/features/renderer-ide-workspace-chats');

const settle = () => new Promise((resolve) => setImmediate(resolve));

function turn(turnId, files = []) {
  return { turnId, files, rootMessageIds: { assistant: `a-${turnId}` }, toolCalls: [] };
}

function setup(t, opts = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="chatView"></div></body>');
  const doc = dom.window.document;
  const state = {
    currentSessionId: 's1',
    ui: { activeView: opts.activeView || 'ide' },
    features: { featureFlags: { ide_chat_dock: opts.flag !== false } },
    workspaceRoot: { rootId: 'ws' },
  };
  const turnsBySession = { s1: [turn('t1', ['a.js'])], p0: [], p1: [] };
  const ledgerCalls = [];
  const buildLedger = (vms, meta) => {
    ledgerCalls.push({ n: vms.length, meta });
    return { changes: vms.flatMap((vm) => vm.files.map((path) => ({ path, turnId: vm.turnId, fileKey: `ws:${path}` }))) };
  };

  // Fake workbench: a layout in a variable, a host element per view id.
  let layout = model.createDefaultLayout();
  const commits = [];
  const visible = { chat: false, 'chat-2': false, changes: false };
  const hosts = new Map();
  const hostFor = (id) => {
    if (!hosts.has(id)) {
      const el = doc.createElement('div');
      if (!opts.detachedHosts || !opts.detachedHosts.includes(id)) doc.body.appendChild(el);
      hosts.set(id, el);
    }
    return hosts.get(id);
  };
  const scmHost = doc.createElement('div');
  scmHost.innerHTML = '<div data-ide-scm-path="a.js"></div><div data-ide-scm-path="b.js"></div>';
  doc.body.appendChild(scmHost);
  const scrolled = [];
  scmHost.querySelectorAll('[data-ide-scm-path]').forEach((row) => {
    row.scrollIntoView = (arg) => scrolled.push([row.getAttribute('data-ide-scm-path'), arg]);
  });
  const shown = [];
  const wb = {
    getLayout: () => layout,
    replaceLayout: (next) => { layout = next; commits.push(next); },
    listViews: () => model.listViews(layout),
    viewDeps: (id) => ({ getMountEl: () => (id === 'source-control' ? scmHost : hostFor(id)) }),
    isVisible: (id) => visible[id] === true,
    showPanel: (id) => { shown.push(id); return true; },
  };

  // Fake pane composition: pane 1's root really moves between hosts.
  const panes = {
    count: opts.panes || 1,
    sessions: ['p0', 'p1'],
    projection: new Map(),
    hostCalls: [],
    docked: [],
    root: doc.createElement('section'),
    getPaneCount() { return this.count; },
    getPaneSessionId(i) { return this.sessions[i] || ''; },
    getPane(i) { return i === 1 ? { root: this.root } : null; },
    setPaneHost(i, host) {
      this.hostCalls.push([i, host]);
      (host || doc.getElementById('chatView')).appendChild(this.root);
    },
    handleChatDocked(v) { this.docked.push(v); },
    getSessionPaneTarget: () => ({ getProjectionContext: () => ({ viewModelByTurnId: panes.projection }) }),
  };
  doc.getElementById('chatView').appendChild(panes.root);

  const timers = { next: 1, pending: new Map(), cleared: [] };
  const git = {
    repo: true,
    changed: new Set(['a.js']),
    refreshes: 0,
    isRepo() { return this.repo; },
    getDecoration(path) { return this.changed.has(path) ? { badge: 'M' } : null; },
    subscribe: () => () => {},
    refreshJennyMarkers() { this.refreshes += 1; },
  };
  let renders = 0;
  let countChanges = 0;
  const mod = createIdeWorkspaceChats({
    state,
    getWorkbench: () => wb,
    getPaneComposition: () => (opts.noPanes ? null : panes),
    getTurnViewModels: (sid) => turnsBySession[sid] || [],
    getSessionMessages: () => [],
    buildLedger,
    getGitFeature: () => (opts.noGit ? null : git),
    viewDeps: opts.viewDeps || {},
    loadChangesView: async () => changesView,
    requestRender: () => { renders += 1; },
    onCountChange: () => { countChanges += 1; },
    setTimeout: (fn) => { const id = timers.next++; timers.pending.set(id, fn); return id; },
    clearTimeout: (id) => { timers.cleared.push(id); timers.pending.delete(id); },
    layoutOps: opts.layoutOpsDep === false ? undefined : ops,
    dockChanges: opts.dockChanges || dockChanges,
  });
  t.after(() => { mod.dispose(); dom.window.close(); });
  const fire = () => { const fns = Array.from(timers.pending.values()); timers.pending.clear(); fns.forEach((fn) => fn()); };
  return {
    doc, state, mod, wb, panes, git, timers, fire, visible, hosts, commits, shown, scrolled, turnsBySession, ledgerCalls,
    layout: () => layout,
    setLayout: (next) => { layout = next; },
    renders: () => renders,
    countChanges: () => countChanges,
  };
}

test('primarySessionId: current session with one pane, pane 0 with two even when the current is pane 1', (t) => {
  const f = setup(t);
  assert.equal(f.mod.primarySessionId(), 's1');
  f.panes.count = 2;
  f.state.currentSessionId = 'p1';
  assert.equal(f.mod.primarySessionId(), 'p0');
  assert.equal(f.mod.primaryViewDeps.getSessionId(), 'p0');
  const bare = setup(t, { noPanes: true });
  assert.equal(bare.mod.primarySessionId(), 's1', 'no pane composition falls back to the current session');
});

test('jennyChangeFor maps paths to the latest turn and file key, and is null with the dock flag off', (t) => {
  const f = setup(t);
  f.turnsBySession.s1 = [turn('t1', ['a.js']), turn('t2', ['a.js', 'b.js'])];
  assert.deepEqual(f.mod.jennyChangeFor('a.js'), { turnId: 't2', fileKey: 'ws:a.js' }, 'the later turn wins');
  assert.deepEqual(f.mod.jennyChangeFor('b.js'), { turnId: 't2', fileKey: 'ws:b.js' });
  assert.equal(f.mod.jennyChangeFor('zzz.js'), null);
  assert.deepEqual(f.ledgerCalls[0].meta, { sessionId: 's1', workspaceId: 'ws' });

  const off = setup(t, { flag: false });
  assert.equal(off.mod.jennyChangeFor('a.js'), null);
  assert.equal(off.ledgerCalls.length, 0, 'the ledger is not even built without the dock');
});

test('jennyChangeFor rebuilds when a turn is pushed onto the same array, and not otherwise', (t) => {
  const f = setup(t);
  assert.equal(f.mod.jennyChangeFor('b.js'), null);
  assert.equal(f.mod.jennyChangeFor('a.js').turnId, 't1');
  assert.equal(f.ledgerCalls.length, 1, 'unchanged turns reuse the index');
  f.turnsBySession.s1.push(turn('t2', ['b.js'])); // same array identity, grown in place
  assert.deepEqual(f.mod.jennyChangeFor('b.js'), { turnId: 't2', fileKey: 'ws:b.js' });
  assert.equal(f.ledgerCalls.length, 2);
  f.mod.jennyChangeFor('a.js');
  assert.equal(f.ledgerCalls.length, 2, 'stable again after the rebuild');
});

test('jennyChangeFor re-keys on a session change', (t) => {
  const f = setup(t);
  assert.equal(f.mod.jennyChangeFor('a.js').turnId, 't1');
  f.state.currentSessionId = 's2';
  assert.equal(f.mod.jennyChangeFor('a.js'), null, 's2 has no turns');
  assert.equal(f.ledgerCalls.length, 2);
  assert.equal(f.ledgerCalls[1].meta.sessionId, 's2');
  f.state.currentSessionId = 's1';
  assert.equal(f.mod.jennyChangeFor('a.js').turnId, 't1');
  assert.equal(f.ledgerCalls.length, 3, 'switching back rebuilds as well');
});

test('scheduleMarkerRefresh: one timer, refresh only when the path-to-change signature changed', (t) => {
  const f = setup(t);
  f.mod.scheduleMarkerRefresh();
  f.mod.scheduleMarkerRefresh();
  assert.equal(f.timers.pending.size, 1, 'one pending timer at a time');
  f.fire();
  assert.equal(f.git.refreshes, 1, 'first signature differs from the empty one');
  f.mod.scheduleMarkerRefresh();
  assert.equal(f.timers.pending.size, 1, 'a fired timer frees the slot');
  f.fire();
  assert.equal(f.git.refreshes, 1, 'same signature: no repaint');
  f.turnsBySession.s1.push(turn('t2', ['b.js']));
  f.mod.scheduleMarkerRefresh();
  f.fire();
  assert.equal(f.git.refreshes, 2, 'a new change repaints');
});

test('scheduleMarkerRefresh: no timer outside the Workspace, no refresh for an empty ledger, dispose clears it', (t) => {
  const out = setup(t, { activeView: 'chat' });
  out.mod.scheduleMarkerRefresh();
  assert.equal(out.timers.pending.size, 0);

  const empty = setup(t);
  empty.turnsBySession.s1 = [];
  empty.mod.scheduleMarkerRefresh();
  empty.fire();
  assert.equal(empty.git.refreshes, 0, 'nothing to mark, nothing to repaint');

  const f = setup(t);
  f.mod.scheduleMarkerRefresh();
  assert.equal(f.timers.pending.size, 1);
  f.mod.dispose();
  assert.equal(f.timers.pending.size, 0);
  assert.equal(f.timers.cleared.length, 1);
  f.mod.scheduleMarkerRefresh();
  assert.equal(f.timers.pending.size, 0, 'nothing schedules after dispose');
  assert.equal(f.git.refreshes, 0);
});

test('openInGit shows Source Control and scrolls the matching row; an unknown path scrolls nothing', (t) => {
  const f = setup(t);
  f.mod.openInGit('b.js');
  assert.deepEqual(f.shown, ['source-control']);
  assert.deepEqual(f.scrolled, [['b.js', { block: 'nearest' }]]);
  f.mod.openInGit('nope.js');
  f.mod.openInGit(undefined);
  assert.deepEqual(f.shown, ['source-control', 'source-control', 'source-control']);
  assert.equal(f.scrolled.length, 1, 'no row matched, no scroll');
});

test('getGitState: changed, clean, and null for a non-repo or a missing git feature', (t) => {
  const f = setup(t);
  assert.equal(f.mod.primaryViewDeps.getGitState('a.js'), 'changed');
  assert.equal(f.mod.primaryViewDeps.getGitState('b.js'), 'clean');
  f.git.repo = false;
  assert.equal(f.mod.primaryViewDeps.getGitState('a.js'), null);
  const none = setup(t, { noGit: true });
  assert.equal(none.mod.primaryViewDeps.getGitState('a.js'), null);
  assert.equal(none.mod.primaryViewDeps.subscribeGit(() => {}), null);
  assert.equal(typeof f.mod.primaryViewDeps.subscribeGit(() => {}), 'function');
});

test('reconcileLayout does nothing with one pane or the flag off', (t) => {
  const one = setup(t);
  assert.equal(one.mod.reconcileLayout(), false);
  assert.equal(one.commits.length, 0);
  const off = setup(t, { panes: 2, flag: false });
  assert.equal(off.mod.reconcileLayout(), false);
  assert.equal(off.commits.length, 0);
  const noSession = setup(t, { panes: 2 });
  noSession.panes.sessions[1] = '';
  assert.equal(noSession.mod.reconcileLayout(), false, 'pane 1 without a session is not a chat');
});

test('reconcileLayout adds chat-2 and changes-2 together in their own col stack below chat, once', (t) => {
  const f = setup(t, { panes: 2 });
  const before = f.layout();
  const chatStackId = model.findView(before, 'chat').stackId;
  assert.equal(f.mod.reconcileLayout(), true);
  assert.equal(f.commits.length, 1);
  const after = f.layout();
  const chat2 = model.findView(after, 'chat-2');
  assert.notEqual(chat2.stackId, chatStackId, 'its own stack');
  assert.deepEqual(model.findStack(after, chat2.stackId).views, ['chat-2', 'changes-2'], 'like the first chat\'s Chat | Changes');
  assert.equal(model.findStack(after, chat2.stackId).active, 'chat-2');
  const wrapper = after.root.children.map((c) => c.node).find((n) => n.t === 'split' && n.children.some((k) => k.node.id === chatStackId));
  assert.equal(wrapper.dir, 'col');
  assert.deepEqual(wrapper.children.map((c) => c.node.id), [chatStackId, chat2.stackId], 'below chat');
  assert.deepEqual(model.findStack(after, chatStackId).views, ['chat', 'changes'], 'the first chat\'s stack is untouched');
  assert.equal(f.mod.reconcileLayout(), false, 'idempotent');
  assert.equal(f.commits.length, 1);
});

test('a view missing alone joins the other: changes-2 removed by hand comes back beside chat-2', (t) => {
  const f = setup(t, { panes: 2 });
  f.mod.reconcileLayout();
  f.setLayout(ops.removeView(f.layout(), 'changes-2'));
  assert.equal(f.mod.reconcileLayout(), true);
  const after = f.layout();
  assert.equal(model.findView(after, 'changes-2').stackId, model.findView(after, 'chat-2').stackId);
});

test('reconcileLayout does not re-add chat-2 after the user moved it', (t) => {
  const f = setup(t, { panes: 2 });
  f.mod.reconcileLayout();
  const explorerStack = model.findView(f.layout(), 'explorer').stackId;
  const moved = ops.moveView(f.layout(), 'chat-2', { stackId: explorerStack });
  assert.notEqual(moved, f.layout());
  f.setLayout(moved);
  assert.equal(model.findView(moved, 'chat-2').stackId, explorerStack);
  assert.equal(f.mod.reconcileLayout(), false);
  assert.equal(f.commits.length, 1, 'the user move is not ours to commit');
  assert.equal(model.listViews(f.layout()).filter((id) => id === 'chat-2').length, 1);
  assert.equal(model.findView(f.layout(), 'chat-2').stackId, explorerStack, 'still where the user put it');
});

test('the second chat joins below the first without squeezing it to its floor', (t) => {
  const f = setup(t, { panes: 2 });
  const stack = f.doc.createElement('div');
  stack.setAttribute('data-wb-stack', 'S');
  stack.getBoundingClientRect = () => ({ width: 380, height: 780 });
  f.doc.body.appendChild(stack);
  stack.appendChild(f.wb.viewDeps('chat').getMountEl());
  assert.equal(f.mod.reconcileLayout(), true);
  const col = f.layout().root.children.find((c) => c.node.t === 'split' && c.node.dir === 'col'
    && c.node.children.some((k) => k.node.views && k.node.views.includes('chat-2'))).node;
  assert.equal(col.children[0].size, 460, 'Chat 1 keeps its height less the second chat');
});

test('the layout ops resolve from the browser global the IDE manifest loads (jennyWorkbenchLayoutOps)', (t) => {
  const used = [];
  const spy = { ...ops, addStackBeside: (...args) => { used.push('addStackBeside'); return ops.addStackBeside(...args); } };
  globalThis.jennyWorkbenchLayoutOps = spy;
  t.after(() => { delete globalThis.jennyWorkbenchLayoutOps; });
  const f = setup(t, { panes: 2, layoutOpsDep: false });
  assert.equal(f.mod.reconcileLayout(), true);
  assert.deepEqual(used, ['addStackBeside'], 'the renderer global, not a CommonJS fallback');
  assert.ok(model.listViews(f.layout()).includes('chat-2'));
});

test('sync in the Workspace: the first pass requests a render (deferred, never re-entrant), the next hosts pane 1 in chat-2', async (t) => {
  const f = setup(t, { panes: 2 });
  f.mod.sync();
  assert.equal(f.renders(), 0, 'not inside the render that synced');
  await settle();
  assert.equal(f.renders(), 1);
  assert.equal(f.panes.hostCalls.length, 0, 'not hosted before the views exist');
  assert.equal(f.panes.root.parentElement.id, 'chatView');
  f.mod.sync();
  assert.equal(f.renders(), 1, 'no further render once the tree is stable');
  assert.equal(f.panes.root.parentElement, f.hosts.get('chat-2'));
  assert.deepEqual(f.panes.hostCalls, [[1, f.hosts.get('chat-2')]]);
  assert.equal(f.state.ui.ideSecondChatHosted, true, 'pane visibility reads Chat 2 as live');
  assert.deepEqual(f.panes.docked, [], 'chat is not visible: pane 0 keeps nothing to reclaim');
  f.visible.chat = true;
  f.mod.sync();
  assert.deepEqual(f.panes.docked, [true]);
});

test('sync outside the Workspace puts pane 1 back in the chat view', async (t) => {
  const f = setup(t, { panes: 2 });
  f.mod.sync();
  await settle();
  f.mod.sync();
  assert.equal(f.panes.root.parentElement, f.hosts.get('chat-2'));
  f.state.ui.activeView = 'chat';
  f.visible.chat = true;
  f.mod.sync();
  assert.deepEqual(f.panes.hostCalls[f.panes.hostCalls.length - 1], [1, null]);
  assert.equal(f.panes.root.parentElement.id, 'chatView');
  assert.equal(f.panes.docked.length, 0, 'handleChatDocked only while hosted');
  assert.equal(f.state.ui.ideSecondChatHosted, false);
  assert.equal(f.renders(), 1);
});

test('the second ledger, its session check and Reveal Chat 2', (t) => {
  const f = setup(t, { panes: 2 });
  f.panes.projection.set('t9', turn('t9', ['z.js']));
  const ledger = f.mod.secondLedger();
  assert.deepEqual(ledger.changes.map((c) => c.path), ['z.js']);
  assert.deepEqual(f.ledgerCalls.at(-1).meta, { sessionId: 'p1', workspaceId: 'ws' });
  assert.equal(f.mod.isSecondSession('p1'), true);
  assert.equal(f.mod.isSecondSession('p0'), false);
  assert.equal(f.mod.revealSecondChat(), true);
  assert.equal(f.shown.at(-1), 'chat-2');
  f.panes.count = 1;
  assert.equal(f.mod.isSecondSession('p1'), false, 'no second chat');
});

test('pane 1\'s own renders sync Chat 2 through the composition listener; dispose releases it', async (t) => {
  const f = setup(t, { panes: 2 });
  let listener = null;
  f.panes.setPaneRenderListener = (fn) => { listener = fn; };
  f.mod.sync();
  await settle();
  f.mod.sync();
  assert.equal(typeof listener, 'function');
  f.mod.sync(); // first observation of pane 1's chat
  f.panes.projection.set('t2', turn('t2'));
  listener(1);
  assert.equal(f.mod.hasSecondUnread(), true, 'a pane 1 render alone raises the dot');
  f.mod.dispose();
  assert.equal(listener, null);
});

test('sync never hosts pane 1 in a disconnected host', (t) => {
  const f = setup(t, { panes: 2, detachedHosts: ['chat-2'] });
  f.mod.sync();
  f.visible.chat = true;
  f.mod.sync();
  assert.deepEqual(f.panes.hostCalls, [[1, null]]);
  assert.equal(f.panes.root.parentElement.id, 'chatView');
  assert.equal(f.panes.docked.length, 0);
});

test('isAvailable follows the flag and pane 1 having a session', (t) => {
  const f = setup(t);
  assert.equal(f.mod.isAvailable('chat'), true);
  assert.equal(f.mod.isAvailable('chat-2'), false, 'one pane');
  f.panes.count = 2;
  assert.equal(f.mod.isAvailable('chat-2'), true);
  assert.equal(f.mod.isAvailable('changes-2'), true);
  assert.equal(f.mod.isAvailable('changes'), true);
  f.panes.sessions[1] = '';
  assert.equal(f.mod.isAvailable('chat-2'), false);
  f.panes.sessions[1] = 'p1';
  f.state.features.featureFlags.ide_chat_dock = false;
  assert.equal(f.mod.isAvailable('changes-2'), false, 'flag off');
});

test('chat-2 unread: new activity in pane 1 while chat-2 is hidden, cleared when it shows', (t) => {
  const f = setup(t, { panes: 2 });
  f.mod.sync(); // reconcile
  f.mod.sync(); // first observation
  assert.equal(f.mod.hasSecondUnread(), false);
  f.panes.projection.set('t2', turn('t2'));
  f.mod.sync(); // change
  assert.equal(f.mod.hasSecondUnread(), true);
  assert.equal(f.countChanges(), 1, 'the chrome repaints once');
  f.visible['chat-2'] = true;
  assert.equal(f.mod.hasSecondUnread(), false, 'clears as soon as chat-2 shows');
  f.mod.sync();
  assert.equal(f.mod.hasSecondUnread(), false);
});

test('chat-2 unread: activity outside the Workspace is not news', (t) => {
  const f = setup(t, { panes: 2, activeView: 'chat' });
  f.mod.sync();
  f.panes.projection.set('t2', turn('t2'));
  f.mod.sync();
  assert.equal(f.mod.hasSecondUnread(), false);
  assert.equal(f.countChanges(), 0);
});

test('second Changes: waiting count is zero without a client; reveal needs a second chat', async (t) => {
  const f = setup(t);
  assert.equal(f.mod.secondWaitingCount(), 0);
  assert.equal(f.mod.revealSecondChanges({}), false, 'one pane');
  assert.deepEqual(f.shown, []);
  f.panes.count = 2;
  assert.equal(f.mod.revealSecondChanges({}), true);
  assert.deepEqual(f.shown, ['changes-2']);
  await settle();
});

test('dispose puts pane 1 back, stops syncing, and is idempotent', (t) => {
  const f = setup(t, { panes: 2 });
  f.mod.sync();
  f.mod.sync();
  assert.equal(f.panes.root.parentElement, f.hosts.get('chat-2'));
  f.mod.dispose();
  assert.deepEqual(f.panes.hostCalls[f.panes.hostCalls.length - 1], [1, null]);
  assert.equal(f.panes.root.parentElement.id, 'chatView');
  const calls = f.panes.hostCalls.length;
  f.mod.dispose();
  assert.equal(f.panes.hostCalls.length, calls, 'second dispose is a no-op');
  f.mod.sync();
  assert.equal(f.panes.hostCalls.length, calls, 'sync after dispose is inert');
  assert.equal(f.mod.reconcileLayout(), false);
});

test('each Changes view names its chat pane on the diffs it opens (W7c binding)', (t) => {
  const calls = [];
  let secondDeps = null;
  const f = setup(t, {
    viewDeps: {
      openChangeDiff: (change, origin) => calls.push(['change', change.path, origin]),
      openSuggestionDiff: (sessionId, id, origin) => calls.push(['suggestion', id, origin]),
    },
    dockChanges: { createChatDockChanges: (d) => { secondDeps = d.viewDeps; return { sync() {}, dispose() {} }; } },
  });
  f.mod.primaryViewDeps.openChangeDiff({ path: 'a.js' });
  f.mod.primaryViewDeps.openSuggestionDiff('s1', 'sg1');
  secondDeps.openChangeDiff({ path: 'b.js' });
  secondDeps.openSuggestionDiff('p1', 'sg2');
  assert.deepEqual(calls, [
    ['change', 'a.js', { pane: 0 }], ['suggestion', 'sg1', { pane: 0 }],
    ['change', 'b.js', { pane: 1 }], ['suggestion', 'sg2', { pane: 1 }],
  ]);
});
