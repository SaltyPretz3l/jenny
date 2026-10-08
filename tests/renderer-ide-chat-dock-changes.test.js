'use strict';

/* Chat dock Changes link (row 34 S5; row 40 W3/W6): inside the workbench the Changes
 * view mounts into the workbench's own host while visible, the waiting count follows the
 * suggested-changes client, and new chat activity while the chat view is hidden is unread.
 * Direct unit coverage of createChatDockChanges; the dock-level wiring is covered by
 * renderer-ide-chat-dock-workbench.test.js. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const changesDockModule = require('../renderer/features/renderer-ide-chat-dock-changes');
const changesViewModule = require('../renderer/features/renderer-changes-view');

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, opts = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div><textarea id="chatInput"></textarea></body>');
  const doc = dom.window.document;
  const turns = [{ turnId: 't1', rootMessageIds: { user: 'u1', assistant: 'a1' }, user: { content: 'Fix it' }, toolCalls: [] }];
  const changes = [{ changeId: 'c1', turnId: 't1', path: 'a.js', fileKey: 'ws:a.js', toolName: 'edit_file', status: 'modified', hunks: [] }];
  const opened = [];
  const sessionId = { value: 's1' };
  const wb = {
    visible: { chat: opts.chatVisible === true, changes: false },
    revealCalls: [],
    countChanges: 0,
    isVisible(id) { return this.visible[id] === true; },
    reveal(id) {
      this.revealCalls.push(id);
      this.visible.chat = id === 'chat';
      this.visible.changes = id === 'changes';
      mod.sync();
      return true;
    },
    getChangesHost: () => doc.getElementById('host'),
    onCountChange() { this.countChanges += 1; },
  };
  const mod = changesDockModule.createChatDockChanges({
    workbench: wb,
    loadChangesView: async () => changesViewModule,
    getSuggestedClient: () => null,
    focusChatInput: () => doc.getElementById('chatInput').focus(),
    ...(opts.isChatOnScreen ? { isChatOnScreen: opts.isChatOnScreen } : {}),
    ...(opts.onSync ? { onSync: opts.onSync } : {}),
    viewDeps: {
      getTurnViewModels: () => turns,
      buildLedger: () => ({ changes, notices: [] }),
      getSessionId: () => sessionId.value,
      openChangeDiff: (change) => opened.push(change.changeId),
    },
  });
  t.after(() => { mod.dispose(); dom.window.close(); });
  return { dom, doc, mod, wb, turns, changes, opened, sessionId };
}

test('the module exposes no tab markup builder any more', () => {
  assert.deepEqual(Object.keys(changesDockModule), ['createChatDockChanges']);
});

test('sync mounts the Changes view into the workbench host only while it is visible', async (t) => {
  const f = setup(t, { chatVisible: true });
  f.mod.sync();
  await settle();
  assert.equal(f.doc.querySelector('.changes-view'), null, 'hidden view: nothing mounts');

  f.wb.visible.changes = true;
  f.mod.sync();
  await settle();
  assert.equal(f.doc.querySelector('#host .changes-view')?.getAttribute('data-changes-view'), 'dock');
  f.doc.querySelector('[data-changes-item]').click();
  assert.deepEqual(f.opened, ['c1'], 'a file line opens its diff in the editor');

  f.wb.visible.changes = false;
  f.mod.sync();
  f.doc.querySelector('[data-changes-item]').click();
  assert.deepEqual(f.opened, ['c1'], 'hiding the view unmounts it');
});

test('a mounted Changes view refreshes on every sync, so a new turn or session shows without another event', async (t) => {
  const f = setup(t);
  f.wb.visible.changes = true;
  f.mod.sync();
  await settle();
  assert.ok(f.doc.querySelector('#host .changes-view'));
  assert.equal(f.doc.getElementById('host').textContent.includes('b.js'), false);
  f.turns.push({ turnId: 't2', rootMessageIds: { user: 'u2', assistant: 'a2' }, user: { content: 'And b' }, toolCalls: [] });
  f.changes.push({ changeId: 'c2', turnId: 't2', path: 'b.js', fileKey: 'ws:b.js', toolName: 'edit_file', status: 'modified', hunks: [] });
  f.mod.sync();
  assert.ok(f.doc.getElementById('host').textContent.includes('b.js'), 'the open view repainted');
});

test('select and toggle reveal through the workbench; choosing Chat focuses the composer', async (t) => {
  const f = setup(t, { chatVisible: true });
  assert.equal(f.mod.toggle(), true);
  await settle();
  assert.deepEqual(f.wb.revealCalls, ['changes']);
  assert.equal(f.mod.toggle(), true);
  assert.deepEqual(f.wb.revealCalls, ['changes', 'chat']);
  assert.equal(f.doc.activeElement, f.doc.getElementById('chatInput'), 'back on Chat lands in the composer');
  assert.equal(f.mod.select('nope'), false);
});

test('unread: activity while Chat is hidden sets it once; showing Chat clears it', (t) => {
  const f = setup(t);
  f.mod.sync();
  assert.equal(f.mod.hasUnread(), false);
  f.turns.push({ turnId: 't2', rootMessageIds: { user: 'u2', assistant: 'a2' }, user: { content: 'More' }, toolCalls: [] });
  f.mod.sync();
  assert.equal(f.mod.hasUnread(), true);
  assert.equal(f.wb.countChanges, 1);
  f.wb.visible.chat = true;
  f.mod.sync();
  assert.equal(f.mod.hasUnread(), false);
  assert.equal(f.wb.countChanges, 2);
});

test('unread: a session switch with no prior observation of the new session is not news', (t) => {
  const f = setup(t);
  f.mod.sync();
  f.sessionId.value = 's2';
  f.turns.push({ turnId: 't9', rootMessageIds: { assistant: 'a9' }, toolCalls: [] });
  f.mod.sync();
  assert.equal(f.mod.hasUnread(), false);
  assert.equal(f.wb.countChanges, 0);
});

test('unread: hasUnread clears as soon as Chat shows, before the next sync', (t) => {
  const f = setup(t);
  f.mod.sync();
  f.turns.push({ turnId: 't2', rootMessageIds: { assistant: 'a2' }, toolCalls: [] });
  f.mod.sync();
  assert.equal(f.mod.hasUnread(), true);
  f.wb.visible.chat = true; // a workbench-only render (strip click on a folded stack, maximize)
  assert.equal(f.mod.hasUnread(), false);
});

test('unread: activity read in the Chat view (outside the Workspace) is not news', (t) => {
  const onScreen = { value: true };
  const f = setup(t, { isChatOnScreen: () => onScreen.value });
  f.mod.sync();
  f.turns.push({ turnId: 't2', rootMessageIds: { assistant: 'a2' }, toolCalls: [] });
  f.mod.sync();
  assert.equal(f.mod.hasUnread(), false, 'the reply was on screen in the Chat view');
  onScreen.value = false;
  f.turns.push({ turnId: 't3', rootMessageIds: { assistant: 'a3' }, toolCalls: [] });
  f.mod.sync();
  assert.equal(f.mod.hasUnread(), true, 'back in the Workspace with Chat hidden, a new reply is');
});

test('every sync calls onSync (the Source Control markers re-check the ledger)', (t) => {
  let calls = 0;
  const f = setup(t, { onSync: () => { calls += 1; } });
  f.mod.sync();
  f.mod.sync();
  assert.equal(calls, 2);
});

test('unread: a session change clears a stale cue (another chat\'s news is not this one\'s)', (t) => {
  const f = setup(t);
  f.mod.sync();
  f.turns.push({ turnId: 't2', rootMessageIds: { assistant: 'a2' }, toolCalls: [] });
  f.mod.sync();
  assert.equal(f.mod.hasUnread(), true);
  f.sessionId.value = '';
  f.mod.sync();
  assert.equal(f.mod.hasUnread(), false, 'the chat closed');
  f.sessionId.value = 's9';
  f.mod.sync();
  assert.equal(f.mod.hasUnread(), false, 'a new chat starts clean');
});

test('the first observation is never unread, even for an empty session id', (t) => {
  const f = setup(t);
  f.sessionId.value = '';
  f.mod.sync();
  assert.equal(f.mod.hasUnread(), false);
});

test('after dispose sync is inert and the view is gone', async (t) => {
  const f = setup(t, { chatVisible: true });
  f.wb.visible.changes = true;
  f.mod.sync();
  await settle();
  assert.ok(f.mod.getView());
  f.mod.dispose();
  assert.equal(f.mod.getView(), null);
  f.turns.push({ turnId: 't3', rootMessageIds: { assistant: 'a3' }, toolCalls: [] });
  f.mod.sync();
  assert.equal(f.mod.hasUnread(), false);
});
