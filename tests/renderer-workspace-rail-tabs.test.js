const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createWorkspaceChromeController } = require('../renderer/shell/renderer-workspace-chrome-utils');

// Chat tab rail program (shell-chrome area 2): tab anatomy (state dot, no ×
// while busy), one default-title helper, live titles, active tab kept in
// view, overflow fade flags, Rename / Link sessions in the tab menu, the
// recall marking in the link popover and the sidebar "open as a tab" mark.

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="rail"></div></body></html>', {
    pretendToBeVisual: true,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  return dom;
}

function registerDomCleanup(t, dom) {
  t.after(async () => {
    delete global.window;
    delete global.document;
    await dom.window.close();
  });
}

function makeRailController(dom, overrides = {}) {
  const summaries = new Map(Object.entries(overrides.summaries || {}));
  let busyIds = new Set(overrides.busyIds || []);
  const controller = createWorkspaceChromeController({
    containerEl: dom.window.document.getElementById('rail'),
    getSessionSummary: (id) => summaries.get(id) || null,
    isSessionBusy: (id) => busyIds.has(id),
    onSessionClosed() {},
    onCloseOtherSessions() {},
    onCloseSessionsToRight() {},
    onCloseAllSessions() {},
    ...(overrides.deps || {}),
  });
  return {
    controller,
    summaries,
    setBusy(ids) { busyIds = new Set(ids); },
  };
}

test('the close button leaves a tab while its session is busy and returns when it goes idle', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const rig = makeRailController(dom);
  const list = [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }];
  rig.controller.renderRail(['s1', 's2'], 's1', list, [], []);
  const tab = doc.querySelector('[data-session-id="s2"]');
  assert.ok(doc.querySelector('[data-workspace-close="s2"]'), 'an idle tab has a close button');

  rig.setBusy(['s2']);
  rig.controller.patchRailRuntime('s1', ['s2'], []);
  assert.equal(doc.querySelector('[data-workspace-close="s2"]'), null, 'a busy tab drops its close button');
  assert.equal(tab.dataset.sessionDominantState, 'streaming');

  rig.setBusy([]);
  rig.controller.renderRail(['s1', 's2'], 's1', list, [], []);
  const restored = doc.querySelector('[data-workspace-close="s2"]');
  assert.ok(restored, 'the close button returns when the session goes idle');
  assert.equal(restored.disabled, false);
  assert.strictEqual(doc.querySelector('[data-session-id="s2"]'), tab, 'the tab node is reused throughout');
});

test('the default tab title comes from the shared helper, through the translator', (t) => {
  const previous = globalThis.jennyI18n;
  globalThis.jennyI18n = { t: (key, fallback) => (key.startsWith('session.defaultTitle.') ? `<${key}>` : fallback) };
  t.after(() => { globalThis.jennyI18n = previous; });
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const rig = makeRailController(dom);
  rig.controller.renderRail(['s1', 's2', 's3'], 's1', [
    { id: 's1', title: '' }, { id: 's2', title: 'New Plugin Session' }, { id: 's3', title: 'Real title' },
  ], [], []);
  assert.deepEqual([...doc.querySelectorAll('.workspace-rail-title')].map((node) => node.textContent),
    ['<session.defaultTitle.chat>', '<session.defaultTitle.plugin>', 'Real title']);
});

test('a runtime pass and a sessions render retitle a streaming "New Chat" tab from its summary', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const rig = makeRailController(dom, { summaries: { s1: { id: 's1', title: 'New Chat' }, s2: { id: 's2', title: 'B' } } });
  rig.controller.renderRail(['s1', 's2'], 's1', [{ id: 's1', title: 'New Chat' }, { id: 's2', title: 'B' }], ['s1'], []);
  const title = () => doc.querySelector('[data-session-id="s1"] .workspace-rail-title').textContent;
  assert.equal(title(), 'New Chat');

  rig.summaries.set('s1', { id: 's1', title: 'Fix the flaky rail test' });
  rig.controller.patchRailRuntime('s1', ['s1'], []);
  assert.equal(title(), 'Fix the flaky rail test', 'the runtime pass reads the live summary, not the stale tab text');
  assert.equal(doc.querySelector('[data-workspace-activate="s1"]').title, 'Streaming · Fix the flaky rail test');

  rig.summaries.set('s1', { id: 's1', title: 'Renamed while streaming' });
  rig.controller.syncTabTitles();
  assert.equal(title(), 'Renamed while streaming', 'a sessions render reaches the rail');
  assert.equal(doc.querySelector('[data-workspace-activate="s1"]').getAttribute('aria-label'),
    'Renamed while streaming. Status: Streaming');
});

test('the active tab is scrolled into view after a render that changes it', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  dom.window.matchMedia = () => ({ matches: true });
  const calls = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) {
    calls.push({ id: this.dataset.sessionId, options });
  };
  const rig = makeRailController(dom);
  const list = [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }, { id: 's3', title: 'C' }];
  rig.controller.renderRail(['s1', 's2', 's3'], 's3', list, [], []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 's3');
  assert.equal(calls[0].options.inline, 'nearest');
  assert.equal(calls[0].options.block, 'nearest');
  assert.equal(calls[0].options.behavior, 'auto', 'reduced motion scrolls instantly');

  rig.controller.renderRail(['s1', 's2', 's3'], 's3', list, [], []);
  assert.equal(calls.length, 1, 'an unchanged active tab does not yank a rail the user scrolled');

  rig.controller.renderRail(['s1', 's2', 's3'], 's1', list, [], []);
  assert.deepEqual(calls.map((call) => call.id), ['s3', 's1'], 'activation reveals the new active tab');

  rig.controller.patchRailRuntime('s2', [], []);
  assert.deepEqual(calls.map((call) => call.id), ['s3', 's1', 's2'], 'a runtime pass that moves the active tab reveals it');
});

test('the rail publishes which edges hide tabs so CSS can fade them', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const rig = makeRailController(dom);
  const list = [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }];
  rig.controller.renderRail(['s1', 's2'], 's1', list, [], []);
  const rail = doc.querySelector('.workspace-rail');
  assert.equal(rail.hasAttribute('data-overflow-start'), false);
  assert.equal(rail.hasAttribute('data-overflow-end'), false, 'no overflow, no fade');

  Object.defineProperty(rail, 'clientWidth', { configurable: true, value: 200 });
  Object.defineProperty(rail, 'scrollWidth', { configurable: true, value: 500 });
  Object.defineProperty(rail, 'scrollLeft', { configurable: true, writable: true, value: 0 });
  rig.controller.renderRail(['s1', 's2'], 's1', list, [], []);
  assert.equal(rail.hasAttribute('data-overflow-start'), false);
  assert.equal(rail.hasAttribute('data-overflow-end'), true);

  rail.scrollLeft = 150;
  rail.dispatchEvent(new dom.window.Event('scroll'));
  assert.equal(rail.hasAttribute('data-overflow-start'), true);
  assert.equal(rail.hasAttribute('data-overflow-end'), true);

  rail.scrollLeft = 300;
  rail.dispatchEvent(new dom.window.Event('scroll'));
  assert.equal(rail.hasAttribute('data-overflow-start'), true);
  assert.equal(rail.hasAttribute('data-overflow-end'), false);
});

test('the tab menu offers Rename and Link sessions with the linked count', async (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const linkRequests = [];
  const rig = makeRailController(dom, {
    summaries: { s1: { id: 's1', title: 'A', linked_session_ids: ['s2', 's3'] }, s2: { id: 's2', title: 'B' } },
    deps: {
      onLinkSessionsRequested(sessionId, anchor) { linkRequests.push([sessionId, anchor]); },
      onRenameSession() {},
    },
  });
  rig.controller.renderRail(['s1', 's2'], 's1', [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }], [], []);
  const labels = (id) => {
    doc.querySelector(`[data-session-id="${id}"]`).dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 60, clientY: 40, bubbles: true }));
    return [...doc.querySelectorAll('.workspace-tab-context-menu-item')].map((item) => item.textContent);
  };
  assert.deepEqual(labels('s1'), ['Rename…', 'Link sessions… · 2 linked', 'Close', 'Close Others', 'Close to the Right', 'Close All']);
  assert.deepEqual(labels('s2'), ['Rename…', 'Link sessions…', 'Close', 'Close Others', 'Close to the Right', 'Close All']);

  labels('s1');
  [...doc.querySelectorAll('.workspace-tab-context-menu-item')].find((item) => item.textContent.startsWith('Link')).click();
  await Promise.resolve();
  assert.deepEqual(linkRequests, [['s1', { x: 60, y: 40 }]], 'Link sessions works for any tab and forwards the menu origin');
  assert.equal(doc.querySelector('.workspace-tab-context-menu'), null);

  // The composition hands that anchor back; the popover lands at the menu's origin.
  rig.controller.showLinkedSessionPopover('s1', [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }], ['s2'], () => {}, linkRequests[0][1]);
  const popover = doc.querySelector('.workspace-linked-popover');
  assert.ok(popover);
  assert.equal(popover.style.left, '60px');
  assert.equal(popover.style.top, '48px');
});

test('double-click and the Rename item rename a tab in place', async (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const renames = [];
  const rig = makeRailController(dom, { deps: { onRenameSession(sessionId, title) { renames.push([sessionId, title]); } } });
  rig.controller.renderRail(['s1', 's2'], 's1', [{ id: 's1', title: 'Alpha' }, { id: 's2', title: 'Beta' }], [], []);

  const button = doc.querySelector('[data-workspace-activate="s2"]');
  button.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  const input = doc.querySelector('[data-session-id="s2"] .inv-inline-title-editor');
  assert.ok(input, 'an inline editor opens inside the tab');
  assert.equal(input.value, 'Beta');
  assert.equal(button.style.display, 'none');
  input.value = 'Beta closeout';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await Promise.resolve();
  assert.deepEqual(renames, [['s2', 'Beta closeout']]);
  assert.equal(doc.querySelector('.inv-inline-title-editor'), null);
  assert.equal(button.style.display, '');

  doc.querySelector('[data-session-id="s1"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
  [...doc.querySelectorAll('.workspace-tab-context-menu-item')].find((item) => item.textContent === 'Rename…').click();
  await Promise.resolve();
  const menuInput = doc.querySelector('[data-session-id="s1"] .inv-inline-title-editor');
  assert.ok(menuInput);
  menuInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(renames, [['s2', 'Beta closeout']], 'Escape cancels without renaming');
});

test('a failed tab rename reports through onRenameFailed with the rename title', async (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const failures = [];
  const rig = makeRailController(dom, { deps: {
    onRenameSession: async () => { throw new Error('disk full'); },
    onRenameFailed: (error, title) => failures.push([error.message, title]),
  } });
  rig.controller.renderRail(['s1', 's2'], 's1', [{ id: 's1', title: 'Alpha' }, { id: 's2', title: 'Beta' }], [], []);
  doc.querySelector('[data-workspace-activate="s2"]').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  const input = doc.querySelector('.inv-inline-title-editor');
  input.value = 'Gamma';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, [['disk full', 'Rename Failed']]);
});

test('without a rename handler the tab menu has no Rename item and double-click does nothing', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const rig = makeRailController(dom);
  rig.controller.renderRail(['s1', 's2'], 's1', [{ id: 's1', title: 'Alpha' }, { id: 's2', title: 'Beta' }], [], []);
  doc.querySelector('[data-workspace-activate="s2"]').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(doc.querySelector('.inv-inline-title-editor'), null);
  doc.querySelector('[data-session-id="s1"]').dispatchEvent(new dom.window.MouseEvent('contextmenu', { clientX: 10, clientY: 10, bubbles: true }));
  const labels = [...doc.querySelectorAll('.workspace-tab-context-menu-item')].map((item) => item.textContent);
  assert.equal(labels.includes('Rename…'), false);
});

test('the link popover lists linked then same-project chats first and marks which links recall uses', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const rig = makeRailController(dom, { deps: { onLinkSessionsRequested() {} } });
  rig.controller.renderRail(['a'], 'a', [{ id: 'a', title: 'Anchor' }], [], []);
  const sessions = [
    { id: 'a', title: 'Anchor', project_id: 'p1', updated_at: '2026-09-29T10:00:00Z' },
    { id: 'x', title: 'Other project', project_id: 'p2', updated_at: '2026-09-29T09:00:00Z' },
    { id: 'b', title: 'Newest', project_id: 'p1', updated_at: '2026-09-29T08:00:00Z' },
    { id: 'c', title: 'Second', project_id: 'p1', updated_at: '2026-09-28T08:00:00Z' },
    { id: 'd', title: 'Third', project_id: 'p1', updated_at: '2026-09-27T08:00:00Z' },
    { id: 'e', title: 'Fourth', project_id: 'p1', updated_at: '2026-09-26T08:00:00Z' },
    { id: 'f', title: 'Unlinked', project_id: 'p1', updated_at: '2026-09-25T08:00:00Z' },
  ];
  rig.controller.showLinkedSessionPopover('a', sessions, ['x', 'b', 'c', 'd', 'e'], () => {});
  const rows = [...doc.querySelectorAll('.workspace-linked-popover .workspace-linked-row')].map((row) => ({
    id: row.querySelector('input').dataset.linkedSessionId,
    hint: row.querySelector('.workspace-linked-row-hint')?.textContent || '',
    kind: row.querySelector('.workspace-linked-row-hint')?.dataset.hint || '',
  }));
  assert.deepEqual(rows, [
    { id: 'b', hint: 'Used for recall', kind: 'recall' },
    { id: 'c', hint: 'Used for recall', kind: 'recall' },
    { id: 'd', hint: 'Used for recall', kind: 'recall' },
    { id: 'e', hint: 'Not used for recall', kind: 'not-recall' },
    { id: 'x', hint: 'Other project', kind: 'other-project' },
    { id: 'f', hint: '', kind: '' },
  ]);
});

test('a row-anchored link popover survives a hidden-rail re-render and Escape refocuses its opener', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  doc.body.insertAdjacentHTML('beforeend', '<button id="rowMenu" type="button">⋯</button>');
  const rowMenu = doc.getElementById('rowMenu');
  const rig = makeRailController(dom);
  const sessions = [{ id: 'a', title: 'Anchor' }, { id: 'b', title: 'Other' }];
  rig.controller.showLinkedSessionPopover('a', sessions, [], () => {}, rowMenu);
  assert.notEqual(doc.activeElement, rowMenu, 'the popover takes focus');
  rig.controller.hideLinkedSessionPopover({ keepRowAnchored: true });
  assert.ok(doc.querySelector('.workspace-linked-popover'), 'a plugin-view chrome pass keeps the row popover open');

  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.querySelector('.workspace-linked-popover'), null);
  assert.equal(doc.activeElement, rowMenu, 'Escape returns focus to the row menu button');

  rig.controller.renderRail(['a', 'b'], 'a', sessions, [], []);
  rig.controller.showLinkedSessionPopover('a', sessions, [], () => {}, { x: 10, y: 10 });
  rig.controller.hideLinkedSessionPopover({ keepRowAnchored: true });
  assert.equal(doc.querySelector('.workspace-linked-popover'), null, 'a tab-menu popover goes with the rail');
  assert.equal(doc.activeElement, doc.querySelector('[data-workspace-activate="a"]'), 'focus lands on the tab');
});

test('sidebar rows of chats open as tabs carry the open state the ring keys on, and it follows the rail', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  doc.body.insertAdjacentHTML('beforeend', `
    <article data-session-id="session-1"><div class="conversation-title">One</div></article>
    <article data-session-id="session-2"><div class="conversation-title">Two</div></article>
  `);
  const controller = createWorkspaceChromeController({ containerEl: doc.getElementById('rail') });
  const rows = doc.querySelectorAll('[data-session-id]');
  const states = () => [...rows].map((row) => row.dataset.sessionDominantState);
  controller.renderSidebarBadges(rows, ['session-1', 'session-2'], ['session-2'], [], {});
  assert.deepEqual(states(), ['open', 'streaming'], 'a streaming row keeps its state dot rather than the ring');
  assert.equal([...rows].some((row) => row.hasAttribute('data-session-tab-open')), false, 'one attribute carries the open mark');
  assert.equal(rows[0].hasAttribute('data-session-open'), false, 'the row never borrows the open-button hook');

  controller.renderSidebarBadges(rows, ['session-2'], [], [], {});
  assert.deepEqual(states(), ['idle', 'open'], 'closing and opening tabs move the mark');
});

test('a title ending in a sentence mark does not double it before the status suffix', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  const doc = dom.window.document;
  const rig = makeRailController(dom, { summaries: { s1: { id: 's1', title: 'Say hello in three words.' } } });
  rig.controller.renderRail(['s1', 's2'], 's1', [{ id: 's1', title: 'Say hello in three words.' }, { id: 's2', title: 'B' }], ['s1'], []);
  rig.controller.patchRailRuntime('s1', ['s1'], []);
  assert.equal(doc.querySelector('[data-workspace-activate="s1"]').getAttribute('aria-label'),
    'Say hello in three words. Status: Streaming');
});

test('a window resize that clips the active tab scrolls it back into view', (t) => {
  const dom = setupDom();
  registerDomCleanup(t, dom);
  let resizeCallback = null;
  dom.window.ResizeObserver = class {
    constructor(callback) { resizeCallback = callback; }
    observe() {}
    disconnect() {}
  };
  const calls = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function () { calls.push(this.dataset.sessionId); };
  const rig = makeRailController(dom);
  const list = [{ id: 's1', title: 'A' }, { id: 's2', title: 'B' }, { id: 's3', title: 'C' }];
  rig.controller.renderRail(['s1', 's2', 's3'], 's3', list, [], []);
  assert.deepEqual(calls, ['s3'], 'activation reveals it once');
  assert.ok(resizeCallback, 'the rail observes its own size');

  const rail = dom.window.document.querySelector('.workspace-rail');
  const tab = dom.window.document.querySelector('[data-session-id="s3"]');
  const rect = (left, right) => () => ({ left, right, top: 0, bottom: 36, width: right - left, height: 36 });
  rail.getBoundingClientRect = rect(0, 400);
  tab.getBoundingClientRect = rect(260, 394);
  resizeCallback();
  assert.deepEqual(calls, ['s3'], 'a tab still inside the rail is left alone');

  rail.getBoundingClientRect = rect(0, 300);
  resizeCallback();
  assert.deepEqual(calls, ['s3', 's3'], 'the narrowed rail brings the active tab back');
});
