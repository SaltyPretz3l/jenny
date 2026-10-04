'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  FIELD_LIMITS,
  MAX_LIVE_NOTIFICATIONS,
  createDesktopNotifier,
  isRuntimeChildSession,
  normalizeNotificationCandidate,
} = require('../services/main/desktop-notifier');

function createWindow({ visible = true, focused = false, minimized = false } = {}) {
  const win = new EventEmitter();
  Object.assign(win, {
    visible,
    focused,
    minimized,
    destroyed: false,
    restoreCalls: 0,
    focusCalls: 0,
    isVisible() { return this.visible; },
    isFocused() { return this.focused; },
    isMinimized() { return this.minimized; },
    isDestroyed() { return this.destroyed; },
    restore() { this.restoreCalls += 1; this.minimized = false; },
    focus() { this.focusCalls += 1; },
  });
  return win;
}

function createHarness({
  settings = { onlyWhenUnfocused: true },
  flag = true,
  supported = true,
  factoryError = null,
  mainWindow = createWindow(),
  authorizeSender = () => true,
} = {}) {
  const state = { settings, flag, supported, factoryError, mainWindow, childSessions: new Set(), childLookupError: null };
  const notifications = [];
  const bridgeEvents = [];
  const logs = [];
  const ipcListeners = new Map();
  const ipcMainLike = {
    on(channel, listener) { ipcListeners.set(channel, listener); },
    removeListener(channel, listener) {
      if (ipcListeners.get(channel) === listener) ipcListeners.delete(channel);
    },
  };
  const notifier = createDesktopNotifier({
    getShellConfigService: () => ({
      getWindowUiState() {
        if (state.settingsError) throw state.settingsError;
        return { appZoomPercent: 100, notifications: state.settings };
      },
    }),
    isChildSession: (sessionId) => {
      if (state.childLookupError) throw state.childLookupError;
      return state.childSessions.has(sessionId);
    },
    getMainWindow: () => state.mainWindow,
    notificationFactory(options) {
      if (state.factoryError) throw state.factoryError;
      const listeners = new Map();
      const notification = {
        options,
        showCalls: 0,
        closeCalls: 0,
        on(event, listener) { listeners.set(event, listener); },
        show() { this.showCalls += 1; },
        close() {
          this.closeCalls += 1;
          listeners.get('close')?.();
        },
        click() { listeners.get('click')?.(); },
        emitClose() { listeners.get('close')?.(); },
      };
      notifications.push(notification);
      return notification;
    },
    isSupported: () => state.supported,
    sendBridgeEvent: (event, payload) => bridgeEvents.push({ event, payload }),
    log: (level, event, details) => logs.push({ level, event, details }),
    isEnabled: () => state.flag,
    ipcMainLike,
    authorizeSender,
  });
  return {
    state,
    notifications,
    bridgeEvents,
    logs,
    ipcListeners,
    notifier,
    logsFor: (event) => logs.filter((entry) => entry.event === event),
  };
}

function candidate(overrides = {}) {
  return {
    category: 'replies',
    key: 'turn-1',
    sessionId: 'session-1',
    title: 'Reply ready',
    body: 'Trip planning',
    ...overrides,
  };
}

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
  assert.deepEqual(FIELD_LIMITS, { key: 120, sessionId: 80, title: 120, body: 240, preview: 240 });

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
