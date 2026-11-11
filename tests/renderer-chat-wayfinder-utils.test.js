const test = require('node:test');
const assert = require('node:assert/strict');

// Load the module under test directly: a require failure here is a real
// regression (the module is shipped) and must fail the suite loudly rather
// than degrade to an empty stub that turns every assertion green.
const wayfinderUtils = require('../renderer/chat/renderer-chat-wayfinder-utils');

function buildController(options = {}) {
  const calls = [];
  const state = options.state || { currentSessionId: 's1', ui: { activeView: 'chat', followLatest: false } };
  const metrics = options.metrics || { scrollTop: 100, scrollHeight: 1000, clientHeight: 300 };
  const controller = wayfinderUtils.createChatWayfinderController({
    state,
    getCurrentSessionId: () => state.currentSessionId,
    getCurrentSessionMessages: () => options.messages || [{ id: 'u1', role: 'user' }],
    getScrollMetrics: () => {
      if (options.throwOnMetrics) {
        throw new Error('metrics failed');
      }
      return metrics;
    },
    appendClientLog(level, eventName) {
      calls.push(['log', level, eventName]);
    },
    onChange(model) {
      calls.push(['change', model.state, model.label, model.messageId || '']);
    },
  });
  // The model the bottom-edge jump control reads: published on state.ui, not owned by a DOM host.
  const handlers = {
    onError() { calls.push(['actionFailed']); },
  };
  return { calls, controller, handlers, state, model: () => state.ui.chatWayfinder };
}

test('conversation wayfinder prioritizes unread over latest', () => {
  assert.equal(typeof wayfinderUtils.createChatWayfinderController, 'function');
  const { calls, controller, handlers, model } = buildController();
  const unreadController = {
    jumpToFirstUnread() {
      calls.push(['jumpUnread']);
      return true;
    },
  };

  controller.bind();
  assert.equal(model().state, 'latest');
  controller.setUnreadState({
    visible: true,
    hasUnread: true,
    sessionId: 's1',
    messageId: 'a1',
  });

  assert.equal(model().state, 'unread');
  assert.equal(model().label, 'Jump to first unread');

  wayfinderUtils.activateModel(model(), { ...handlers, unreadController });
  assert.ok(calls.some((entry) => entry[0] === 'jumpUnread'));

  controller.dispose();
});

test('the live end offers nothing; leaving it offers the way back', () => {
  const metrics = { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 };
  const { controller, model, state } = buildController({
    metrics,
    state: { currentSessionId: 's1', ui: { activeView: 'chat', followLatest: true } },
  });

  controller.bind();
  controller.setUnreadState({ visible: false, hasUnread: false, sessionId: 's1' });
  assert.equal(model().visible, false);

  state.ui.followLatest = false;
  metrics.scrollTop = 100;
  controller.refresh();
  assert.equal(model().state, 'latest');
  assert.equal(model().label, 'Return to latest');

  controller.dispose();
});

test('conversation wayfinder hides near bottom and ignores stale session cues', () => {
  const { controller, model } = buildController({
    metrics: { scrollTop: 652, scrollHeight: 1000, clientHeight: 300 },
  });

  controller.bind();
  controller.setUnreadState({
    visible: true,
    hasUnread: true,
    sessionId: 'other',
    messageId: 'a-other',
  });

  assert.equal(model().visible, false);
  assert.equal(model().state, 'hidden');
  assert.equal(wayfinderUtils.activateModel(model(), {}), false, 'a hidden model has nothing to run');

  controller.dispose();
});

test('conversation wayfinder leaves latest navigation to composer tools while following latest', () => {
  const { controller, model, state } = buildController({
    state: { currentSessionId: 's1', ui: { activeView: 'chat', followLatest: true } },
  });

  controller.bind();

  assert.equal(model().visible, false);
  assert.equal(model().state, 'hidden');

  state.ui.followLatest = false;
  controller.refresh();

  assert.equal(model().visible, true);
  assert.equal(model().state, 'latest');

  controller.dispose();
});

test('conversation wayfinder bounds action failures and clears its published model on dispose', () => {
  const { calls, controller, handlers, model } = buildController({ metrics: { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 } });
  const unreadController = { jumpToFirstUnread() { throw new Error('jump failed'); } };

  controller.bind();
  controller.setUnreadState({ visible: true, hasUnread: true, sessionId: 's1', messageId: 'a1' });

  assert.doesNotThrow(() => {
    wayfinderUtils.activateModel(model(), { ...handlers, unreadController });
  });
  assert.ok(calls.some((entry) => entry[0] === 'actionFailed'));

  controller.dispose();
  assert.equal(model().visible, false);
});

test('conversation wayfinder reports changes once and skips steady refreshes', () => {
  const { calls, controller } = buildController({ metrics: { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 } });

  controller.bind();
  calls.length = 0;

  controller.refresh();
  controller.handleScroll();

  assert.deepEqual(calls, []);

  controller.setUnreadState({ visible: true, hasUnread: true, sessionId: 's1', messageId: 'a1' });
  assert.deepEqual(calls, [['change', 'unread', 'Jump to first unread', 'a1']]);
  controller.dispose();
});

test('conversation wayfinder survives a failing change listener', () => {
  const state = { currentSessionId: 's1', ui: { activeView: 'chat', followLatest: false } };
  const logged = [];
  const controller = wayfinderUtils.createChatWayfinderController({
    state,
    getCurrentSessionId: () => state.currentSessionId,
    getCurrentSessionMessages: () => [{ id: 'u1', role: 'user' }],
    getScrollMetrics: () => ({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 }),
    appendClientLog(level, eventName) { logged.push(eventName); },
    onChange() { throw new Error('listener boom'); },
  });

  assert.doesNotThrow(() => {
    controller.bind();
    controller.setUnreadState({ visible: true, hasUnread: true, sessionId: 's1', messageId: 'a1' });
  });
  assert.equal(state.ui.chatWayfinder.state, 'unread');
  assert.ok(logged.includes('chat.wayfinder_change_failed'));
  controller.dispose();
});

test('the jump click handler takes one press per guard window and honours the session', () => {
  let time = 1000;
  const jumps = [];
  let model = { visible: true, state: 'unread', messageId: 'a1', sessionId: 's1' };
  const click = wayfinderUtils.createJumpClickHandler({
    now: () => time,
    getModel: () => model,
    getSessionId: () => 's1',
    getHandlers: () => ({ unreadController: { jumpToFirstUnread: () => { jumps.push('unread'); return true; } } }),
    jumpToLatest: () => { jumps.push('latest'); },
  });
  assert.equal(click(), true);
  time += 349;
  assert.equal(click(), false, 'inside the guard');
  time += 1;
  model = { visible: true, state: 'latest', sessionId: 's1' };
  assert.equal(click(), true);
  time += 400;
  model = { visible: true, state: 'unread', messageId: 'a2', sessionId: 'other' };
  click();
  assert.deepEqual(jumps, ['unread', 'latest', 'latest']);
});

test('activateModel runs the jump a model names and nothing for a hidden one', () => {
  const ran = [];
  const handlers = {
    unreadController: { jumpToFirstUnread: () => { ran.push('unread'); return true; } },
  };
  assert.equal(wayfinderUtils.activateModel({ visible: true, state: 'unread', messageId: 'a1' }, handlers), true);
  assert.equal(wayfinderUtils.activateModel({ visible: true, state: 'latest' }, handlers), false, 'latest is the bottom control\'s own jump');
  assert.equal(wayfinderUtils.activateModel({ visible: false, state: 'latest' }, handlers), false);
  assert.equal(wayfinderUtils.activateModel(null, handlers), false);
  assert.deepEqual(ran, ['unread']);
});

test('conversation wayfinder bounds scroll metric failures', () => {
  const { calls, controller, model } = buildController({ throwOnMetrics: true });

  assert.doesNotThrow(() => {
    controller.bind();
  });

  assert.equal(model().visible, false);
  assert.ok(calls.some((entry) => entry[0] === 'log' && entry[2] === 'chat.wayfinder_metrics_failed'));
  controller.dispose();
});

test('a press whose unread jump finds nothing still goes to the latest message', () => {
  const jumps = [];
  const click = wayfinderUtils.createJumpClickHandler({
    now: () => 1000,
    getModel: () => ({ visible: true, state: 'unread', messageId: 'gone', sessionId: 's1' }),
    getSessionId: () => 's1',
    getHandlers: () => ({ unreadController: { jumpToFirstUnread: () => { jumps.push('unread'); return false; } } }),
    jumpToLatest: () => { jumps.push('latest'); },
  });
  assert.equal(click(), true);
  assert.deepEqual(jumps, ['unread', 'latest']);
});
