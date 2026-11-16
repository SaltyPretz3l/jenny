'use strict';

// The desktop notifier's test harness (services/main/desktop-notifier.js): a fake window, shell config,
// notification factory, bridge and log. Shared by tests/desktop-notifier.test.js.
const { EventEmitter } = require('node:events');

const { createDesktopNotifier } = require('../../services/main/desktop-notifier');

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
  primarySessionId = null,
  chatUi = {},
  nowMs = new Date(2026, 10, 2, 12, 0).getTime(),
} = {}) {
  const state = {
    settings, flag, supported, factoryError, mainWindow, childSessions: new Set(), childLookupError: null,
    primarySessionId, chatUi, nowMs,
  };
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
      getChatUiState() {
        if (state.chatUiError) throw state.chatUiError;
        return state.chatUi;
      },
    }),
    isPrimarySession: (sessionId) => {
      state.primaryLookups = (state.primaryLookups || 0) + 1;
      return sessionId === state.primarySessionId;
    },
    now: () => state.nowMs,
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

module.exports = { createWindow, createHarness, candidate };
