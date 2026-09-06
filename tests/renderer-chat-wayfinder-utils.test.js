const test = require('node:test');
const assert = require('node:assert/strict');

// Load the module under test directly: a require failure here is a real
// regression (the module is shipped) and must fail the suite loudly rather
// than degrade to an empty stub that turns every assertion green.
const wayfinderUtils = require('../renderer/chat/renderer-chat-wayfinder-utils');

function createAffordance(calls) {
  const listeners = new Map();
  return {
    state: null,
    mount(host) {
      calls.push(['mount', host && host.id ? host.id : 'host']);
    },
    unmount() {
      calls.push(['unmount']);
    },
    setState(nextState) {
      this.state = { ...nextState };
      calls.push(['state', this.state.state, this.state.label, this.state.messageId || '']);
    },
    on(eventName, callback) {
      listeners.set(eventName, callback);
      return () => listeners.delete(eventName);
    },
    emit(eventName) {
      const callback = listeners.get(eventName);
      if (callback) {
        callback();
      }
    },
    dispose() {
      calls.push(['dispose']);
    },
  };
}

function buildController(options = {}) {
  const calls = [];
  const affordance = createAffordance(calls);
  const state = options.state || { currentSessionId: 's1', ui: { activeView: 'chat', followLatest: false } };
  const metrics = options.metrics || { scrollTop: 100, scrollHeight: 1000, clientHeight: 300 };
  const controller = wayfinderUtils.createChatWayfinderController({
    state,
    host: { id: 'composerWayfinderHost' },
    getCurrentSessionId: () => state.currentSessionId,
    getCurrentSessionMessages: () => options.messages || [{ id: 'u1', role: 'user' }],
    getScrollMetrics: () => {
      if (options.throwOnMetrics) {
        throw new Error('metrics failed');
      }
      return metrics;
    },
    scrollMessageIntoView(messageId, scrollOptions) {
      calls.push(['scrollMessage', messageId, scrollOptions && scrollOptions.block]);
      if (options.throwOnScroll) {
        throw new Error('scroll failed');
      }
      return true;
    },
    handleJumpToBottom() {
      calls.push(['jumpBottom']);
      return true;
    },
    appendClientLog(level, eventName) {
      calls.push(['log', level, eventName]);
    },
    affordanceFactory: {
      createChatWayfinderAffordance: () => affordance,
    },
  });
  return { affordance, calls, controller, state };
}

test('conversation wayfinder prioritizes unread over prompt and latest', () => {
  assert.equal(typeof wayfinderUtils.createChatWayfinderController, 'function');
  const { affordance, calls, controller } = buildController();
  const unreadController = {
    jumpToFirstUnread() {
      calls.push(['jumpUnread']);
      return true;
    },
  };

  controller.bind();
  controller.setUnreadController(unreadController);
  controller.setPinState({
    visible: true,
    sessionId: 's1',
    messageId: 'u1',
    text: 'The user prompt that started this turn',
  });
  controller.setUnreadState({
    visible: true,
    hasUnread: true,
    sessionId: 's1',
    messageId: 'a1',
  });

  assert.equal(affordance.state.state, 'unread');
  assert.equal(affordance.state.label, 'Jump to first unread');

  affordance.emit('activate');
  assert.ok(calls.some((entry) => entry[0] === 'jumpUnread'));

  controller.dispose();
});

test('conversation wayfinder falls back from unread to pinned prompt to latest', () => {
  const { affordance, calls, controller } = buildController();

  controller.bind();
  controller.setUnreadState({ visible: false, hasUnread: false, sessionId: 's1' });
  controller.setPinState({
    visible: true,
    sessionId: 's1',
    messageId: 'u1',
    text: 'Map the transcript flow',
  });

  assert.equal(affordance.state.state, 'prompt');
  assert.equal(affordance.state.label, 'Back to prompt');

  affordance.emit('activate');
  assert.ok(calls.some((entry) => entry[0] === 'scrollMessage' && entry[1] === 'u1'));

  controller.setPinState({ visible: false, sessionId: 's1' });
  assert.equal(affordance.state.state, 'latest');
  assert.equal(affordance.state.label, 'Return to latest');

  affordance.emit('activate');
  assert.ok(calls.some((entry) => entry[0] === 'jumpBottom'));

  controller.dispose();
});

test('conversation wayfinder hides near bottom and ignores stale session cues', () => {
  const { affordance, controller } = buildController({
    metrics: { scrollTop: 652, scrollHeight: 1000, clientHeight: 300 },
  });

  controller.bind();
  controller.setPinState({
    visible: true,
    sessionId: 'other',
    messageId: 'u-other',
    text: 'Stale prompt',
  });
  controller.setUnreadState({
    visible: true,
    hasUnread: true,
    sessionId: 'other',
    messageId: 'a-other',
  });

  assert.equal(affordance.state.visible, false);
  assert.equal(affordance.state.state, 'hidden');

  controller.dispose();
});

test('conversation wayfinder leaves latest navigation to composer tools while following latest', () => {
  const { affordance, controller, state } = buildController({
    state: { currentSessionId: 's1', ui: { activeView: 'chat', followLatest: true } },
  });

  controller.bind();

  assert.equal(affordance.state.visible, false);
  assert.equal(affordance.state.state, 'hidden');
  assert.equal(state.ui.chatWayfinderVisible, false);

  state.ui.followLatest = false;
  controller.refresh();

  assert.equal(affordance.state.visible, true);
  assert.equal(affordance.state.state, 'latest');

  controller.dispose();
});

test('conversation wayfinder bounds action failures and disposes affordance', () => {
  const { affordance, calls, controller } = buildController({ throwOnScroll: true });

  controller.bind();
  controller.setPinState({
    visible: true,
    sessionId: 's1',
    messageId: 'bad\nid',
    text: 'Malformed id prompt',
  });

  assert.doesNotThrow(() => {
    affordance.emit('activate');
  });
  assert.ok(calls.some((entry) => entry[0] === 'log' && entry[1] === 'WARN'));

  controller.dispose();
  assert.ok(calls.some((entry) => entry[0] === 'dispose'));
});

test('conversation wayfinder skips unchanged affordance writes on steady refresh', () => {
  const { calls, controller } = buildController();

  controller.bind();
  calls.length = 0;

  controller.refresh();
  controller.handleScroll();

  assert.deepEqual(calls, []);
  controller.dispose();
});

test('conversation wayfinder prefers the composer host when resolving document hosts', () => {
  const calls = [];
  const affordance = createAffordance(calls);
  const state = { currentSessionId: 's1', ui: { activeView: 'chat', followLatest: false } };
  const hosts = {
    chatUnreadOrientationHost: { id: 'chatUnreadOrientationHost' },
    composerWayfinderHost: { id: 'composerWayfinderHost' },
  };
  const controller = wayfinderUtils.createChatWayfinderController({
    state,
    document: {
      getElementById(id) {
        calls.push(['hostLookup', id]);
        return hosts[id] || null;
      },
    },
    getCurrentSessionId: () => state.currentSessionId,
    getCurrentSessionMessages: () => [{ id: 'u1', role: 'user' }],
    getScrollMetrics: () => ({ scrollTop: 100, scrollHeight: 1000, clientHeight: 300 }),
    affordanceFactory: {
      createChatWayfinderAffordance: () => affordance,
    },
  });

  controller.bind();

  assert.ok(calls.some((entry) => entry[0] === 'mount' && entry[1] === 'composerWayfinderHost'));
  assert.equal(calls.some((entry) => entry[0] === 'mount' && entry[1] === 'chatUnreadOrientationHost'), false);
  controller.dispose();
});

test('conversation wayfinder keeps composer fallback available when affordance is missing', () => {
  const state = { currentSessionId: 's1', ui: { activeView: 'chat' } };
  const controller = wayfinderUtils.createChatWayfinderController({
    state,
    host: { id: 'composerWayfinderHost' },
    getCurrentSessionId: () => state.currentSessionId,
    getCurrentSessionMessages: () => [{ id: 'u1', role: 'user' }],
    getScrollMetrics: () => ({ scrollTop: 100, scrollHeight: 1000, clientHeight: 300 }),
  });

  controller.bind();
  controller.setPinState({
    visible: true,
    sessionId: 's1',
    messageId: 'u1',
    text: 'Pinned prompt',
  });

  assert.equal(state.ui.chatWayfinderVisible, false);
  controller.dispose();
});

test('conversation wayfinder bounds affordance init failures and keeps composer fallback available', () => {
  const calls = [];
  const state = { currentSessionId: 's1', ui: { activeView: 'chat', followLatest: false } };
  const controller = wayfinderUtils.createChatWayfinderController({
    state,
    host: { id: 'composerWayfinderHost' },
    getCurrentSessionId: () => state.currentSessionId,
    getCurrentSessionMessages: () => [{ id: 'u1', role: 'user' }],
    getScrollMetrics: () => ({ scrollTop: 100, scrollHeight: 1000, clientHeight: 300 }),
    appendClientLog(level, eventName) {
      calls.push(['log', level, eventName]);
    },
    affordanceFactory: {
      createChatWayfinderAffordance() {
        throw new Error('factory boom');
      },
    },
  });

  assert.doesNotThrow(() => {
    controller.bind();
    controller.setPinState({
      visible: true,
      sessionId: 's1',
      messageId: 'u1',
      text: 'Pinned prompt',
    });
  });

  assert.equal(state.ui.chatWayfinderVisible, false);
  assert.ok(calls.some((entry) => entry[0] === 'log' && entry[2] === 'chat.wayfinder_affordance_failed'));
  controller.dispose();
});

test('conversation wayfinder bounds scroll metric failures', () => {
  const { affordance, calls, controller, state } = buildController({ throwOnMetrics: true });

  assert.doesNotThrow(() => {
    controller.bind();
  });

  assert.equal(affordance.state.visible, false);
  assert.equal(state.ui.chatWayfinderVisible, false);
  assert.ok(calls.some((entry) => entry[0] === 'log' && entry[2] === 'chat.wayfinder_metrics_failed'));
  controller.dispose();
});
