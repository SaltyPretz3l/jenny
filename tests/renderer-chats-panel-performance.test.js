const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const actionButton = require('../renderer/inventory/action-button');
const segmentedControl = require('../renderer/inventory/segmented-control');
const { createStreamHandlerRuntime } = require('../renderer/chat/renderer-stream-handler-runtime');
const {
  PAGE_SIZE,
  MAX_VISIBLE,
  SEARCH_LIMIT,
  buildChatsViewModel,
  groupVisibleSessions,
  formatSessionTime,
  createChatsPanelController,
} = require('../renderer/shell/renderer-chats-panel');

function buildSessions(count, extra = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    title: `Chat ${index}`,
    last_message_preview: `Preview ${index}`,
    updated_at: new Date(Date.UTC(2026, 7, 14, 12, 0, 0) - index * 1000).toISOString(),
    created_at: new Date(Date.UTC(2026, 7, 14, 12, 0, 0) - index * 1000).toISOString(),
    pinned: false,
    archived_at: null,
    ...extra,
  }));
}

function createControllerHarness({ sessions = buildSessions(2), nowStep = 0, provideEscapeHtml = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="scope"></div><input id="search"><div id="count"></div><div id="groups"></div><div id="status"></div></body></html>');
  const frames = [];
  let frameId = 0;
  let nowValue = 0;
  const logs = [];
  const afterRenderCalls = [];
  const newChatCalls = [];
  const windowRef = {
    performance: { now: () => (nowValue += nowStep) },
    requestAnimationFrame(callback) {
      frames.push(callback);
      frameId += 1;
      return frameId;
    },
    cancelAnimationFrame() {},
  };
  const state = {
      sessions,
      currentSessionId: sessions[0]?.id || '',
      ui: { pendingSessionDeletes: [] },
      sendOutboxBySession: new Map(),
    };
  const callbacks = {
    afterRenderSessions: (rows) => afterRenderCalls.push(rows.length),
    appendClientLog: (level, eventName, details) => logs.push({ level, eventName, details }),
    newChat: () => newChatCalls.push(true),
  };
  if (provideEscapeHtml) callbacks.escapeHtml = actionButton.escapeHtml;
  const controller = createChatsPanelController({
    state,
    documentRef: dom.window.document,
    windowRef,
    dom: {
      scopeSlot: dom.window.document.getElementById('scope'),
      searchInput: dom.window.document.getElementById('search'),
      conversationCount: dom.window.document.getElementById('count'),
      conversationGroups: dom.window.document.getElementById('groups'),
      status: dom.window.document.getElementById('status'),
    },
    inventory: { actionButton, segmentedControl },
    callbacks,
  });
  return { dom, controller, frames, logs, afterRenderCalls, state, newChatCalls };
}

function localDayIso(now, dayOffset, hour = 8) {
  const value = new Date(now);
  value.setHours(hour, 0, 0, 0);
  value.setDate(value.getDate() - dayOffset);
  return value.toISOString();
}

function installFixedRowLayout(harness, { clientHeight = 200, rowHeight = 40 } = {}) {
  const groups = harness.dom.window.document.getElementById('groups');
  Object.defineProperty(groups, 'clientHeight', { configurable: true, value: clientHeight });
  Object.defineProperty(groups, 'scrollHeight', {
    configurable: true,
    get: () => harness.controller.getVisibleSessionElements().length * rowHeight,
  });
  groups.getBoundingClientRect = () => ({
    top: 0,
    bottom: clientHeight,
    left: 0,
    right: 320,
    width: 320,
    height: clientHeight,
  });
  const refreshRows = () => {
    [...harness.controller.getVisibleSessionElements()].forEach((row) => {
      row.getBoundingClientRect = () => {
        const rows = [...harness.controller.getVisibleSessionElements()];
        const index = rows.indexOf(row);
        const top = index * rowHeight - groups.scrollTop;
        return {
          top,
          bottom: top + rowHeight,
          left: 0,
          right: 320,
          width: 320,
          height: rowHeight,
        };
      };
    });
  };
  refreshRows();
  return { groups, refreshRows, rowHeight };
}

test('the progressive model caps ordinary history and full-history search deterministically', () => {
  const sessions = buildSessions(5000);
  const initial = buildChatsViewModel({ sessions, visibleLimit: PAGE_SIZE });
  assert.equal(initial.matchedCount, 5000);
  assert.equal(initial.visibleCount, PAGE_SIZE);
  assert.equal(initial.hasMore, true);

  const capped = buildChatsViewModel({ sessions, visibleLimit: MAX_VISIBLE });
  assert.equal(capped.visibleCount, MAX_VISIBLE);
  assert.equal(capped.hasMore, false);
  assert.equal(capped.capped, true);

  const search = buildChatsViewModel({ sessions, query: 'chat', visibleLimit: MAX_VISIBLE });
  assert.equal(search.matchedCount, 5000, 'search examines the complete history');
  assert.equal(search.visibleCount, SEARCH_LIMIT);
  assert.equal(search.capped, true);
});

test('search normalizes absent fields and pending deletes do not inflate archive counts', () => {
  const sessions = [
    { id: 'blank', title: undefined, last_message_preview: null, archived_at: null },
    { id: 'archived', title: 'Archived', last_message_preview: '', archived_at: '2026-08-10T00:00:00.000Z' },
    { id: 'deleting', title: 'Deleting', last_message_preview: '', archived_at: '2026-08-11T00:00:00.000Z' },
  ];
  assert.equal(buildChatsViewModel({ sessions, query: 'undefined' }).matchedCount, 0);
  assert.equal(buildChatsViewModel({ sessions, query: 'null' }).matchedCount, 0);
  const archived = buildChatsViewModel({
    sessions,
    scope: 'archived',
    pendingDeleteIds: new Set(['deleting']),
  });
  assert.equal(archived.archivedTotal, 1);
  assert.deepEqual(archived.visibleSessions.map((session) => session.id), ['archived']);
});

test('calendar groups use local day boundaries in both scopes and keep invalid dates in Older', () => {
  const now = new Date(2026, 7, 14, 12, 0, 0, 0);
  const sessions = [
    { id: 'pinned', updated_at: localDayIso(now, 40), pinned: true },
    { id: 'today', updated_at: localDayIso(now, 0) },
    { id: 'yesterday', updated_at: localDayIso(now, 1) },
    { id: 'week', updated_at: localDayIso(now, 7) },
    { id: 'month', updated_at: localDayIso(now, 30) },
    { id: 'older', updated_at: localDayIso(now, 31) },
    { id: 'invalid', updated_at: 'not-a-date' },
  ];
  const expected = ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'];
  assert.deepEqual(
    groupVisibleSessions(sessions, 'recent', now).map((group) => group.label),
    expected
  );
  assert.deepEqual(
    groupVisibleSessions(sessions, 'archived', now).map((group) => group.label),
    expected,
    'Archived uses the same chronology as Recent'
  );
});

test('calendar grouping remains stable across DST and year boundaries', () => {
  const dstNow = new Date(2026, 2, 10, 12, 0, 0, 0);
  const dstGroups = groupVisibleSessions([
    { id: 'dst-yesterday', updated_at: localDayIso(dstNow, 1) },
    { id: 'dst-week', updated_at: localDayIso(dstNow, 7) },
    { id: 'dst-month', updated_at: localDayIso(dstNow, 30) },
  ], 'recent', dstNow);
  assert.deepEqual(dstGroups.map((group) => group.label), [
    'Yesterday',
    'Previous 7 days',
    'Previous 30 days',
  ]);

  const newYearNow = new Date(2026, 0, 2, 12, 0, 0, 0);
  assert.deepEqual(
    groupVisibleSessions([
      { id: 'jan-1', updated_at: localDayIso(newYearNow, 1) },
      { id: 'dec-31', updated_at: localDayIso(newYearNow, 2) },
    ], 'recent', newYearNow).map((group) => group.label),
    ['Yesterday', 'Previous 7 days']
  );
});

test('session time labels use relative recent values and explicit calendar dates when older', () => {
  const now = new Date(2026, 7, 14, 12, 0, 0, 0);
  assert.equal(formatSessionTime(new Date(now.valueOf() - 50 * 60 * 1000), now), '50m');
  assert.equal(formatSessionTime(localDayIso(now, 2), now), 'Aug 12');
  assert.equal(formatSessionTime(localDayIso(now, 7), now), 'Aug 7');
  assert.equal(formatSessionTime(new Date(2025, 7, 7, 8, 0, 0, 0), now), 'Aug 7, 2025');
  assert.equal(formatSessionTime('not-a-date', now), '');
});

test('session calendar groups follow local days across spring-forward DST', () => {
  const afterSpringForward = new Date('2026-03-10T08:00:00-05:00');
  const sixCalendarDaysEarlier = new Date('2026-03-04T08:00:00-06:00');
  const groups = groupVisibleSessions(
    [{ id: 'six-days-back', updated_at: sixCalendarDaysEarlier.toISOString() }],
    'recent',
    afterSpringForward
  );
  assert.deepEqual(groups.map((group) => group.label), ['Previous 7 days']);
  assert.deepEqual(groups[0].items.map((session) => session.id), ['six-days-back']);
});

test('structural requests coalesce and keyed reconciliation preserves rename, focus, and scroll state', () => {
  const harness = createControllerHarness();
  harness.controller.renderNow();
  const firstRow = harness.dom.window.document.querySelector('[data-session-id="session-0"]');
  const editor = harness.dom.window.document.createElement('input');
  editor.className = 'inv-inline-title-editor';
  editor.value = 'Draft rename';
  firstRow.querySelector('.session-row__title').replaceChildren(editor);
  harness.dom.window.document.getElementById('groups').scrollTop = 73;
  harness.state.sessions[0].updated_at = new Date(Date.now()).toISOString();
  harness.controller.renderNow();
  assert.equal(harness.dom.window.document.querySelector('[data-session-id="session-0"]'), firstRow);
  assert.equal(editor.isConnected, true, 'changed rows retain an in-progress rename editor');
  assert.equal(editor.value, 'Draft rename');
  assert.equal(harness.dom.window.document.getElementById('groups').scrollTop, 73, 'reconciliation preserves scroll position');

  editor.remove();
  harness.controller.renderNow();
  const open = firstRow.querySelector('[data-session-open]');
  open.focus();
  harness.state.sessions[0].updated_at = new Date(Date.now() + 1000).toISOString();
  harness.controller.renderNow();
  assert.equal(harness.dom.window.document.activeElement, firstRow.querySelector('[data-session-open]'), 'changed focused controls reclaim focus');

  harness.controller.renderSessions();
  harness.controller.renderSessions();
  harness.controller.renderSessions({ resetLimit: true });
  assert.equal(harness.frames.length, 1, 'a burst queues only one animation-frame render');
  harness.frames.shift()();
  assert.equal(harness.frames.length, 0);
  harness.controller.dispose();
  harness.dom.window.close();
});

test('scope replacement preserves focus and empty states provide direct recovery actions', () => {
  const harness = createControllerHarness({ sessions: [] });
  harness.controller.renderNow();
  const emptyAction = harness.dom.window.document.querySelector('[data-chats-empty-action="empty"]');
  assert.equal(emptyAction.textContent.trim(), 'New chat');
  emptyAction.click();
  assert.equal(harness.newChatCalls.length, 1);

  harness.state.sessions = buildSessions(1).concat(buildSessions(1, {
    id: 'archived', title: 'Archived', archived_at: '2026-08-01T00:00:00.000Z',
  }));
  harness.controller.renderNow();
  const archived = harness.dom.window.document.querySelector('[data-value="archived"]');
  archived.focus();
  harness.controller.setScope('archived');
  harness.frames.shift()();
  assert.equal(harness.dom.window.document.activeElement, harness.dom.window.document.querySelector('[data-value="archived"]'));

  harness.controller.setScope('recent');
  harness.frames.shift()();
  const search = harness.dom.window.document.getElementById('search');
  search.value = 'does-not-exist';
  harness.controller.renderNow();
  harness.dom.window.document.querySelector('[data-chats-empty-action="search"]').click();
  harness.frames.shift()();
  assert.equal(search.value, '');
  assert.equal(harness.dom.window.document.activeElement, search);
  harness.controller.dispose();
  harness.dom.window.close();
});

test('load-more activation mounts one bounded page at a time', () => {
  const harness = createControllerHarness({ sessions: buildSessions(250) });
  harness.controller.renderNow();
  assert.equal(harness.controller.getVisibleSessionElements().length, 100);
  const loadMore = harness.dom.window.document.querySelector('[data-chats-load-more]');
  loadMore.focus();

  harness.controller.loadMore();
  harness.frames.shift()();
  assert.equal(harness.controller.getVisibleSessionElements().length, 200);
  assert.equal(loadMore.isConnected, true, 'paging updates the existing control instead of replacing it');
  assert.equal(harness.dom.window.document.activeElement, loadMore, 'the mounted Load more control retains keyboard focus');
  harness.controller.loadMore();
  harness.frames.shift()();
  assert.equal(harness.controller.getVisibleSessionElements().length, 250);
  assert.equal(harness.dom.window.document.querySelector('[data-chats-pagination]'), null);
  assert.equal(
    harness.dom.window.document.activeElement.getAttribute('data-session-open'),
    'session-200',
    'the final page moves focus to the first newly mounted session rather than BODY'
  );
  harness.controller.dispose();
  harness.dom.window.close();
});

test('reaching the ordinary history cap keeps focus on the limit message', () => {
  const harness = createControllerHarness({ sessions: buildSessions(501) });
  harness.controller.renderNow();
  for (let page = 0; page < 4; page += 1) {
    const loadMore = harness.dom.window.document.querySelector('[data-chats-load-more]');
    loadMore.focus();
    harness.controller.loadMore();
    harness.frames.shift()();
  }
  const pagination = harness.dom.window.document.querySelector('[data-chats-pagination]');
  assert.match(pagination.textContent, /newest 500 chats/i);
  assert.equal(harness.dom.window.document.activeElement, pagination);
  assert.equal(pagination.tabIndex, -1, 'the programmatic focus target does not add another tab stop');
  harness.controller.dispose();
  harness.dom.window.close();
});

test('archiving a bottom row preserves the bottom scroll anchor without moving unchanged nodes', () => {
  const harness = createControllerHarness({ sessions: buildSessions(110) });
  harness.controller.renderNow();
  const { groups } = installFixedRowLayout(harness, { clientHeight: 200 });
  groups.scrollTop = groups.scrollHeight - groups.clientHeight;
  const unchanged = harness.dom.window.document.querySelector('[data-session-id="session-50"]');
  harness.state.sessions[99].archived_at = '2026-08-14T13:00:00.000Z';
  harness.controller.renderNow();
  assert.equal(groups.scrollTop, groups.scrollHeight - groups.clientHeight, 'the viewport stays pinned to the list bottom');
  assert.equal(harness.dom.window.document.querySelector('[data-session-id="session-50"]'), unchanged);
  harness.controller.dispose();
  harness.dom.window.close();
});

test('removing the visible anchor retains the next row at the same pixel offset', () => {
  const harness = createControllerHarness({ sessions: buildSessions(120) });
  harness.controller.renderNow();
  const { groups, rowHeight } = installFixedRowLayout(harness);
  groups.scrollTop = 50 * rowHeight + 7;
  const nextRow = harness.dom.window.document.querySelector('[data-session-id="session-51"]');

  harness.state.sessions[50].archived_at = '2026-08-14T13:00:00.000Z';
  harness.controller.renderNow();

  assert.equal(groups.scrollTop, 50 * rowHeight + 7, 'the nearest next row keeps the removed anchor offset');
  assert.equal(harness.dom.window.document.querySelector('[data-session-id="session-51"]'), nextRow);
  assert.equal(nextRow.getBoundingClientRect().top, -7);
  harness.controller.dispose();
  harness.dom.window.close();
});

test('pinning the visible anchor preserves its old row neighborhood instead of following it to the top', () => {
  const harness = createControllerHarness({ sessions: buildSessions(120) });
  harness.controller.renderNow();
  const { groups, rowHeight } = installFixedRowLayout(harness);
  groups.scrollTop = 50 * rowHeight + 7;
  const nextRow = harness.dom.window.document.querySelector('[data-session-id="session-51"]');

  harness.state.sessions[50].pinned = true;
  harness.controller.renderNow();

  assert.equal(
    nextRow.getBoundingClientRect().top,
    -7,
    'the next surviving row takes the moved anchor\'s former viewport offset'
  );
  assert.equal(
    groups.scrollTop,
    51 * rowHeight + 7,
    'scroll restoration stays with the old neighborhood rather than the newly pinned row'
  );
  assert.equal(
    harness.controller.getVisibleSessionElements()[0].dataset.sessionId,
    'session-50',
    'the pinned row still moves to its correct sorted position'
  );
  harness.controller.dispose();
  harness.dom.window.close();
});

test('removing a focused row moves focus and the roving tabstop without a second scroll jump', () => {
  const harness = createControllerHarness({ sessions: buildSessions(120) });
  harness.controller.renderNow();
  const { groups, rowHeight } = installFixedRowLayout(harness);
  groups.scrollTop = 50 * rowHeight + 7;
  const removedOpen = harness.dom.window.document.querySelector('[data-session-id="session-50"] [data-session-open]');
  removedOpen.focus();

  harness.state.sessions[50].archived_at = '2026-08-14T13:00:00.000Z';
  harness.controller.renderNow();

  const nextRow = harness.dom.window.document.querySelector('[data-session-id="session-51"]');
  assert.equal(harness.dom.window.document.activeElement, nextRow.querySelector('[data-session-open]'));
  assert.equal(nextRow.querySelector('[data-session-open]').getAttribute('tabindex'), '0');
  assert.equal(nextRow.querySelector('[data-session-action="menu"]').getAttribute('tabindex'), '0');
  assert.equal(groups.scrollTop, 50 * rowHeight + 7);
  harness.controller.dispose();
  harness.dom.window.close();
});

test('search and scope changes reset the history viewport to the top', () => {
  const sessions = buildSessions(120).concat([{
    id: 'archived',
    title: 'Archived',
    last_message_preview: '',
    updated_at: '2026-08-01T00:00:00.000Z',
    created_at: '2026-08-01T00:00:00.000Z',
    archived_at: '2026-08-02T00:00:00.000Z',
  }]);
  const harness = createControllerHarness({ sessions });
  harness.controller.renderNow();
  const { groups } = installFixedRowLayout(harness);
  groups.scrollTop = 800;
  const search = harness.dom.window.document.getElementById('search');
  search.value = 'Chat 1';
  harness.controller.renderSessions({ resetLimit: true });
  harness.frames.shift()();
  assert.equal(groups.scrollTop, 0, 'a query change resets to the first result');

  search.value = '';
  harness.controller.renderSessions({ resetLimit: true });
  harness.frames.shift()();
  groups.scrollTop = 800;
  harness.controller.setScope('archived');
  harness.frames.shift()();
  assert.equal(groups.scrollTop, 0, 'a scope change resets to its first row');
  harness.controller.dispose();
  harness.dom.window.close();
});

test('runtime badge patches do not structurally rebuild and slow warnings are bounded and content-free', () => {
  const harness = createControllerHarness({ nowStep: 40 });
  harness.controller.renderNow();
  const firstRow = harness.dom.window.document.querySelector('[data-session-id="session-0"]');
  harness.controller.patchRuntimeState();
  assert.equal(harness.dom.window.document.querySelector('[data-session-id="session-0"]'), firstRow);
  harness.controller.renderNow();

  const slowWarnings = harness.logs.filter((entry) => entry.eventName === 'sidebar.render_slow');
  assert.equal(slowWarnings.length, 1, 'warnings are limited to one per 30-second window');
  assert.deepEqual(Object.keys(slowWarnings[0].details).sort(), ['durationMs', 'sessionCount', 'visibleCount']);
  assert.doesNotMatch(JSON.stringify(slowWarnings), /Chat 0|Preview 0|session-0/);
  harness.controller.dispose();
  harness.dom.window.close();
});

test('session titles and previews remain escaped at the DOM boundary', () => {
  const harness = createControllerHarness({
    provideEscapeHtml: false,
    sessions: [{
      id: 'unsafe',
      title: '<img src=x onerror=alert(1)>',
      last_message_preview: '</button><script>alert(1)</script>',
      updated_at: '2026-08-14T12:00:00.000Z',
      created_at: '2026-08-14T12:00:00.000Z',
    }],
  });
  harness.controller.renderNow();
  const row = harness.dom.window.document.querySelector('[data-session-id="unsafe"]');
  assert.equal(row.querySelector('img, script'), null);
  assert.equal(row.querySelector('.session-row__title-text').textContent, '<img src=x onerror=alert(1)>');
  assert.match(row.querySelector('[data-session-open]').getAttribute('title'), /<script>alert\(1\)<\/script>/);
  harness.controller.dispose();
  harness.dom.window.close();
});

test('background chrome updates avoid structural history renders without suppressing explicit structural work', () => {
  const calls = { chrome: 0, sessions: 0 };
  const chromeOptions = [];
  const runtime = createStreamHandlerRuntime({
    state: { ui: { activeView: 'chat' } },
    renderWorkspaceChrome: (options) => { calls.chrome += 1; chromeOptions.push(options); },
    renderSessions: () => { calls.sessions += 1; },
  });
  runtime.queueRender({ chrome: true }, { immediate: true });
  assert.deepEqual(calls, { chrome: 1, sessions: 0 });
  assert.equal(chromeOptions[0].runtimeOnly, true);

  runtime.queueRender({ chrome: true, sessions: true }, { immediate: true });
  assert.deepEqual(calls, { chrome: 2, sessions: 1 });
  assert.equal(chromeOptions[1].runtimeOnly, false);
  runtime.disposeRenderQueue();
});
