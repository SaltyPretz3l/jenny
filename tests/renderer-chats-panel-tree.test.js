const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const actionButton = require('../renderer/inventory/action-button');
const segmentedControl = require('../renderer/inventory/segmented-control');
const tree = require('../renderer/shell/renderer-chats-panel-tree');
const { buildChatsViewModel, createChatsPanelController } = require('../renderer/shell/renderer-chats-panel');
const { createShellEventBindings } = require('../renderer/shell/renderer-shell-event-utils');

const NOW = new Date(Date.UTC(2026, 9, 15, 12, 0, 0));
const iso = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60000).toISOString();

function chat(id, minutesAgo, extra = {}) {
  return { id, title: `Chat ${id}`, updated_at: iso(minutesAgo), created_at: iso(minutesAgo + 500), pinned: false, archived_at: null, ...extra };
}

function child(id, parentId, updatedAgo, createdAgo, extra = {}) {
  return chat(id, updatedAgo, {
    created_at: iso(createdAgo),
    spawned_from: { parent_session_id: parentId, proposal_id: `proposal_${id}`, created_at: iso(createdAgo) },
    ...extra,
  });
}

function layout(sessions, options = {}) {
  const sorted = sessions.slice().sort(tree.compareSessions);
  const built = tree.buildSessionTree({ sessions: sorted, allSessions: options.allSessions || sessions, pendingDeletes: options.pendingDeletes || new Set(), scope: options.scope, projectId: options.projectId, query: options.query, isActive: options.isActive });
  const laid = tree.layoutGroups(built, options.scope || 'recent', NOW);
  return { built, laid, ids: laid.rendered.map((session) => session.id) };
}

test('children nest oldest-first under their parent, are never roots, and grandchildren nest', () => {
  const sessions = [
    chat('parent', 1),
    // c-new was created last but is the most recently active; creation time orders children.
    child('c-new', 'parent', 2, 100),
    child('c-old', 'parent', 900, 300),
    child('grand', 'c-old', 3, 50),
    chat('other', 10),
  ];
  const { built, ids } = layout(sessions);
  assert.deepEqual(ids, ['parent', 'c-old', 'grand', 'c-new', 'other']);
  assert.deepEqual(built.roots.map((session) => session.id).sort(), ['other', 'parent']);
  assert.equal(new Set(ids).size, ids.length, 'no row is duplicated');
  const nodes = built.nodes;
  assert.equal(nodes.get('parent').childCount, 3);
  assert.equal(nodes.get('c-old').depth, 1);
  assert.equal(nodes.get('grand').depth, 2);
  assert.equal(nodes.get('grand').parentId, 'c-old');
  // Thread: c-old has a later sibling (straight line + tick); the last child draws the elbow.
  assert.equal(nodes.get('c-old').last, false);
  assert.deepEqual(nodes.get('c-old').through, [1]);
  assert.equal(nodes.get('c-new').last, true);
  assert.deepEqual(nodes.get('c-new').through, []);
  // The grandchild carries its grandparent's line (level 1) and elbows at level 2.
  assert.deepEqual(nodes.get('grand').through, [1]);
  assert.equal(nodes.get('grand').last, true);
});

test('a collapsed parent hides its subtree from the layout and signals active or unread descendants', () => {
  const sessions = [
    chat('parent', 1, { children_expanded: false }),
    child('c1', 'parent', 5, 100, { unread_message_count: 2 }),
    child('c2', 'parent', 6, 90),
    child('g', 'c2', 7, 80),
    chat('other', 20),
  ];
  const { built, ids } = layout(sessions, { isActive: (id) => id === 'g' });
  assert.deepEqual(ids, ['parent', 'other'], 'collapsed children are absent');
  const node = built.nodes.get('parent');
  assert.equal(node.expanded, false);
  assert.equal(node.childCount, 3);
  assert.equal(node.descendantActive, true, 'a working grandchild shows on the collapsed chip');
  assert.equal(node.descendantUnread, true);
  assert.deepEqual(node.descendantIds.sort(), ['c1', 'c2', 'g']);
  // null and true both read as expanded.
  assert.deepEqual(layout([chat('p', 1, { children_expanded: null }), child('k', 'p', 2, 9)]).ids, ['p', 'k']);
  assert.deepEqual(layout([chat('p', 1, { children_expanded: true }), child('k', 'p', 2, 9)]).ids, ['p', 'k']);
});

test('a child whose parent is not shown becomes a root with an origin caption; filters are not bypassed', () => {
  const archivedParent = chat('arch-parent', 5, { archived_at: iso(4) });
  const otherProject = chat('proj-parent', 5, { project_id: 'project_b' });
  const all = [
    archivedParent,
    otherProject,
    chat('live-parent', 5),
    child('c-archived', 'arch-parent', 1, 10),
    child('c-project', 'proj-parent', 2, 10, { project_id: 'project_a' }),
    child('c-gone', 'deleted-parent', 3, 10),
    child('c-pending', 'live-parent', 4, 10),
  ];
  // Recent scope, project filter: only project_a rows are shown.
  const shown = all.filter((session) => !session.archived_at && (session.project_id || 'project_general') === 'project_a');
  const projectView = layout(shown, { allSessions: all, projectId: 'project_a', pendingDeletes: new Set() });
  assert.equal(projectView.built.nodes.get('c-project').origin.kind, 'project');
  assert.equal(tree.originCaption(projectView.built.nodes.get('c-project').origin), 'From a chat in another project');
  assert.deepEqual(projectView.ids, ['c-project'], 'the filtered-out parent is not rendered to complete the tree');

  const recent = all.filter((session) => !session.archived_at && !session.project_id && session.id !== 'live-parent');
  const recentView = layout(recent, { allSessions: all, pendingDeletes: new Set(['live-parent']) });
  const caption = (id) => tree.originCaption(recentView.built.nodes.get(id).origin);
  assert.equal(caption('c-archived'), 'From an archived chat');
  assert.equal(caption('c-gone'), 'Original chat unavailable');
  assert.equal(caption('c-pending'), 'Original chat unavailable', 'a parent with a pending delete reads as unavailable');
  assert.ok(recentView.ids.includes('c-archived') && recentView.ids.includes('c-gone'));
  assert.equal(recentView.built.nodes.get('c-archived').depth, 0);

  // A parent that exists but sits beyond the mounted page reads "in {parent}".
  const paged = layout([child('c-late', 'live-parent', 1, 10)], { allSessions: all });
  assert.equal(tree.originCaption(paged.built.nodes.get('c-late').origin), 'in Chat live-parent');
});

test('search results stay flat and a hit shows the parent it came from', () => {
  const sessions = [chat('parent', 5), child('hit', 'parent', 1, 20), child('orphan', 'missing', 2, 20)];
  const { built, ids } = layout([sessions[1], sessions[2]], { allSessions: sessions, query: 'x' });
  assert.deepEqual(ids, ['hit', 'orphan']);
  assert.equal(built.nodes.get('hit').depth, 0);
  assert.equal(built.nodes.get('hit').hasChildren, false);
  assert.equal(tree.originCaption(built.nodes.get('hit').origin), 'in Chat parent');
  assert.equal(tree.originCaption(built.nodes.get('orphan').origin), 'Original chat unavailable');
});

test('malformed links, self links and parent cycles never loop or duplicate rows', () => {
  const sessions = [
    chat('self', 1, { spawned_from: { parent_session_id: 'self' } }),
    chat('bad', 2, { spawned_from: 'nope' }),
    chat('blank', 3, { spawned_from: { parent_session_id: '  ' } }),
    child('a', 'b', 4, 40),
    child('b', 'a', 5, 30),
  ];
  const { ids, built } = layout(sessions);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.slice().sort(), ['a', 'b', 'bad', 'blank', 'self']);
  assert.equal(built.nodes.get('self').depth, 0);
  assert.equal(tree.spawnedFromOf(sessions[1]), null);
});

test('buildChatsViewModel nests only inside the visible set and keeps the page accounting on mounted sessions', () => {
  const sessions = [chat('parent', 1), child('kid', 'parent', 2, 10), child('collapsed-kid', 'p2', 3, 10), chat('p2', 4, { children_expanded: false })];
  const model = buildChatsViewModel({ sessions, now: NOW });
  assert.deepEqual(model.visibleSessions.map((session) => session.id), ['parent', 'kid', 'p2']);
  assert.equal(model.visibleCount, 4, 'collapsed children still count as mounted for paging');
  assert.equal(model.groups.reduce((total, group) => total + group.items.length, 0), 3);
  assert.equal(model.nodes.get('kid').parentId, 'parent');
  // A project filter that excludes the parent makes the child a root, never a nested row.
  const filtered = buildChatsViewModel({
    sessions: [chat('parent', 1, { project_id: 'project_x' }), child('kid', 'parent', 2, 10, { project_id: 'project_y' })],
    projectId: 'project_y',
    now: NOW,
  });
  assert.deepEqual(filtered.visibleSessions.map((session) => session.id), ['kid']);
  assert.equal(filtered.nodes.get('kid').origin.kind, 'project');
  // Archived scope: a recent parent is not shown among archived chats.
  const archived = buildChatsViewModel({
    sessions: [chat('parent', 1), child('kid', 'parent', 2, 10, { archived_at: iso(1) })],
    scope: 'archived',
    now: NOW,
  });
  assert.deepEqual(archived.visibleSessions.map((session) => session.id), ['kid']);
  assert.equal(archived.nodes.get('kid').origin.kind, 'parent');
});

test('writeChildrenExpanded is optimistic, resends once after a revision conflict and reverts on failure', async () => {
  const sessions = [chat('p', 1, { coordination_revision: 4, children_expanded: null })];
  const state = { sessions };
  const changes = [];
  const sent = [];
  let conflicts = 1;
  const bridge = {
    async setView(request) {
      sent.push(request);
      if (conflicts > 0) { conflicts -= 1; return { ok: false, reason: 'revision_conflict', current_revision: 6 }; }
      return { ok: true, workspace_view: { children_expanded: false }, coordination_revision: request.expected_revision + 1 };
    },
    async getSummary() {
      throw new Error('the conflict envelope already carries the revision');
    },
  };
  const ctx = { state, bridge, chains: new Map(), onChange: () => changes.push(sessions[0].children_expanded) };
  const pending = tree.writeChildrenExpanded(ctx, 'p', false);
  assert.equal(sessions[0].children_expanded, false, 'optimistic');
  assert.equal(await pending, true);
  assert.deepEqual(sent.map((request) => request.expected_revision), [4, 6], 'one resend at the revision the conflict reported');
  assert.deepEqual(sent[0], { schema_version: 1, session_id: 'p', expected_revision: 4, patch: { children_expanded: false } });
  assert.equal(sessions[0].coordination_revision, 7);

  const failing = { async setView() { return { ok: false, reason: 'io_failed' }; } };
  const failedCtx = { state, bridge: failing, chains: new Map(), onChange: () => changes.push(sessions[0].children_expanded) };
  assert.equal(await tree.writeChildrenExpanded(failedCtx, 'p', true), false);
  assert.equal(sessions[0].children_expanded, false, 'reverted to the previous value');
  assert.equal(sessions[0].coordination_revision, 7);

  const second = { sessions: [chat('q', 1, { children_expanded: true })] };
  assert.equal(await tree.writeChildrenExpanded({ state: second, bridge: null, chains: new Map(), onChange() {} }, 'q', false), true);
  assert.equal(second.sessions[0].children_expanded, false, 'without the bridge the toggle is a local view change');
  assert.equal(await tree.writeChildrenExpanded({ state: second, bridge: null, chains: new Map(), onChange() {} }, 'missing', false), false);
});

function createDomHarness(sessions, { streaming = [], bridge } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><input id="search"><div id="groups"></div></body></html>');
  const document = dom.window.document;
  const frames = [];
  const windowRef = {
    Event: dom.window.Event,
    requestAnimationFrame: (callback) => frames.push(callback),
    cancelAnimationFrame() {},
    jennyShell: bridge ? { chatWorkspace: bridge } : undefined,
    rendererMultiStreamController: { getStreamingSessionIds: () => streaming, getApprovalPendingSessionIds: () => [] },
  };
  const state = { sessions, currentSessionId: '', ui: { pendingSessionDeletes: [] }, sendOutboxBySession: new Map() };
  const groups = document.getElementById('groups');
  const controller = createChatsPanelController({
    state,
    documentRef: document,
    windowRef,
    dom: { conversationGroups: groups, searchInput: document.getElementById('search') },
    inventory: { actionButton, segmentedControl },
    callbacks: { escapeHtml: actionButton.escapeHtml },
  });
  controller.renderNow();
  return { dom, document, groups, state, controller, frames, windowRef };
}

const ids = (groups) => [...groups.querySelectorAll('.conversation-item[data-session-id]')].map((row) => row.dataset.sessionId);

test('rows stay flat siblings with accessible, non-nested toggle controls', () => {
  const sessions = [chat('parent', 1), child('kid', 'parent', 2, 10), child('grand', 'kid', 3, 5, { unread_message_count: 1 }), chat('lone', 30)];
  const h = createDomHarness(sessions);
  assert.deepEqual(ids(h.groups), ['parent', 'kid', 'grand', 'lone']);
  const rows = [...h.groups.querySelectorAll('.conversation-item')];
  assert.equal(new Set(rows.map((row) => row.parentElement)).size, 1, 'one flat list');
  assert.equal(h.groups.querySelectorAll('.session-row .session-row').length, 0, 'no nested rows');
  const parent = h.groups.querySelector('[data-session-id="parent"]');
  assert.equal(parent.dataset.treeHasChildren, 'true');
  assert.equal(parent.dataset.treeExpanded, 'true');
  const chevron = parent.querySelector('.session-row__chevron');
  assert.equal(chevron.getAttribute('aria-expanded'), 'true');
  assert.equal(chevron.closest('[data-session-open]'), null, 'the chevron is a sibling of the open button');
  assert.equal(chevron.parentElement.parentElement, parent);
  assert.equal(parent.querySelector('.session-row__children-chip'), null, 'no count chip while expanded');
  const kid = h.groups.querySelector('[data-session-id="kid"]');
  assert.equal(kid.dataset.treeDepth, '1');
  assert.equal(kid.dataset.treeParentId, 'parent');
  assert.equal(kid.style.getPropertyValue('--cw-depth'), '1');
  assert.match(kid.querySelector('.sr-only[id^="session-relation-"]').textContent, /^Linked chat of Chat parent$/);
  assert.equal(kid.querySelector('[data-session-open]').getAttribute('aria-describedby'), 'session-relation-kid');
  assert.equal(h.groups.querySelector('[data-session-id="grand"]').dataset.treeDepth, '2');
  assert.equal(h.groups.querySelector('[data-session-id="lone"]').dataset.treeDepth, '0');
  assert.equal(h.groups.querySelector('[data-session-id="lone"]').querySelector('[data-session-toggle]'), null);
  h.controller.dispose();
});

test('a collapsed parent shows a count chip with accessible state words and keeps its children out of the DOM', () => {
  const sessions = [
    chat('parent', 1, { children_expanded: false }),
    child('kid', 'parent', 2, 10, { unread_message_count: 3 }),
    child('kid2', 'parent', 3, 9),
  ];
  const h = createDomHarness(sessions, { streaming: ['kid2'] });
  assert.deepEqual(ids(h.groups), ['parent']);
  const row = h.groups.querySelector('[data-session-id="parent"]');
  const chip = row.querySelector('.session-row__children-chip');
  assert.ok(chip);
  assert.equal(chip.closest('[data-session-open]'), null);
  assert.equal(chip.querySelector('.session-row__children-count').textContent, '2');
  assert.equal(chip.querySelector('.session-row__children-dot').dataset.tone, 'active', 'working wins the dot');
  assert.equal(chip.querySelector('.sr-only').textContent, '2 linked chats hidden, working, unread', 'state is text, not colour');
  assert.equal(row.querySelector('.session-row__chevron').getAttribute('aria-expanded'), 'false');
  h.controller.dispose();
});

test('patchRuntimeState refreshes a collapsed chip when a hidden child starts working', () => {
  const sessions = [chat('parent', 1, { children_expanded: false }), child('kid', 'parent', 2, 10)];
  const streaming = [];
  const h = createDomHarness(sessions, { streaming });
  assert.equal(h.groups.querySelector('.session-row__children-dot'), null);
  streaming.push('kid');
  h.controller.patchRuntimeState();
  assert.equal(h.groups.querySelector('.session-row__children-dot').dataset.tone, 'active');
  assert.match(h.groups.querySelector('.session-row__children-chip .sr-only').textContent, /working/);
  streaming.length = 0;
  h.controller.patchRuntimeState();
  assert.equal(h.groups.querySelector('.session-row__children-dot'), null);
  h.controller.dispose();
});

test('origin rows get a caption line described to the open button', () => {
  const sessions = [child('orphan', 'gone', 1, 10), child('archived-kid', 'arch', 2, 10), chat('arch', 50, { archived_at: iso(40) })];
  const h = createDomHarness(sessions);
  const orphan = h.groups.querySelector('[data-session-id="orphan"]');
  assert.equal(orphan.dataset.treeOrigin, 'unavailable');
  assert.equal(orphan.querySelector('.session-row__origin').textContent, 'Original chat unavailable');
  assert.equal(orphan.querySelector('[data-session-open]').getAttribute('aria-describedby'), 'session-relation-orphan');
  assert.equal(h.groups.querySelector('[data-session-id="archived-kid"] .session-row__origin').textContent, 'From an archived chat');
  h.controller.dispose();
});

test('an untrusted title is text, not markup, in rows, chips and captions', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const sessions = [chat('parent', 1, { title: evil, children_expanded: false }), child('kid', 'parent', 2, 10), child('orphan', 'parent-gone', 3, 10, { title: evil })];
  const h = createDomHarness(sessions);
  assert.equal(h.groups.querySelector('img'), null);
  assert.ok(h.groups.querySelector('.session-row__chevron').getAttribute('aria-label').includes(evil));
  h.controller.dispose();
});

test('clicking the chevron collapses and persists through setView; the list re-renders without the children', async () => {
  const sent = [];
  const bridge = { async setView(request) { sent.push(request); return { ok: true, workspace_view: { children_expanded: request.patch.children_expanded }, coordination_revision: 8 }; } };
  const sessions = [chat('parent', 1, { coordination_revision: 7 }), child('kid', 'parent', 2, 10)];
  const h = createDomHarness(sessions, { bridge });
  h.groups.querySelector('[data-session-id="parent"] .session-row__chevron').dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { schema_version: 1, session_id: 'parent', expected_revision: 7, patch: { children_expanded: false } });
  h.frames.splice(0).forEach((frame) => frame());
  assert.deepEqual(ids(h.groups), ['parent']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions[0].coordination_revision, 8);
  // And back open from the chip.
  h.groups.querySelector('[data-session-id="parent"] .session-row__children-chip').dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setImmediate(resolve));
  h.frames.splice(0).forEach((frame) => frame());
  assert.deepEqual(ids(h.groups), ['parent', 'kid']);
  assert.equal(sent[1].patch.children_expanded, true);
  assert.equal(sent[1].expected_revision, 8);
  h.controller.dispose();
});

test('toggling does not lose focus on the toggled control', () => {
  const bridge = { async setView() { return { ok: true, workspace_view: {}, coordination_revision: 2 }; } };
  const h = createDomHarness([chat('parent', 1), child('kid', 'parent', 2, 10)], { bridge });
  const chevron = h.groups.querySelector('[data-session-id="parent"] .session-row__chevron');
  h.document.body.append(h.groups);
  chevron.focus();
  chevron.click();
  h.controller.renderNow();
  assert.equal(h.document.activeElement.hasAttribute('data-session-toggle'), true);
  h.controller.dispose();
});

test('Right and Left walk the tree; Up and Down follow visible rows in DOM order', async () => {
  const sent = [];
  const bridge = { async setView(request) { sent.push(request.patch.children_expanded); return { ok: true, workspace_view: {}, coordination_revision: 5 }; } };
  const sessions = [chat('parent', 1), child('kid', 'parent', 2, 10), child('grand', 'kid', 3, 5), chat('lone', 30), chat('empty', 40, { children_expanded: false })];
  const h = createDomHarness(sessions, { bridge });
  const previousWindow = global.window;
  const previousAbort = global.AbortController;
  global.window = h.dom.window;
  global.AbortController = h.dom.window.AbortController;
  const bindings = createShellEventBindings({
    state: { auth: { authenticated: true }, ui: {} },
    dom: { conversationGroups: h.groups, searchInput: h.document.getElementById('search') },
    callbacks: {
      renderSessions: h.controller.renderSessions,
      setRovingChatSession: h.controller.setRovingSession,
      openSession: async () => true,
      handleWorkspaceShortcut() {},
      showSessionActionError(error) { throw error; },
    },
    constants: { TOAST_SOURCE: {} },
  });
  bindings.bind();
  h.document.body.append(h.groups);
  const open = (id) => h.groups.querySelector(`[data-session-id="${id}"] [data-session-open]`);
  const press = (target, key, init = {}) => {
    const event = new h.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const active = () => h.document.activeElement && h.document.activeElement.dataset.sessionOpen;
  try {
    open('parent').focus();
    // Right on an expanded parent enters its first child.
    assert.equal(press(open('parent'), 'ArrowRight').defaultPrevented, true);
    assert.equal(active(), 'kid');
    press(open('kid'), 'ArrowRight');
    assert.equal(active(), 'grand');
    // Right on a plain row does nothing and is not swallowed.
    assert.equal(press(open('grand'), 'ArrowRight').defaultPrevented, false);
    assert.equal(active(), 'grand');
    // Left on a row without children goes to its parent, one level at a time.
    assert.equal(press(open('grand'), 'ArrowLeft').defaultPrevented, true);
    assert.equal(active(), 'kid');
    // Left on an expanded parent collapses it instead of moving; focus stays.
    press(open('kid'), 'ArrowLeft');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [false]);
    h.frames.splice(0).forEach((frame) => frame());
    assert.deepEqual(ids(h.groups), ['parent', 'kid', 'lone', 'empty']);
    assert.equal(active(), 'kid', 'focus stays on the collapsed row');
    // Down skips the collapsed grandchild because it is absent from the DOM.
    press(open('kid'), 'ArrowDown');
    assert.equal(active(), 'lone');
    press(open('lone'), 'ArrowUp');
    assert.equal(active(), 'kid');
    // Right on a collapsed parent expands it.
    press(open('kid'), 'ArrowRight');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [false, true]);
    // Modified arrows (browser back/forward) are left alone.
    assert.equal(press(open('kid'), 'ArrowLeft', { altKey: true }).defaultPrevented, false);
    // ContextMenu still opens the row menu path (unchanged): it is not intercepted by the tree keys.
    assert.equal(press(open('lone'), 'ArrowLeft').defaultPrevented, false, 'a root row has no parent to go to');
  } finally {
    bindings.dispose();
    global.window = previousWindow;
    global.AbortController = previousAbort;
    h.controller.dispose();
  }
});

test('RTL swaps the expand and collapse keys', async () => {
  const sessions = [chat('parent', 1, { children_expanded: false }), child('kid', 'parent', 2, 10)];
  const sent = [];
  const bridge = { async setView(request) { sent.push(request.patch.children_expanded); return { ok: true, workspace_view: {}, coordination_revision: 1 }; } };
  const h = createDomHarness(sessions, { bridge });
  h.document.documentElement.dir = 'rtl';
  const previousWindow = global.window;
  const previousAbort = global.AbortController;
  global.window = h.dom.window;
  global.AbortController = h.dom.window.AbortController;
  const bindings = createShellEventBindings({
    state: { auth: { authenticated: true }, ui: {} },
    dom: { conversationGroups: h.groups },
    callbacks: { renderSessions() {}, setRovingChatSession() {}, openSession: async () => true, handleWorkspaceShortcut() {}, showSessionActionError(error) { throw error; } },
    constants: { TOAST_SOURCE: {} },
  });
  bindings.bind();
  try {
    const target = h.groups.querySelector('[data-session-id="parent"] [data-session-open]');
    target.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [], 'Right is the collapse side in RTL');
    target.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [true]);
  } finally {
    bindings.dispose();
    global.window = previousWindow;
    global.AbortController = previousAbort;
    h.controller.dispose();
  }
});

test('review fix: a collapsed parent row describes its hidden children on the focusable open button', () => {
  const sessions = [
    chat('parent', 1, { children_expanded: false }),
    child('kid', 'parent', 2, 10, { unread_message_count: 3 }),
    child('kid2', 'parent', 3, 9),
  ];
  const h = createDomHarness(sessions);
  const parent = h.groups.querySelector('[data-session-id="parent"]');
  const open = parent.querySelector('[data-session-open]');
  const describedBy = open.getAttribute('aria-describedby');
  assert.equal(describedBy, 'session-relation-parent');
  const text = h.groups.querySelector(`#${describedBy}`).textContent;
  assert.match(text, /2 linked chats hidden/);
  assert.match(text, /unread/);
  h.controller.dispose();
});
