const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldSendOnEnterKeydown } = require('../renderer/chat/renderer-chat-event-utils');

// Regression coverage for the IME composition guard on the composer's
// Enter-to-send handler (renderer/chat/renderer-chat-event-utils.js). Before
// the guard, pressing Enter to commit/select an IME candidate (CJK,
// Vietnamese Telex, dead-key accents, …) sent the half-composed text and
// tore down the composition, making text entry unusable for IME users.

test('plain Enter triggers send', () => {
  assert.equal(shouldSendOnEnterKeydown({ key: 'Enter' }), true);
  assert.equal(shouldSendOnEnterKeydown({ key: 'Enter', keyCode: 13 }), true);
  assert.equal(shouldSendOnEnterKeydown({ key: 'Enter', isComposing: false }), true);
});

test('Shift+Enter inserts a newline instead of sending', () => {
  assert.equal(shouldSendOnEnterKeydown({ key: 'Enter', shiftKey: true }), false);
});

test('Enter while an IME composition is active does not send', () => {
  assert.equal(shouldSendOnEnterKeydown({ key: 'Enter', isComposing: true }), false);
});

test('legacy keyCode 229 (IME commit keystroke) does not send', () => {
  assert.equal(shouldSendOnEnterKeydown({ key: 'Enter', keyCode: 229 }), false);
});

test('non-Enter keys and malformed events never send', () => {
  assert.equal(shouldSendOnEnterKeydown({ key: 'a' }), false);
  assert.equal(shouldSendOnEnterKeydown({ key: 'Escape' }), false);
  assert.equal(shouldSendOnEnterKeydown(null), false);
  assert.equal(shouldSendOnEnterKeydown(undefined), false);
  assert.equal(shouldSendOnEnterKeydown({}), false);
});
