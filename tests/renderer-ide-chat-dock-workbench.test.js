'use strict';

/* Chat dock inside the workbench (row 40 W3): with deps.workbench the chat stack owns
 * open/close, the Chat | Changes tabs and collapse; the dock keeps the session row and
 * the transcript relocation, and Changes mounts into its own view host. The legacy
 * (no-workbench) behaviour stays covered by renderer-ide-chat-dock*.test.js. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeChatDock } = require('../renderer/features/renderer-ide-chat-dock');
const changesViewModule = require('../renderer/features/renderer-changes-view');

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, opts = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <section id="chatView">
      <div id="chatThreadStage"><div id="chatThreadScroll"><div id="chatTimeline"></div></div></div>
      <div id="composerWrap"><textarea id="chatInput"></textarea></div>
      <div id="artifactReviewResizer"></div>
    </section>
    <div id="ideShell">
      <div id="ideMain"><div id="ideEditorHost" tabindex="0"></div></div>
      <div id="wbView-changes"></div>
      <aside id="ideChatDock" class="hidden">
        <header id="ideChatDockHeader"></header>
        <div id="ideChatDockBody"></div>
      </aside>
    </div>
  </body>`);
  const doc = dom.window.document;
  const byId = (id) => doc.getElementById(id);
  const state = {
    ui: { activeView: 'ide' },
    features: { featureFlags: { ide_chat_dock: true } },
    sessions: [{ id: 's1', title: 'One', session_type: 'chat' }],
    currentSessionId: 's1',
  };

  // ide.chatDockOpen is the DERIVED mirror in workbench mode: reads follow the stub's
  // chat stack, and any write by the dock is recorded as a failure.
  const mirror = { open: opts.open === true };
  const writes = [];
  const ide = { chatDockSide: 'right', chatDockWidth: 380 };
  Object.defineProperty(ide, 'chatDockOpen', {
    get: () => mirror.open,
    set: (value) => { writes.push(value); },
    enumerable: true,
  });

  const wb = {
    setOpenCalls: [],
    revealCalls: [],
    countChanges: 0,
    visible: { chat: opts.open === true, changes: false },
    setOpen(open) {
      this.setOpenCalls.push(open);
      mirror.open = open;
      this.visible.chat = open;
      dock.reconcile();
    },
    reveal(id) {
      this.revealCalls.push(id);
      mirror.open = true;
      this.visible.chat = id === 'chat';
      this.visible.changes = id === 'changes';
      dock.reconcile();
      return true;
    },
    isVisible(id) {
      return this.visible[id] === true;
    },
    getChangesHost: () => byId('wbView-changes'),
    onCountChange() {
      this.countChanges += 1;
    },
  };

  const turns = [{ turnId: 't1', rootMessageIds: { user: 'u1', assistant: 'a1' }, user: { content: 'Fix it' }, toolCalls: [] }];
  const changes = [{ changeId: 'c1', turnId: 't1', path: 'a.js', fileKey: 'ws:a.js', toolName: 'edit_file', status: 'modified', hunks: [] }];
  const opened = [];
  let pending = 3;
  const listeners = [];
  const client = {
    get: () => ({ pending_count: pending, entries: [] }),
    getCurrent: () => '',
    activity: () => ({ generating: false }),
    subscribe: (cb) => { listeners.push(cb); return () => {}; },
  };

  const dock = createIdeChatDock({
    state,
    getDom: () => ({
      ideShell: byId('ideShell'),
      ideChatDock: byId('ideChatDock'),
      ideChatDockHeader: byId('ideChatDockHeader'),
      ideChatDockBody: byId('ideChatDockBody'),
    }),
    getIde: () => ide,
    requestRender: () => dock.reconcile(),
    schedulePersist: () => { writes.push('persist'); },
    windowRef: dom.window,
    workbench: wb,
    revealSecondChanges: opts.revealSecondChanges,
    changesView: opts.noChanges ? undefined : {
      loadChangesView: async () => changesViewModule,
      getSuggestedClient: () => client,
      viewDeps: {
        getTurnViewModels: () => turns,
        buildLedger: () => ({ changes, notices: [] }),
        getSessionId: () => state.currentSessionId,
        openChangeDiff: (change) => opened.push(change.changeId),
      },
    },
  });
  dock.bindEvents();
  t.after(() => {
    dock.dispose?.();
    dom.window.close();
  });
  return {
    dom, doc, byId, state, dock, wb, writes, ide, listeners, mirror, opened, turns,
    setPending: (n) => { pending = n; },
    header: () => byId('ideChatDockHeader'),
    changesHost: () => byId('wbView-changes'),
  };
}

test('open() and close() go through workbench.setOpen and never write ide.chatDockOpen', (t) => {
  const f = setup(t);
  f.dock.open();
  assert.deepEqual(f.wb.setOpenCalls, [true]);
  assert.equal(f.byId('composerWrap').parentNode, f.byId('ideChatDockBody'), 'the chat nodes dock once the chat stack is open');
  assert.equal(f.byId('ideChatDock').classList.contains('hidden'), false);

  f.dock.close();
  assert.deepEqual(f.wb.setOpenCalls, [true, false]);
  assert.equal(f.byId('composerWrap').parentNode, f.byId('chatView'), 'the chat nodes return home when the stack closes');
  assert.deepEqual(f.writes, [], 'the dock wrote neither ide.chatDockOpen nor scheduled its own persist');
});

test('toggle() flips the chat stack through setOpen', (t) => {
  const f = setup(t);
  f.dock.toggle();
  assert.deepEqual(f.wb.setOpenCalls, [true]);
  f.dock.toggle();
  assert.deepEqual(f.wb.setOpenCalls, [true, false]);
  assert.deepEqual(f.writes, []);
});

test('open() is a no-op while the dock flag is off', (t) => {
  const f = setup(t);
  f.state.features.featureFlags.ide_chat_dock = false;
  f.dock.open();
  assert.deepEqual(f.wb.setOpenCalls, []);
});

test('the header is the session row and New chat only: no Chat | Changes tabs and no collapse chevron', (t) => {
  const f = setup(t, { open: true });
  f.dock.reconcile();
  const header = f.header();
  assert.ok(header.querySelector('[data-ide-chatdock-session-trigger]'), 'session picker present');
  assert.ok(header.querySelector('[data-ide-chatdock-new-chat]'), 'New chat present');
  assert.equal(header.querySelector('[role="tablist"]'), null);
  assert.equal(header.querySelector('[data-ide-chatdock-tab]'), null);
  assert.equal(header.querySelector('[data-ide-chatdock-collapse]'), null);
});

test('Changes mounts into getChangesHost only while isVisible(changes), and unmounts when hidden', async (t) => {
  const f = setup(t, { open: true });
  f.dock.reconcile();
  assert.equal(f.changesHost().querySelector('.changes-view'), null, 'nothing mounts while the view is hidden');

  f.wb.visible.changes = true;
  f.dock.reconcile();
  await settle();
  const view = f.changesHost().querySelector('.changes-view');
  assert.ok(view, 'the Changes view mounts into the workbench host');
  assert.equal(view.getAttribute('data-changes-view'), 'dock');
  assert.equal(f.byId('ideChatDockBody').querySelector('.changes-view'), null, 'and not into the dock body');
  assert.equal(f.byId('ideChatDockChangesPanel'), null, 'the legacy overlay panel is not created');

  f.changesHost().querySelector('[data-changes-item]').click();
  assert.deepEqual(f.opened, ['c1'], 'while mounted the host is live');

  f.wb.visible.changes = false;
  f.dock.reconcile();
  f.changesHost().querySelector('[data-changes-item]').click();
  assert.deepEqual(f.opened, ['c1'], 'hiding the view unmounts it: its handlers are detached from the host');

  f.wb.visible.changes = true;
  f.dock.reconcile();
  await settle();
  f.changesHost().querySelector('[data-changes-item]').click();
  assert.deepEqual(f.opened, ['c1', 'c1'], 'showing it again remounts');
});

test('Changes can be visible while the chat stack is collapsed (they may sit in another stack)', async (t) => {
  const f = setup(t, { open: false });
  f.wb.visible.changes = true;
  f.dock.reconcile();
  await settle();
  assert.ok(f.changesHost().querySelector('.changes-view'), 'mount follows the view visibility, not the chat dock open state');
});

test('toggleChangesTab reveals the other view', async (t) => {
  const f = setup(t, { open: true });
  f.dock.reconcile();
  assert.equal(f.dock.toggleChangesTab(), true);
  assert.deepEqual(f.wb.revealCalls, ['changes']);
  await settle();
  assert.ok(f.changesHost().querySelector('.changes-view'));

  assert.equal(f.dock.toggleChangesTab(), true);
  assert.deepEqual(f.wb.revealCalls, ['changes', 'chat'], 'toggling again goes back to Chat');
  assert.equal(f.wb.isVisible('changes'), false);
  f.changesHost().querySelector('[data-changes-item]').click();
  assert.deepEqual(f.opened, [], 'the Changes view unmounted when Chat came back');
  assert.deepEqual(f.writes, []);
});

test('revealChanges reveals the changes view while docked; openChanges reveals it without opening the chat', async (t) => {
  const f = setup(t);
  assert.equal(f.dock.revealChanges({}), false, 'closed dock: the review shows in the side panel instead');
  assert.deepEqual(f.wb.revealCalls, []);

  assert.equal(f.dock.openChanges({}), true);
  assert.deepEqual(f.wb.setOpenCalls, [], 'the chat stack stays as it is (Changes may sit in another stack)');
  assert.deepEqual(f.wb.revealCalls, ['changes']);
  await settle();
  assert.ok(f.changesHost().querySelector('.changes-view'));

  assert.equal(f.dock.revealChanges({ turnId: 't1' }), true);
  assert.equal(f.wb.revealCalls.at(-1), 'changes');
});

test('revealChanges from Chat 2 (secondChat) opens Changes 2, never the first chat\'s Changes', (t) => {
  const asked = [];
  const f = setup(t, { open: true, revealSecondChanges: (target) => { asked.push(target); return true; } });
  assert.equal(f.dock.revealChanges({ turnId: 't9', secondChat: true }), true);
  assert.deepEqual(asked, [{ turnId: 't9', secondChat: true }]);
  assert.deepEqual(f.wb.revealCalls, [], 'the first Changes is not revealed');
  const g = setup(t, { open: true });
  assert.equal(g.dock.revealChanges({ secondChat: true }), false, 'no second chat wiring: nothing opens');
});

test('getChangesWaitingCount reports pending suggestions and onCountChange fires when the client changes', (t) => {
  const f = setup(t, { open: true });
  assert.equal(f.dock.getChangesWaitingCount(), 3);
  assert.equal(f.listeners.length, 1, 'the dock subscribed to the suggested-changes client');
  assert.equal(f.wb.countChanges, 0);

  f.setPending(1);
  f.listeners.forEach((listener) => listener('s1'));
  assert.equal(f.wb.countChanges, 1, 'a suggested-client change tells the workbench to repaint its badges');
  assert.equal(f.dock.getChangesWaitingCount(), 1);

  f.setPending(0);
  f.listeners.forEach((listener) => listener('s1'));
  assert.equal(f.wb.countChanges, 2);
  assert.equal(f.dock.getChangesWaitingCount(), 0);
  assert.equal(f.listeners.length, 1, 'one subscription only');
});

test('without a changes view the waiting count is zero and reveal paths report false', (t) => {
  const f = setup(t, { open: true, noChanges: true });
  assert.equal(f.dock.getChangesWaitingCount(), 0);
  assert.equal(f.dock.toggleChangesTab(), false);
  assert.equal(f.dock.revealChanges({}), false);
  assert.deepEqual(f.wb.revealCalls, []);
});

test('after dispose the changes view no longer mounts and a count change is ignored', async (t) => {
  const f = setup(t, { open: true });
  f.dock.getChangesWaitingCount();
  f.dock.dispose();
  f.wb.visible.changes = true;
  f.dock.reconcile();
  await settle();
  assert.equal(f.changesHost().querySelector('.changes-view'), null);
  f.listeners.forEach((listener) => listener('s1'));
  assert.equal(f.wb.countChanges, 0);
});

const addTurn = (f, id) => f.turns.push({ turnId: id, rootMessageIds: { user: `u-${id}`, assistant: `a-${id}` }, user: { content: 'More' }, toolCalls: [] });

test('activity while the chat view is hidden sets hasUnread and tells the workbench once', (t) => {
  const f = setup(t, { open: false });
  f.dock.reconcile();
  assert.equal(f.dock.hasUnread(), false, 'nothing is unread before any activity');
  assert.equal(f.wb.countChanges, 0);

  addTurn(f, 't2');
  f.dock.reconcile();
  assert.equal(f.dock.hasUnread(), true);
  assert.equal(f.wb.countChanges, 1, 'the workbench chrome is told to repaint');

  addTurn(f, 't3');
  f.dock.reconcile();
  f.dock.reconcile();
  assert.equal(f.dock.hasUnread(), true, 'more activity keeps it set');
  assert.equal(f.wb.countChanges, 1, 'the flag did not flip again, so no repaint');
});

test('the chat view becoming visible clears hasUnread and repaints the chrome', (t) => {
  const f = setup(t, { open: false });
  f.dock.reconcile();
  addTurn(f, 't2');
  f.dock.reconcile();
  assert.equal(f.dock.hasUnread(), true);

  f.wb.visible.chat = true;
  f.dock.reconcile();
  assert.equal(f.dock.hasUnread(), false, 'cleared on the next pass while visible');
  assert.equal(f.wb.countChanges, 2, 'one repaint for the set, one for the clear');

  f.dock.reconcile();
  assert.equal(f.wb.countChanges, 2, 'a settled flag does not repaint again');
});

test('activity while the chat view is visible never sets hasUnread', (t) => {
  const f = setup(t, { open: true });
  f.dock.reconcile();
  addTurn(f, 't2');
  f.dock.reconcile();
  addTurn(f, 't3');
  f.dock.reconcile();
  assert.equal(f.dock.hasUnread(), false);
  assert.equal(f.wb.countChanges, 0);
});

test('the first observation and a session switch are not unread', (t) => {
  const f = setup(t, { open: false });
  f.dock.reconcile();
  assert.equal(f.dock.hasUnread(), false, 'the first look at a hidden chat is not news');

  f.state.currentSessionId = 's2';
  addTurn(f, 't9');
  f.dock.reconcile();
  assert.equal(f.dock.hasUnread(), false, 'a session switch resets the key without marking unread');
  assert.equal(f.wb.countChanges, 0);

  addTurn(f, 't10');
  f.dock.reconcile();
  assert.equal(f.dock.hasUnread(), true, 'new activity in the switched-to session still counts');
});

test('without a changes view hasUnread stays false and never repaints', (t) => {
  const f = setup(t, { open: false, noChanges: true });
  f.dock.reconcile();
  addTurn(f, 't2');
  f.dock.reconcile();
  assert.equal(f.dock.hasUnread(), false);
  assert.equal(f.wb.countChanges, 0);
});
