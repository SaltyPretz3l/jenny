const test = require('node:test');
const assert = require('node:assert/strict');

const { createNavigationIntentOwner } = require('../renderer/chat/renderer-navigation-intent');

test('newer user navigation invalidates slow operation ownership and exposes Open action', async () => {
  const state = { currentSessionId: 'session_a', ui: { activeView: 'chat' } };
  const owner = createNavigationIntentOwner(state);
  const token = owner.beginOperation('branch');
  owner.noteUserNavigation();
  state.currentSessionId = 'session_b';
  const toasts = [];
  const navigated = [];
  const result = await owner.navigateOrNotify(token, 'session_branch', {
    navigate: async (sessionId) => navigated.push(sessionId),
    showToastMessage: (message, options) => toasts.push({ message, options }),
  });
  assert.deepEqual(result, { navigated: false, notified: true });
  assert.deepEqual(navigated, []);
  assert.equal(toasts[0].options.actions[0].label, 'Open');
  await toasts[0].options.actions[0].onClick();
  assert.deepEqual(navigated, ['session_branch']);
});

test('operation with the current intent may navigate directly', async () => {
  const state = { currentSessionId: 'session_a', ui: { activeView: 'chat' } };
  const owner = createNavigationIntentOwner(state);
  const token = owner.beginOperation('send');
  const navigated = [];
  const result = await owner.navigateOrNotify(token, 'session_created', {
    navigate: async (sessionId) => navigated.push(sessionId),
  });
  assert.deepEqual(result, { navigated: true, notified: false });
  assert.deepEqual(navigated, ['session_created']);
});
