const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createCompanionManager } = require('../renderer/features/renderer-companion-utils.js');
const inventoryContextMenu = require('../renderer/inventory/context-menu.js');

test('an open-loop body that strictly extends its title remains visible', () => {
  const dom = new JSDOM('<main id="home"><span id="activeCount"></span><p id="activeStatus"></p><div id="active"></div><section id="deferred"><span id="deferredCount"></span><p id="deferredStatus"></p><div id="deferredList"></div></section><section id="resolved"><span id="resolvedCount"></span><p id="resolvedStatus"></p><div id="resolvedList"></div></section><section id="archived"><span id="archivedCount"></span><p id="archivedStatus"></p><div id="archivedList"></div></section></main>');
  const documentRef = dom.window.document;
  const loop = {
    followUpId: 'loop-1',
    status: 'active',
    title: 'Fix parser',
    body: 'Fix parser when CRLF input is received',
    actions: [],
  };
  const state = {
    ui: { activeView: 'home' },
    companion: {
      loaded: true,
      openLoopsBoard: {
        active: [loop], deferred: [], recentResolved: [], archived: [],
        counts: { active: 1, deferred: 0, recentResolved: 0, archived: 0 },
      },
    },
  };
  const byId = (id) => documentRef.getElementById(id);
  const manager = createCompanionManager({
    state,
    dom: {
      homeView: byId('home'),
      homeOpenLoopCount: byId('activeCount'),
      homeOpenLoopStatus: byId('activeStatus'),
      homeOpenLoopList: byId('active'),
      homeDeferredSection: byId('deferred'),
      homeDeferredLoopCount: byId('deferredCount'),
      homeDeferredLoopStatus: byId('deferredStatus'),
      homeDeferredLoopList: byId('deferredList'),
      homeRecentResolvedSection: byId('resolved'),
      homeRecentResolvedCount: byId('resolvedCount'),
      homeRecentResolvedStatus: byId('resolvedStatus'),
      homeRecentResolvedList: byId('resolvedList'),
      homeArchivedSection: byId('archived'),
      homeArchivedLoopCount: byId('archivedCount'),
      homeArchivedLoopStatus: byId('archivedStatus'),
      homeArchivedLoopList: byId('archivedList'),
    },
    callbacks: {},
  });

  manager.renderHomePanel();

  assert.equal(byId('active').querySelector('.home-card-note')?.textContent, loop.body);
});

/* Subsection markup mirrors index.html: an <h4> heading names each section
 * (the toggles' accessible names read it) and each toggle's aria-controls
 * names its list. `rerender` wires renderAll to the board, as the shell does,
 * so a mutation's re-render runs; `callbacks` adds toast spies and the like. */
function createBoardHarness(board, { resolvedToggle = true, rerender = false, callbacks = {} } = {}) {
  const dom = new JSDOM('<main id="home"><span id="activeCount"></span><p id="activeStatus"></p><div id="active"></div><section id="deferred"><span id="deferredCount"></span><p id="deferredStatus"></p><div id="deferredList"></div></section><section id="resolved"><h4>Recently Completed</h4><span id="resolvedCount"></span>'
    + (resolvedToggle ? '<button id="resolvedToggle" data-home-resolved-toggle="true" aria-expanded="false" aria-controls="resolvedList" hidden>Show all</button>' : '')
    + '<p id="resolvedStatus"></p><div id="resolvedList"></div></section><section id="archived"><h4>Archived</h4><span id="archivedCount"></span><button id="archivedToggle" data-home-archived-toggle="true" aria-expanded="false" aria-controls="archivedList">Show</button><p id="archivedStatus"></p><div id="archivedList" hidden></div></section></main>');
  const documentRef = dom.window.document;
  const byId = (id) => documentRef.getElementById(id);
  const state = { ui: { activeView: 'home' }, companion: { loaded: true, openLoopsBoard: board } };
  let manager = null;
  manager = createCompanionManager({
    state,
    dom: {
      homeView: byId('home'),
      homeOpenLoopCount: byId('activeCount'),
      homeOpenLoopStatus: byId('activeStatus'),
      homeOpenLoopList: byId('active'),
      homeDeferredSection: byId('deferred'),
      homeDeferredLoopCount: byId('deferredCount'),
      homeDeferredLoopStatus: byId('deferredStatus'),
      homeDeferredLoopList: byId('deferredList'),
      homeRecentResolvedSection: byId('resolved'),
      homeRecentResolvedCount: byId('resolvedCount'),
      homeRecentResolvedStatus: byId('resolvedStatus'),
      homeRecentResolvedList: byId('resolvedList'),
      homeArchivedSection: byId('archived'),
      homeArchivedLoopCount: byId('archivedCount'),
      homeArchivedLoopStatus: byId('archivedStatus'),
      homeArchivedLoopList: byId('archivedList'),
      homeArchivedLoopToggle: byId('archivedToggle'),
    },
    callbacks: {
      ...(rerender ? { renderAll: () => manager.renderHomePanel() } : {}),
      ...callbacks,
    },
  });
  manager.bind();
  manager.renderHomePanel();
  return { manager, byId, state, window: dom.window };
}

/* Action placement per CompanionService._buildFollowUpActions: primary, then
 * inline, then the overflow menu (Edit, Archive for resolved, Delete). */
function loopAction(type, slot, label, labelKey, followUpId) {
  return { id: `${type}:${followUpId}`, type, label, labelKey, slot, followUpId };
}

function activeLoop(followUpId, title) {
  return {
    followUpId,
    status: 'active',
    title,
    actions: [
      loopAction('resolve_follow_up', 'primary', 'Done', 'companion.actions.done', followUpId),
      loopAction('defer_follow_up', 'inline', 'Later', 'companion.actions.later', followUpId),
      loopAction('edit_follow_up', 'overflow', 'Edit', 'companion.actions.edit', followUpId),
      loopAction('delete_follow_up', 'overflow', 'Delete', 'companion.actions.delete', followUpId),
    ],
  };
}

function resolvedLoopFor(followUpId, title) {
  return {
    followUpId,
    status: 'resolved',
    title,
    resolvedAt: '2026-09-28T15:00:00.000Z',
    history: [{ kind: 'resolved', at: '2026-09-28T15:00:00.000Z', detail: 'Marked complete.' }],
    actions: [
      loopAction('activate_follow_up', 'inline', 'Reopen', 'companion.actions.reopen', followUpId),
      loopAction('edit_follow_up', 'overflow', 'Edit', 'companion.actions.edit', followUpId),
      loopAction('archive_follow_up', 'overflow', 'Archive', 'companion.actions.archive', followUpId),
      loopAction('delete_follow_up', 'overflow', 'Delete', 'companion.actions.delete', followUpId),
    ],
  };
}

function archivedLoopFor(followUpId, title) {
  return {
    followUpId,
    status: 'archived',
    title,
    archivedAt: '2026-09-28T16:00:00.000Z',
    actions: [
      loopAction('unarchive_follow_up', 'inline', 'Restore', 'companion.actions.restore', followUpId),
      loopAction('edit_follow_up', 'overflow', 'Edit', 'companion.actions.edit', followUpId),
      loopAction('delete_follow_up', 'overflow', 'Delete', 'companion.actions.delete', followUpId),
    ],
  };
}

function boardPayload(openLoopsBoard) {
  return { loaded: true, openLoopsBoard };
}

function boardOf({ active = [], deferred = [], recentResolved = [], archived = [] } = {}) {
  return {
    active,
    deferred,
    recentResolved,
    archived,
    counts: {
      active: active.length,
      deferred: deferred.length,
      recentResolved: recentResolved.length,
      archived: archived.length,
    },
  };
}

/* The manager and its action handlers read jennyShell and the context menu
 * from globalThis at call time. */
function installGlobals(t, { companion = {}, contextMenu = inventoryContextMenu } = {}) {
  const previousShell = globalThis.jennyShell;
  const previousMenu = globalThis.inventoryContextMenu;
  globalThis.jennyShell = { companion };
  globalThis.inventoryContextMenu = contextMenu;
  t.after(() => {
    inventoryContextMenu.hide({ restoreFocus: false });
    globalThis.jennyShell = previousShell;
    globalThis.inventoryContextMenu = previousMenu;
  });
}

/* setImmediate is never mocked here, so it drains the promise chains a click
 * starts (animation check, IPC, re-render). */
async function settle(rounds = 3) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/* The real overflow menu: the row's menu button, then the item by label. */
function chooseMenuItem(window, trigger, label) {
  trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const item = [...window.document.querySelectorAll('body > .inv-context-menu .inv-context-menu-item')]
    .find((node) => node.textContent.trim() === label);
  assert.ok(item, `the overflow menu offers ${label}`);
  item.click();
}

function resolvedLoop(index) {
  return resolvedLoopFor(`done-${index}`, `Finished ${index}`);
}

test('completed rows carry no filled button and keep one action layout', () => {
  const { byId } = createBoardHarness({
    active: [], deferred: [], recentResolved: [resolvedLoop(1)], archived: [],
    counts: { active: 0, deferred: 0, recentResolved: 1, archived: 0 },
  });
  const row = byId('resolvedList').querySelector('.home-summary-item');
  assert.equal(row.querySelector('.btn--primary'), null);
  const bar = row.querySelector('.home-loop-actions');
  const order = [...bar.querySelectorAll('button')].map((node) => node.dataset.companionActionId || Object.keys(node.dataset)[0]);
  assert.deepEqual(order, ['activate_follow_up:done-1', 'loopHistoryToggle', 'loopOverflow']);
  const trailing = bar.lastElementChild;
  assert.ok(trailing.classList.contains('home-loop-actions__trailing'), 'History and the menu share one trailing group');
  assert.equal(trailing.children.length, 2);
  assert.match(row.querySelector('.home-loop-meta').textContent, /Completed/);
});

test('Recently Completed previews five, shows all on demand, and counts the true total', () => {
  const loops = Array.from({ length: 7 }, (_value, index) => resolvedLoop(index + 1));
  const { byId, window } = createBoardHarness({
    active: [], deferred: [], recentResolved: loops, archived: [],
    counts: { active: 0, deferred: 0, recentResolved: 7, archived: 0 },
  });
  assert.equal(byId('resolvedCount').textContent, '7');
  assert.equal(byId('resolvedList').children.length, 5);
  const toggle = byId('resolvedToggle');
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.getAttribute('aria-controls'), byId('resolvedList').id);
  assert.equal(toggle.textContent, 'Show all');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  // The accessible name starts with the visible text and names the section.
  assert.equal(toggle.getAttribute('aria-label'), 'Show all: Recently Completed');

  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(byId('resolvedList').children.length, 7);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.textContent, 'Show less');
  assert.equal(toggle.getAttribute('aria-label'), 'Show less: Recently Completed');
  assert.equal(toggle.getAttribute('aria-controls'), byId('resolvedList').id, 'a render never drops aria-controls');

  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(byId('resolvedList').children.length, 5);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.textContent, 'Show all');
  assert.equal(toggle.getAttribute('aria-label'), 'Show all: Recently Completed');
});

test('the shipped Recently Completed toggle controls its own list under the section heading', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const { document } = new JSDOM(html).window;
  const toggle = document.querySelector('[data-home-resolved-toggle]');
  const section = document.getElementById('homeRecentResolvedSection');
  assert.ok(toggle && section?.contains(toggle));
  const list = document.getElementById(toggle.getAttribute('aria-controls'));
  assert.equal(list?.id, 'homeRecentResolvedList');
  assert.ok(section.contains(list));
  assert.ok(section.querySelector('h4')?.textContent.trim(), 'the section heading names the toggle');
});

test('an opened History list survives a re-render', () => {
  const { manager, byId, window } = createBoardHarness({
    active: [], deferred: [], recentResolved: [resolvedLoop(1)], archived: [],
    counts: { active: 0, deferred: 0, recentResolved: 1, archived: 0 },
  });
  const historyToggle = () => byId('resolvedList').querySelector('[data-loop-history-toggle]');
  const historyList = () => byId('resolvedList').querySelector('.home-loop-history-list');
  assert.equal(historyList().hidden, true);
  historyToggle().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  manager.renderHomePanel();
  assert.equal(historyList().hidden, false);
  assert.equal(historyToggle().getAttribute('aria-expanded'), 'true');
  assert.equal(historyToggle().getAttribute('aria-controls'), historyList().id);
});

test('re-renders keep the due-refresh deadline instead of pushing it back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-29T12:00:00.000Z') });
  let refreshes = 0;
  const previousShell = globalThis.jennyShell;
  globalThis.jennyShell = { companion: { getState: async () => { refreshes += 1; return { loaded: true }; } } };
  t.after(() => { globalThis.jennyShell = previousShell; });
  const deferred = {
    followUpId: 'later-1',
    status: 'deferred',
    title: 'Later',
    deferredUntil: '2026-09-29T12:00:40.000Z',
    actions: [],
  };
  const { manager } = createBoardHarness({
    active: [], deferred: [deferred], recentResolved: [], archived: [],
    counts: { active: 0, deferred: 1, recentResolved: 0, archived: 0 },
  });

  t.mock.timers.tick(20000);
  manager.renderHomePanel();
  t.mock.timers.tick(20000);
  await Promise.resolve();
  assert.equal(refreshes, 1, 'the refresh fires at the original deadline');
  manager.dispose();
});

test('Done hands focus to the next Active row, not to the loop now in Recently Completed', async (t) => {
  installGlobals(t, {
    companion: {
      resolveFollowUp: async () => boardPayload(boardOf({
        active: [activeLoop('loop-2', 'Second')],
        recentResolved: [resolvedLoopFor('loop-1', 'First')],
      })),
    },
  });
  const { byId, window } = createBoardHarness(boardOf({
    active: [activeLoop('loop-1', 'First'), activeLoop('loop-2', 'Second')],
  }), { rerender: true });
  const done = byId('active').querySelector('[data-companion-action-id="resolve_follow_up:loop-1"]');
  assert.ok(done.classList.contains('btn--primary'), 'Done is the row primary');
  done.focus();
  done.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await settle();

  assert.ok(byId('resolvedList').querySelector('[data-follow-up-id="loop-1"]'), 'loop 1 moved to Recently Completed');
  const focused = window.document.activeElement;
  assert.ok(byId('active').contains(focused), 'focus stays in the Active list');
  assert.equal(focused.dataset.companionActionId, 'resolve_follow_up:loop-2', 'the row now at that index gets its first action');
});

test('Archive from the overflow menu keeps focus in Recently Completed', async (t) => {
  installGlobals(t, {
    companion: {
      archiveFollowUp: async () => boardPayload(boardOf({
        recentResolved: [resolvedLoop(2)],
        archived: [archivedLoopFor('done-1', 'Finished 1'), archivedLoopFor('old-1', 'Old')],
      })),
    },
  });
  const { byId, window } = createBoardHarness(boardOf({
    recentResolved: [resolvedLoop(1), resolvedLoop(2)],
    archived: [archivedLoopFor('old-1', 'Old')],
  }), { rerender: true });
  // Expanded, so the archived copy of the loop is on the page to be wrongly found.
  byId('archivedToggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const trigger = byId('resolvedList').querySelector('[data-loop-overflow="done-1"]');
  trigger.focus();
  chooseMenuItem(window, trigger, 'Archive');
  await settle();

  assert.ok(byId('archivedList').querySelector('[data-follow-up-id="done-1"]'), 'the loop moved to Archived');
  const focused = window.document.activeElement;
  assert.ok(byId('resolvedList').contains(focused), 'focus stays in Recently Completed');
  assert.equal(focused.dataset.companionActionId, 'activate_follow_up:done-2');
});

test('a pending delete hides the row and its count, and a failed commit brings both back with an error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deleteCalls = [];
  const errorToasts = [];
  const dismissed = [];
  installGlobals(t, {
    companion: {
      deleteFollowUp: async (followUpId) => {
        deleteCalls.push(followUpId);
        throw new Error('disk is full');
      },
    },
  });
  const { byId, state, window } = createBoardHarness(boardOf({
    active: [activeLoop('loop-1', 'First'), activeLoop('loop-2', 'Second')],
  }), {
    rerender: true,
    callbacks: {
      showToastMessage: () => 'undo-toast',
      dismissToast: (id) => dismissed.push(id),
      showShellErrorToast: (message, options) => errorToasts.push({ message, options }),
    },
  });
  assert.equal(byId('activeCount').textContent, '2');
  assert.equal(
    byId('active').querySelector('[data-companion-action-id="delete_follow_up:loop-1"]'),
    null,
    'Delete lives in the overflow menu'
  );

  chooseMenuItem(window, byId('active').querySelector('[data-loop-overflow="loop-1"]'), 'Delete');
  await settle();

  assert.equal(byId('active').querySelector('[data-follow-up-id="loop-1"]'), null, 'the row hides at once');
  assert.equal(byId('activeCount').textContent, '1');
  assert.equal(byId('activeStatus').textContent, '1 active.');
  assert.deepEqual(state.ui.pendingLoopDeleteIds, ['loop-1']);
  assert.deepEqual(deleteCalls, [], 'the IPC call waits out the undo window');

  t.mock.timers.tick(5999);
  await settle();
  assert.deepEqual(deleteCalls, []);
  t.mock.timers.tick(1);
  await settle();

  assert.deepEqual(deleteCalls, ['loop-1']);
  assert.deepEqual(dismissed, ['undo-toast'], 'Undo leaves once the commit starts');
  assert.ok(byId('active').querySelector('[data-follow-up-id="loop-1"]'), 'the row comes back');
  assert.equal(byId('activeCount').textContent, '2');
  assert.equal(byId('activeStatus').textContent, '2 active.');
  assert.deepEqual(state.ui.pendingLoopDeleteIds, []);
  assert.equal(errorToasts.length, 1);
  assert.match(errorToasts[0].message, /disk is full/);
  assert.equal(errorToasts[0].options.title, 'Open Loop Failed');
});

test('leaving Home clears the due refresh; returning re-arms it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-29T12:00:00.000Z') });
  let refreshes = 0;
  installGlobals(t, { companion: { getState: async () => { refreshes += 1; return { loaded: true }; } } });
  const deferred = { followUpId: 'later-1', status: 'deferred', title: 'Later', deferredUntil: '2026-09-29T12:00:40.000Z', actions: [] };
  const { manager, state } = createBoardHarness(boardOf({ deferred: [deferred] }));

  state.ui.activeView = 'chat';
  manager.renderHomePanel();
  // The view flag flips back before Home re-renders: a timer that survived
  // the render away would fire now.
  state.ui.activeView = 'home';
  t.mock.timers.tick(40000);
  await settle();
  assert.equal(refreshes, 0, 'no refresh fires after Home was left');

  manager.renderHomePanel();
  t.mock.timers.tick(30000);
  await settle();
  assert.equal(refreshes, 1, 'rendering Home again arms a fresh timer');
  manager.dispose();
});

test('a failed due refresh re-arms after the minimum delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-29T12:00:00.000Z') });
  let refreshes = 0;
  installGlobals(t, {
    companion: {
      getState: async () => {
        refreshes += 1;
        if (refreshes === 1) {
          throw new Error('main process busy');
        }
        return { loaded: true };
      },
    },
  });
  const deferred = { followUpId: 'later-1', status: 'deferred', title: 'Later', deferredUntil: '2026-09-29T12:00:40.000Z', actions: [] };
  const { manager } = createBoardHarness(boardOf({ deferred: [deferred] }));

  t.mock.timers.tick(40000);
  await settle();
  assert.equal(refreshes, 1, 'the first refresh fires at the deadline and fails');
  t.mock.timers.tick(29999);
  await settle();
  assert.equal(refreshes, 1, 'the retry waits the 30 s minimum');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(refreshes, 2, 'the retry fires');
  manager.dispose();
});
