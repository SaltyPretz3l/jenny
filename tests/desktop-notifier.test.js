'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FIELD_LIMITS,
  MAX_LIVE_NOTIFICATIONS,
  createDesktopNotifier,
  isRuntimeChildSession,
  normalizeNotificationCandidate,
} = require('../services/main/desktop-notifier');
const { createWindow, createHarness, candidate } = require('./helpers/desktop-notifier-harness');

function assertSuppressed(harness, reason, category = 'replies') {
  assert.equal(harness.notifications.length, 0);
  assert.deepEqual(harness.logsFor('desktop_notifier.suppressed').at(-1), {
    level: 'INFO',
    event: 'desktop_notifier.suppressed',
    details: { reason, category },
  });
}

test('an unfocused window shows a default toast with only title, body and silent', () => {
  const harness = createHarness();

  assert.equal(harness.notifier.notify(candidate({ urgency: 'critical', hasReply: true })), true);

  assert.equal(harness.notifications.length, 1);
  assert.deepEqual(harness.notifications[0].options, {
    title: 'Reply ready',
    body: 'Trip planning',
    silent: false,
  });
  assert.equal(harness.notifications[0].showCalls, 1);
  assert.deepEqual(harness.logsFor('desktop_notifier.shown'), [{
    level: 'INFO', event: 'desktop_notifier.shown', details: { category: 'replies' },
  }]);
  assert.equal(harness.state.mainWindow.focusCalls, 0, 'emit never focuses the window');
  assert.equal(harness.state.mainWindow.restoreCalls, 0);
});

test('the feature flag off suppresses every candidate', () => {
  const harness = createHarness({ flag: false });
  assert.equal(harness.notifier.notify(candidate()), false);
  assertSuppressed(harness, 'flag_off');
});

test('a non-true flag value counts as off', () => {
  const harness = createHarness();
  harness.state.flag = 'true';
  assert.equal(harness.notifier.notify(candidate()), false);
  assertSuppressed(harness, 'flag_off');
});

test('the master switch off suppresses', () => {
  const harness = createHarness({ settings: { enabled: false } });
  assert.equal(harness.notifier.notify(candidate()), false);
  assertSuppressed(harness, 'disabled');
});

test('a category switched off suppresses only that category', () => {
  const harness = createHarness({ settings: { categories: { failures: false } } });
  assert.equal(harness.notifier.notify(candidate({ category: 'failures', title: 'Run failed' })), false);
  assertSuppressed(harness, 'category_off', 'failures');
  assert.equal(harness.notifier.notify(candidate({ category: 'permissions' })), true);
  assert.equal(harness.notifications.length, 1);
});

test('a visible focused window suppresses while onlyWhenUnfocused is on', () => {
  const harness = createHarness({ mainWindow: createWindow({ focused: true }) });
  assert.equal(harness.notifier.notify(candidate()), false);
  assertSuppressed(harness, 'focused');
});

test('onlyWhenUnfocused off shows even while the window is focused', () => {
  const harness = createHarness({
    settings: { onlyWhenUnfocused: false },
    mainWindow: createWindow({ focused: true }),
  });
  assert.equal(harness.notifier.notify(candidate()), true);
  assert.equal(harness.notifications.length, 1);
});

test('a minimized or hidden window counts as unfocused', () => {
  const minimized = createHarness({ mainWindow: createWindow({ focused: true, minimized: true }) });
  assert.equal(minimized.notifier.notify(candidate()), true);
  const hidden = createHarness({ mainWindow: createWindow({ focused: true, visible: false }) });
  assert.equal(hidden.notifier.notify(candidate()), true);
});

test('a runtime child session is suppressed; a failing lookup logs once and lets the toast through', () => {
  const harness = createHarness();
  harness.state.childSessions.add('session-1');
  assert.equal(harness.notifier.notify(candidate()), false);
  assertSuppressed(harness, 'child_session');
  assert.equal(harness.notifier.notify(candidate({ sessionId: 'session-2', key: 'turn-2' })), true);
  assert.equal(harness.notifications.length, 1);

  const broken = createHarness();
  broken.state.childLookupError = new Error('store offline');
  assert.equal(broken.notifier.notify(candidate()), true);
  assert.equal(broken.notifier.notify(candidate({ key: 'turn-2' })), true);
  assert.equal(broken.logsFor('desktop_notifier.child_lookup_failed').length, 1);
});

test('isRuntimeChildSession reads child_chat work for the session from the runtime store and never throws', () => {
  const records = {
    w1: { work_id: 'w1', input: { kind: 'immediate_chat' } },
    w2: { work_id: 'w2', input: { kind: 'child_chat' } },
  };
  const pages = { 'child-1': [['w1'], ['w2']], 'root-1': [['w1']] };
  const store = {
    listSummaries({ sessionId, cursor }) {
      if (sessionId === 'bad id') throw new Error('invalid_page_request');
      const list = pages[sessionId] || [[]];
      const index = cursor ? Number(cursor) : 0;
      return { items: list[index].map((work_id) => ({ work_id })), next_cursor: index + 1 < list.length ? String(index + 1) : null };
    },
    get: (workId) => records[workId] || null,
  };
  assert.equal(isRuntimeChildSession({ store }, 'child-1'), true, 'found on the second page');
  assert.equal(isRuntimeChildSession({ store }, 'root-1'), false);
  assert.equal(isRuntimeChildSession({ store }, 'unknown'), false);
  assert.equal(isRuntimeChildSession({ store }, 'bad id'), false);
  assert.equal(isRuntimeChildSession({ store }, ''), false);
  assert.equal(isRuntimeChildSession(null, 'child-1'), false);
  assert.equal(isRuntimeChildSession({ store: {} }, 'child-1'), false);
});

test('missing or destroyed main window suppresses', () => {
  const missing = createHarness({ mainWindow: null });
  assert.equal(missing.notifier.notify(candidate()), false);
  assertSuppressed(missing, 'no_window');

  const destroyedWindow = createWindow();
  destroyedWindow.destroyed = true;
  const destroyed = createHarness({ mainWindow: destroyedWindow });
  assert.equal(destroyed.notifier.notify(candidate()), false);
  assertSuppressed(destroyed, 'no_window');
});

test('unsupported notifications log one WARN across repeated candidates', () => {
  const harness = createHarness({ supported: false });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(harness.notifier.notify(candidate({ key: `turn-${index}` })), false);
  }
  assert.equal(harness.notifications.length, 0);
  assert.deepEqual(harness.logsFor('desktop_notifier.unsupported'), [{
    level: 'WARN', event: 'desktop_notifier.unsupported', details: {},
  }]);
});

test('suppression logs are deduped per reason and key', () => {
  const harness = createHarness({ settings: { enabled: false } });
  harness.notifier.notify(candidate());
  harness.notifier.notify(candidate());
  harness.notifier.notify(candidate({ key: 'turn-2' }));
  assert.equal(harness.logsFor('desktop_notifier.suppressed').length, 2);
});

test('invalid candidates are rejected without throwing', () => {
  const harness = createHarness();
  const invalid = [
    undefined,
    null,
    'reply',
    42,
    [candidate()],
    candidate({ category: 'reminders' }),
    candidate({ category: 'digest' }),
    candidate({ category: 5 }),
    candidate({ key: '' }),
    candidate({ key: '   ' }),
    candidate({ key: 7 }),
    candidate({ title: '' }),
    candidate({ title: { text: 'x' } }),
    candidate({ sessionId: 12 }),
    candidate({ body: ['x'] }),
  ];
  for (const value of invalid) {
    assert.doesNotThrow(() => {
      assert.equal(harness.notifier.notify(value), false);
    });
  }
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.logsFor('desktop_notifier.suppressed').length, 1, 'invalid logs once');
  assert.deepEqual(harness.logsFor('desktop_notifier.suppressed')[0].details, {
    reason: 'invalid', category: '',
  });
});

test('candidate normalization clips fields, strips control characters and drops extras', () => {
  const long = (char) => char.repeat(1000);
  const normalized = normalizeNotificationCandidate({
    category: 'replies',
    key: long('k'),
    sessionId: long('s'),
    title: `  Reply\u0007 ready${long('t')}`,
    body: long('b'),
    preview: long('p'),
    urgency: 'critical',
    actions: [{ type: 'button' }],
  });
  assert.deepEqual(Object.keys(normalized), ['category', 'key', 'sessionId', 'title', 'body', 'preview']);
  assert.equal(normalized.key.length, FIELD_LIMITS.key);
  assert.equal(normalized.sessionId.length, FIELD_LIMITS.sessionId);
  assert.equal(normalized.title.length, FIELD_LIMITS.title);
  assert.ok(normalized.title.startsWith('Reply ready'));
  assert.equal(normalized.body.length, FIELD_LIMITS.body);
  assert.equal(normalized.preview.length, FIELD_LIMITS.preview);
  assert.deepEqual(FIELD_LIMITS, { key: 120, sessionId: 80, title: 120, body: 240, preview: 240, conversation: 120, sender: 80 });

  const sparse = normalizeNotificationCandidate({ category: 'questions', key: 'q', title: 'Question' });
  assert.deepEqual(sparse, { category: 'questions', key: 'q', sessionId: '', title: 'Question', body: '' });
  const failurePreview = normalizeNotificationCandidate(candidate({ category: 'failures', preview: 'x' }));
  assert.equal(Object.hasOwn(failurePreview, 'preview'), false, 'preview is replies-only');
});

test('the reply preview replaces the body only when replyPreview is on', () => {
  const off = createHarness();
  off.notifier.notify(candidate({ preview: 'First line of the reply' }));
  assert.equal(off.notifications[0].options.body, 'Trip planning');

  const on = createHarness({ settings: { onlyWhenUnfocused: true, replyPreview: true } });
  on.notifier.notify(candidate({ preview: 'First line of the reply' }));
  on.notifier.notify(candidate({ key: 'turn-2' }));
  on.notifier.notify(candidate({ category: 'failures', key: 'turn-3', body: 'Error', preview: 'leak' }));
  assert.deepEqual(on.notifications.map((entry) => entry.options.body), [
    'First line of the reply',
    'Trip planning',
    'Error',
  ]);
});

test('silent follows the sound preference', () => {
  const muted = createHarness({ settings: { sound: false } });
  muted.notifier.notify(candidate());
  assert.equal(muted.notifications[0].options.silent, true);
  const audible = createHarness({ settings: { sound: true } });
  audible.notifier.notify(candidate());
  assert.equal(audible.notifications[0].options.silent, false);
});

test('a live category:key is deduped until its toast closes', () => {
  const harness = createHarness();
  assert.equal(harness.notifier.notify(candidate()), true);
  assert.equal(harness.notifier.notify(candidate()), false);
  assert.equal(harness.notifications.length, 1);
  assert.deepEqual(harness.logsFor('desktop_notifier.suppressed').at(-1).details, {
    reason: 'duplicate', category: 'replies',
  });
  assert.equal(harness.notifier.notify(candidate({ category: 'failures' })), true, 'other category');
  assert.equal(harness.notifications.length, 2);

  harness.notifications[0].emitClose();
  assert.equal(harness.notifier.notify(candidate()), true);
  assert.equal(harness.notifications.length, 3);
});

test('a sixth live toast closes the oldest one', () => {
  const harness = createHarness();
  for (let index = 0; index < MAX_LIVE_NOTIFICATIONS + 1; index += 1) {
    assert.equal(harness.notifier.notify(candidate({ key: `turn-${index}` })), true);
  }
  assert.equal(MAX_LIVE_NOTIFICATIONS, 5);
  assert.equal(harness.notifier.getLiveCount(), 5);
  assert.deepEqual(harness.notifications.map((entry) => entry.closeCalls), [1, 0, 0, 0, 0, 0]);
  // The evicted key is no longer live, so it may show again.
  assert.equal(harness.notifier.notify(candidate({ key: 'turn-0' })), true);
  assert.equal(harness.notifications[1].closeCalls, 1);
});

test('main window focus closes every live toast', () => {
  const harness = createHarness();
  harness.notifier.notify(candidate());
  harness.notifier.notify(candidate({ key: 'turn-2', category: 'permissions' }));
  assert.equal(harness.notifier.getLiveCount(), 2);

  harness.state.mainWindow.emit('focus');

  assert.deepEqual(harness.notifications.map((entry) => entry.closeCalls), [1, 1]);
  assert.equal(harness.notifier.getLiveCount(), 0);
  assert.equal(harness.notifier.notify(candidate()), true, 'closed keys may fire again');
});

test('the focus listener follows a replaced main window and detaches on stop', () => {
  const harness = createHarness();
  const firstWindow = harness.state.mainWindow;
  harness.notifier.notify(candidate());
  harness.notifier.notify(candidate({ key: 'turn-1b' }));
  assert.equal(firstWindow.listenerCount('focus'), 1, 'attached once');

  const secondWindow = createWindow();
  harness.state.mainWindow = secondWindow;
  harness.notifier.notify(candidate({ key: 'turn-2' }));
  assert.equal(firstWindow.listenerCount('focus'), 0);
  assert.equal(secondWindow.listenerCount('focus'), 1);

  secondWindow.emit('focus');
  assert.equal(harness.notifier.getLiveCount(), 0);

  harness.notifier.stop();
  assert.equal(secondWindow.listenerCount('focus'), 0);
});

test('click restores a minimized window, focuses it and opens the session', () => {
  const harness = createHarness({ mainWindow: createWindow({ minimized: true }) });
  harness.notifier.notify(candidate({ category: 'questions', key: 'ask-7', sessionId: 'session-9' }));

  harness.notifications[0].click();

  assert.equal(harness.state.mainWindow.restoreCalls, 1);
  assert.equal(harness.state.mainWindow.focusCalls, 1);
  assert.deepEqual(harness.bridgeEvents, [{
    event: 'notifications.onOpen',
    payload: { sessionId: 'session-9', category: 'questions', key: 'ask-7' },
  }]);
  assert.equal(harness.notifier.getLiveCount(), 0);
});

test('start registers the notify send channel and stop removes it and closes toasts', () => {
  const harness = createHarness();
  harness.notifier.start();
  harness.notifier.start();
  assert.deepEqual([...harness.ipcListeners.keys()], ['notifications:notify']);

  const listener = harness.ipcListeners.get('notifications:notify');
  assert.doesNotThrow(() => listener({ sender: {} }, candidate()));
  assert.doesNotThrow(() => listener({ sender: {} }, 'garbage'));
  assert.equal(harness.notifications.length, 1);

  harness.notifier.stop();
  assert.equal(harness.ipcListeners.size, 0);
  assert.equal(harness.notifications[0].closeCalls, 1);
  assert.equal(harness.notifier.getLiveCount(), 0);
});

test('an unauthorized sender never reaches notify', () => {
  const harness = createHarness({ authorizeSender: () => false });
  harness.notifier.start();
  harness.ipcListeners.get('notifications:notify')({ sender: {} }, candidate());
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.logsFor('desktop_notifier.suppressed')[0].details.reason, 'unauthorized_sender');
});

test('the default sender authorizer rejects a sender that is not the main window frame', () => {
  const logs = [];
  const listeners = new Map();
  const notifications = [];
  const mainWindow = createWindow();
  mainWindow.webContents = { mainFrame: {}, isDestroyed: () => false, getURL: () => 'file:///x' };
  const notifier = createDesktopNotifier({
    getShellConfigService: () => null,
    getMainWindow: () => mainWindow,
    notificationFactory: (options) => {
      notifications.push(options);
      return { on() {}, show() {} };
    },
    isSupported: () => true,
    sendBridgeEvent: () => {},
    log: (level, event, details) => logs.push({ level, event, details }),
    isEnabled: () => true,
    ipcMainLike: { on: (channel, listener) => listeners.set(channel, listener) },
  });
  notifier.start();
  listeners.get('notifications:notify')({ sender: { isDestroyed: () => false } }, candidate());
  assert.equal(notifications.length, 0);
  assert.ok(logs.some((entry) => entry.event === 'ipc.sender_rejected'));
  // Direct in-process calls are not IPC and use defaults when settings are absent.
  assert.equal(notifier.notify(candidate()), true);
});

test('a throwing factory or settings read is logged once and never escapes', () => {
  const harness = createHarness({ factoryError: new Error('toast exploded') });
  for (let index = 0; index < 3; index += 1) {
    assert.doesNotThrow(() => {
      assert.equal(harness.notifier.notify(candidate({ key: `turn-${index}` })), false);
    });
  }
  assert.equal(harness.logsFor('desktop_notifier.notification_failed').length, 1);
  assert.equal(harness.notifier.getLiveCount(), 0);

  const settingsHarness = createHarness();
  settingsHarness.state.settings = undefined;
  assert.equal(settingsHarness.notifier.notify(candidate()), true, 'absent settings = defaults');
  settingsHarness.state.settingsError = new Error('settings exploded');
  assert.equal(settingsHarness.notifier.notify(candidate({ key: 'turn-2' })), true, 'defaults');
  assert.equal(settingsHarness.notifier.notify(candidate({ key: 'turn-3' })), true);
  assert.equal(settingsHarness.logsFor('desktop_notifier.settings_failed').length, 1);
});

test('start without an ipcMain and stop before start are inert', () => {
  const notifier = createDesktopNotifier({
    getShellConfigService: () => null,
    getMainWindow: () => null,
    notificationFactory: () => null,
    isSupported: () => true,
    sendBridgeEvent: () => {},
  });
  assert.doesNotThrow(() => notifier.stop());
  assert.doesNotThrow(() => notifier.start());
  assert.equal(notifier.notify(candidate()), false, 'isEnabled defaults to off');
});

// Row 89: the turns Jenny starts herself.
function jennyUpdate(n, overrides = {}) {
  return candidate({ category: 'jenny', key: `turn:wake-${n}`, sessionId: 'primary', title: 'Jenny has an update', body: 'Jenny', group: 'updates', ...overrides });
}

test('the jenny category shows with its own switch and keeps its preview', () => {
  const h = createHarness({ settings: { onlyWhenUnfocused: true, replyPreview: true } });
  assert.equal(h.notifier.notify(candidate({ category: 'jenny', key: 'turn:check', title: 'Check done: Morning PR sweep', body: 'Jenny', preview: 'Two PRs need review.' })), true);
  assert.deepEqual(h.notifications[0].options, { title: 'Check done: Morning PR sweep', body: 'Two PRs need review.', silent: false });
  h.state.settings = { categories: { jenny: false } };
  assert.equal(h.notifier.notify(candidate({ category: 'jenny', key: 'turn:check-2', title: 'Check done' })), false);
  assert.equal(h.notifier.notify(candidate({ key: 'turn:own' })), true, 'replies keep their own switch');
});

test('normalization keeps group only for a jenny candidate with a session, and only "updates"', () => {
  assert.equal(normalizeNotificationCandidate(jennyUpdate(1)).group, 'updates');
  assert.equal(normalizeNotificationCandidate(jennyUpdate(1, { group: 'other' })).group, undefined);
  assert.equal(normalizeNotificationCandidate(jennyUpdate(1, { sessionId: '' })).group, undefined);
  assert.equal(normalizeNotificationCandidate(candidate({ group: 'updates' })).group, undefined);
});

test('wake updates share one counting toast per chat until the user clicks or focuses the window', () => {
  const h = createHarness();
  assert.equal(h.notifier.notify(jennyUpdate(1)), true);
  assert.equal(h.notifications[0].options.title, 'Jenny has an update');
  assert.equal(h.notifier.notify(jennyUpdate(2)), true);
  assert.equal(h.notifications[0].closeCalls, 1, 'the earlier toast is replaced');
  assert.equal(h.notifications[1].options.title, 'Jenny has 2 updates');
  assert.equal(h.notifier.getLiveCount(), 1);
  assert.equal(h.notifier.notify(jennyUpdate(2)), false, 'the same turn twice is a duplicate');
  // Windows closes a toast into the notification center on its own; the count carries on.
  h.notifications[1].emitClose();
  assert.equal(h.notifier.notify(jennyUpdate(3)), true);
  assert.equal(h.notifications[2].options.title, 'Jenny has 3 updates');
  h.notifications[2].click();
  assert.equal(h.notifier.notify(jennyUpdate(4)), true);
  assert.equal(h.notifications[3].options.title, 'Jenny has an update', 'a click resets the count');
  assert.equal(h.notifier.notify(jennyUpdate(5)), true);
  h.state.mainWindow.emit('focus');
  assert.equal(h.notifier.notify(jennyUpdate(6)), true);
  assert.equal(h.notifications[5].options.title, 'Jenny has an update', 'focus resets the count');
  assert.equal(h.notifier.notify(jennyUpdate(7, { sessionId: 'other-chat' })), true);
  assert.equal(h.notifications[6].options.title, 'Jenny has an update', 'counts are per chat');
});

test('a factory failure neither closes the count off nor bumps it; a focused update starts a fresh count', () => {
  const h = createHarness({ settings: { onlyWhenUnfocused: false } });
  assert.equal(h.notifier.notify(jennyUpdate(1)), true);
  h.state.factoryError = new Error('toast service down');
  assert.equal(h.notifier.notify(jennyUpdate(2)), false);
  h.state.factoryError = null;
  assert.equal(h.notifier.notify(jennyUpdate(3)), true);
  assert.equal(h.notifications.at(-1).options.title, 'Jenny has 2 updates', 'the failed one is not counted');
  h.state.mainWindow.focused = true;
  assert.equal(h.notifier.notify(jennyUpdate(4)), true);
  assert.equal(h.notifications.at(-1).options.title, 'Jenny has an update', 'seen while focused: a fresh count');
});

test('inside quiet hours nothing from the Jenny chat toasts; other chats and outside hours are unaffected', () => {
  const at = (h, m) => new Date(2026, 10, 2, h, m).getTime();
  const h = createHarness({ primarySessionId: 'primary', chatUi: { digestQuietStart: '22:00', digestQuietEnd: '07:00' }, nowMs: at(23, 30) });
  assert.equal(h.notifier.notify(candidate({ category: 'permissions', key: 'inbox:a', sessionId: 'primary', title: 'Needs your permission' })), false);
  assert.equal(h.notifier.notify(jennyUpdate(1)), false);
  assert.equal(h.logsFor('desktop_notifier.suppressed').some((entry) => entry.details.reason === 'quiet_hours'), true);
  assert.equal(h.notifier.notify(candidate({ key: 'turn:other', sessionId: 'other-chat' })), true, 'another chat still toasts');
  h.state.nowMs = at(7, 0);
  const lookups = h.state.primaryLookups;
  assert.equal(h.notifier.notify(jennyUpdate(2)), true, 'the end bound is outside');
  assert.equal(h.state.primaryLookups, lookups, 'outside quiet hours the session is never looked up');
  h.state.chatUi = { digestQuietStart: '09:00', digestQuietEnd: '09:00' };
  h.state.nowMs = at(9, 0);
  assert.equal(h.notifier.notify(candidate({ key: 'turn:eq', sessionId: 'primary' })), true, 'equal bounds mean no quiet hours');
});

test('a failing quiet-hours read logs once and lets the toast through', () => {
  const h = createHarness({ primarySessionId: 'primary' });
  h.state.chatUiError = new Error('config gone');
  assert.equal(h.notifier.notify(candidate({ key: 'turn:a', sessionId: 'primary' })), true);
  assert.equal(h.notifier.notify(candidate({ key: 'turn:b', sessionId: 'primary' })), true);
  assert.equal(h.logsFor('desktop_notifier.quiet_hours_failed').length, 1);
});

// Row 123 slice 2a-6c: team messages.
const TEAM_ID = 'team_BBBBBBBBBBBBBBBBBBBBBB';
const teamMessage = (n, over = {}) => candidate({ category: 'team', key: `team:msg_${n}`, sessionId: undefined, teamId: TEAM_ID, channelId: 'chan_jenny',
  messageId: `msg_${n}`, seq: n, title: 'Maya in #jenny', body: 'New message', sender: 'Maya', conversation: '#jenny', preview: `line ${n}`, ...over });

test('a team candidate keeps only well-formed routing ids, needs a team and a channel, and keeps its preview', () => {
  const c = normalizeNotificationCandidate(teamMessage(4, { threadRootId: 'msg_1', memberId: 'member_x', invite: 'jteam1_x', seq: 2.5 }));
  assert.deepEqual(c, { category: 'team', key: 'team:msg_4', sessionId: '', title: 'Maya in #jenny', body: 'New message', preview: 'line 4', teamId: TEAM_ID, channelId: 'chan_jenny',
    messageId: 'msg_4', threadRootId: 'msg_1', conversation: '#jenny', sender: 'Maya', group: 'conversation' });
  assert.equal(normalizeNotificationCandidate(teamMessage(4, { messageId: 'msg 4/../x' })).messageId, undefined, 'a malformed id is dropped');
  assert.equal(normalizeNotificationCandidate(teamMessage(4, { channelId: '' })), null, 'no channel, no toast');
  assert.equal(normalizeNotificationCandidate(teamMessage(4, { sessionId: 'session-1' })), null, 'a team toast never names a chat');
  const long = normalizeNotificationCandidate(teamMessage(4, { title: 'x'.repeat(300), conversation: 'c'.repeat(300), sender: 's'.repeat(300) }));
  assert.deepEqual([long.title.length, long.conversation.length, long.sender.length], [120, 120, 80], 'the limits as numbers, not read back from the module');
});

// Fix list item 18: the routing ids at their bound, and a hostile name.
test('item 18: an over-length or malformed routing id is dropped (team and channel refuse the toast); bidi overrides go with control characters', () => {
  const at = (n) => 'm'.repeat(n);
  assert.equal(normalizeNotificationCandidate(teamMessage(4, { messageId: at(160) })).messageId, at(160), 'at the bound');
  assert.equal(normalizeNotificationCandidate(teamMessage(4, { messageId: at(161) })).messageId, undefined, 'past it');
  assert.equal(normalizeNotificationCandidate(teamMessage(4, { teamId: 'team_B/../x' })), null, 'a malformed team refuses the toast');
  assert.equal(normalizeNotificationCandidate(teamMessage(4, { teamId: at(161) })), null);
  assert.equal(normalizeNotificationCandidate(teamMessage(4, { threadRootId: 'msg 1' })).threadRootId, undefined, 'a malformed thread root is dropped');
  assert.equal(normalizeNotificationCandidate(teamMessage(4, { threadRootId: 7 })).threadRootId, undefined);
  const hostile = normalizeNotificationCandidate(teamMessage(4, { sender: 'Ma\u202Eya <b>&\u0007', conversation: '#a\u2066b\u2069<i>', title: '\u202Dx' }));
  assert.deepEqual([hostile.sender, hostile.conversation, hostile.title], ['Maya <b>&', '#ab<i>', 'x'], 'kept as text (a toast is not HTML), reordering characters stripped');
});

test('item 18: the counted title and senders line are clipped to the title and body limits', () => {
  const h = createHarness();
  const name = (c) => c.repeat(80);
  h.notifier.notify(teamMessage(1, { conversation: '#' + 'j'.repeat(119), sender: name('a') }));
  for (const [n, c] of [[2, 'b'], [3, 'c'], [4, 'd']]) h.notifier.notify(teamMessage(n, { conversation: '#' + 'j'.repeat(119), sender: name(c) }));
  const { title, body } = h.notifications[3].options;
  assert.equal(title.length, 120);
  assert.ok(title.startsWith('4 new messages in #jjj'));
  assert.equal(body.length, 240);
  assert.ok(body.startsWith(name('a') + ', ' + name('b')));
});

// Fix list item 17: preview off, the senders line, focus, and the counted toast's click.
test('item 17: preview off shows the body; focus starts a fresh count; the counted toast opens the newest message', () => {
  const h = createHarness({ settings: { onlyWhenUnfocused: true, replyPreview: false } });
  h.notifier.notify(teamMessage(1));
  assert.deepEqual(h.notifications[0].options, { title: 'Maya in #jenny', body: 'New message', silent: false }, 'no preview with the switch off');
  h.notifier.notify(teamMessage(2, { sender: 'Dot', threadRootId: 'msg_1' }));
  assert.deepEqual([h.notifications[1].options.title, h.notifications[1].options.body], ['2 new messages in #jenny', 'Maya, Dot']);
  h.notifications[1].click();
  assert.deepEqual(h.bridgeEvents.at(-1).payload, { sessionId: '', category: 'team', key: 'team:msg_2', teamId: TEAM_ID, channelId: 'chan_jenny', messageId: 'msg_2', threadRootId: 'msg_1', seq: 2 },
    'the newest message, with its thread');
  h.notifier.notify(teamMessage(3));
  h.notifier.notify(teamMessage(4, { sender: 'Ann' }));
  assert.equal(h.notifications[3].options.title, '2 new messages in #jenny');
  h.state.mainWindow.emit('focus');
  h.notifier.notify(teamMessage(5, { sender: 'Lee' }));
  assert.deepEqual([h.notifications[4].options.title, h.notifications[4].options.body], ['Maya in #jenny', 'New message'], 'focusing the window resets the count');
});

test('a click on a team toast sends only its routing ids back; the switch off suppresses team only', () => {
  const h = createHarness({ settings: { onlyWhenUnfocused: true, replyPreview: true } });
  assert.equal(h.notifier.notify(teamMessage(4, { threadRootId: 'msg_1' })), true);
  assert.deepEqual(h.notifications[0].options, { title: 'Maya in #jenny', body: 'line 4', silent: false });
  h.notifications[0].click();
  assert.deepEqual(h.bridgeEvents, [{ event: 'notifications.onOpen', payload: { sessionId: '', category: 'team', key: 'team:msg_4',
    teamId: TEAM_ID, channelId: 'chan_jenny', messageId: 'msg_4', threadRootId: 'msg_1', seq: 4 } }]);
  const off = createHarness({ settings: { categories: { team: false } } });
  assert.equal(off.notifier.notify(teamMessage(5)), false);
  assertSuppressed(off, 'category_off', 'team');
  assert.equal(off.notifier.notify(candidate()), true, 'replies still toast');
});

test('team messages in one channel share one counted toast naming three senders, until a click; channels count apart', () => {
  const h = createHarness();
  h.notifier.notify(teamMessage(1));
  h.notifier.notify(teamMessage(2, { sender: 'Dot' }));
  assert.deepEqual(h.notifications[1].options, { title: '2 new messages in #jenny', body: 'Maya, Dot', silent: false });
  h.notifier.notify(teamMessage(3, { sender: 'Maya' }));
  h.notifier.notify(teamMessage(4, { sender: 'Ann' }));
  h.notifier.notify(teamMessage(5, { sender: 'Lee' }));
  h.notifier.notify(teamMessage(6, { sender: 'Kim' }));
  assert.deepEqual([h.notifications[5].options.title, h.notifications[5].options.body], ['6 new messages in #jenny', 'Maya, Dot, Ann and 2 others']);
  assert.equal(h.notifier.getLiveCount(), 1);
  h.notifier.notify(teamMessage(7, { channelId: 'chan_other', conversation: '#other', title: 'Maya in #other' }));
  assert.equal(h.notifications[6].options.title, 'Maya in #other', 'another channel counts on its own');
  h.notifications[5].click();
  h.notifier.notify(teamMessage(8));
  assert.equal(h.notifications[7].options.title, 'Maya in #jenny', 'a click resets the count');
  const bytes = JSON.stringify(h.notifications.map((n) => n.options)) + JSON.stringify(h.logs);
  for (const secret of ['member_', 'jteam1_', 'device_']) assert.equal(bytes.includes(secret), false, secret);
});

// Row 175: project activity (`teamProject`): a host conversation, the Team switch too, and a click that names it.
test('row 175: a project toast needs its team and host conversation, passes the gates with Team on, and its click names only them', () => {
  const SID = 'sess_' + 'a'.repeat(32);
  const project = (over = {}) => candidate({ category: 'teamProject', key: 'teamProject:x:1', sessionId: SID, teamId: TEAM_ID, projectId: 'project_aaaa',
    title: 'Release notes', body: 'Jenny finished your turn.', preview: 'secret line', channelId: 'chan_team', ...over });
  assert.deepEqual(normalizeNotificationCandidate(project()), { category: 'teamProject', key: 'teamProject:x:1', sessionId: SID, title: 'Release notes',
    body: 'Jenny finished your turn.', teamId: TEAM_ID, projectId: 'project_aaaa' }, 'no preview, no channel');
  for (const over of [{ sessionId: 'session-1' }, { sessionId: SID + '/x' }, { teamId: '' }]) assert.equal(normalizeNotificationCandidate(project(over)), null);
  const h = createHarness({ primarySessionId: SID, chatUi: { digestQuietStart: '00:00', digestQuietEnd: '23:30' } });
  h.state.childSessions.add(SID);
  assert.equal(h.notifier.notify(project()), true, 'the local-chat gates do not read a host conversation');
  h.notifications[0].click();
  assert.deepEqual(h.bridgeEvents.at(-1).payload, { sessionId: SID, category: 'teamProject', key: 'teamProject:x:1', teamId: TEAM_ID, projectId: 'project_aaaa' });
  const teamOff = createHarness({ settings: { categories: { team: false } } });
  assert.equal(teamOff.notifier.notify(project()), false);
  assertSuppressed(teamOff, 'category_off', 'teamProject');
  const projectOff = createHarness({ settings: { categories: { teamProject: false } } });
  assert.equal(projectOff.notifier.notify(project()), false, 'its own switch');
  assert.equal(projectOff.notifier.notify(teamMessage(1)), true, 'team messages still toast');
});
