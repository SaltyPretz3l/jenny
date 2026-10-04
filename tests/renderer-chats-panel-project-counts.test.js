'use strict';

// D15 (Projects PO review 2026-09-27): with a project filter set, every count
// the Chats panel shows is that project's: "Showing X of Y", the total badge
// and the "Archived N" tab. With no filter they count every chat.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { buildChatsViewModel, createChatsPanelController } = require('../renderer/shell/renderer-chats-panel');
const actionButton = require('../renderer/inventory/action-button');
const segmentedControl = require('../renderer/inventory/segmented-control');

function session(id, projectId, extra = {}) {
  return { id, title: id, project_id: projectId, updated_at: new Date(Date.now() - 60 * 1000).toISOString(), archived_at: null, ...extra };
}

const SESSIONS = [
  session('a1', 'project_ascend'),
  session('a2', 'project_ascend'),
  session('a3', 'project_ascend', { archived_at: new Date().toISOString() }),
  session('b1', 'project_budget'),
  session('g1', undefined),
  session('g2', undefined, { archived_at: new Date().toISOString() }),
];

test('D15: the view model totals are the filtered project\'s, archived included', () => {
  const all = buildChatsViewModel({ sessions: SESSIONS, scope: 'recent' });
  assert.deepEqual([all.recentTotal, all.archivedTotal, all.scopeTotal], [4, 2, 4]);
  const ascend = buildChatsViewModel({ sessions: SESSIONS, scope: 'recent', projectId: 'project_ascend' });
  assert.deepEqual([ascend.recentTotal, ascend.archivedTotal, ascend.scopeTotal, ascend.projectTotal], [2, 1, 2, 3]);
  const archivedGeneral = buildChatsViewModel({ sessions: SESSIONS, scope: 'archived', projectId: 'project_general' });
  assert.deepEqual([archivedGeneral.recentTotal, archivedGeneral.archivedTotal, archivedGeneral.scopeTotal], [1, 1, 1]);
});

test('D15: the badge, the status line and the Archived tab follow the filter', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="chatsProjectRow"></div><div id="chatsScopeSlot"></div><div id="conversationGroups"></div><div id="chatsPanelStatus"></div><span id="conversationCount"></span></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const doc = dom.window.document;
  const state = { ui: { chatsProjectFilter: 'project_ascend' }, sessions: SESSIONS.slice() };
  const controller = createChatsPanelController({
    state,
    documentRef: doc,
    windowRef: dom.window,
    dom: { conversationGroups: doc.getElementById('conversationGroups'), conversationCount: doc.getElementById('conversationCount'), scopeSlot: doc.getElementById('chatsScopeSlot'), projectRow: doc.getElementById('chatsProjectRow'), status: doc.getElementById('chatsPanelStatus') },
    inventory: { actionButton, segmentedControl },
    callbacks: {},
  });
  try {
    controller.renderNow();
    assert.equal(doc.getElementById('conversationCount').textContent, '3', 'the badge counts the project\'s chats');
    assert.equal(doc.getElementById('conversationCount').getAttribute('aria-label'), '3 total chats');
    assert.equal(doc.getElementById('chatsPanelStatus').textContent, 'Showing 2 of 2 recent chats.');
    assert.match(doc.querySelector('#chatsScopeSlot [data-value="archived"]').textContent, /Archived 1/);

    controller.setProjectFilter('');
    controller.renderNow();
    assert.equal(doc.getElementById('conversationCount').textContent, '6', 'All projects counts every chat');
    assert.equal(doc.getElementById('chatsPanelStatus').textContent, 'Showing 4 of 4 recent chats.');
    assert.match(doc.querySelector('#chatsScopeSlot [data-value="archived"]').textContent, /Archived 2/);
  } finally {
    controller.dispose();
    dom.window.close();
  }
});

// Tab rail program (shell-chrome area 2): "Chats 10" counts chats, the rail
// holds at most 8 tabs; the badge tooltip connects the two numbers.
test('the chats count tooltip says how many chats are open as tabs', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="chatsProjectRow"></div><div id="chatsScopeSlot"></div><div id="conversationGroups"></div><div id="chatsPanelStatus"></div><span id="conversationCount"></span></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const doc = dom.window.document;
  const state = { ui: {}, sessions: SESSIONS.slice(), workspace: { activeSessionId: 'a1', openSessionIds: ['a1', 'b1'] } };
  const controller = createChatsPanelController({
    state,
    documentRef: doc,
    windowRef: dom.window,
    dom: { conversationGroups: doc.getElementById('conversationGroups'), conversationCount: doc.getElementById('conversationCount'), scopeSlot: doc.getElementById('chatsScopeSlot'), projectRow: doc.getElementById('chatsProjectRow'), status: doc.getElementById('chatsPanelStatus') },
    inventory: { actionButton, segmentedControl },
    callbacks: {},
  });
  try {
    controller.renderNow();
    const count = doc.getElementById('conversationCount');
    assert.equal(count.textContent, '6');
    assert.equal(count.getAttribute('title'), '6 chats · 2 open as tabs');
    assert.equal(count.getAttribute('aria-label'), '6 total chats');

    state.workspace.openSessionIds = [];
    controller.renderNow();
    assert.equal(count.getAttribute('title'), '6 chats');
  } finally {
    controller.dispose();
    dom.window.close();
  }
});
