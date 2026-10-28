'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { primaryChatRoleFields } = require('../services/backend/chat-send-optional-fields');

const service = { featureFlags: {} };

test('only the primary chat stamps session_role on chat.send', () => {
  assert.deepEqual(primaryChatRoleFields(service, { id: 's', session_role: 'primary' }), { session_role: 'primary' });
  for (const summary of [{ id: 's' }, { session_role: null }, { session_role: 'Primary' }, { session_role: 'boss' }, null, undefined, 'primary']) {
    assert.deepEqual(primaryChatRoleFields(service, summary), {}, JSON.stringify(summary));
  }
});

test('the primary_chat kill switch sends the primary like any other chat', () => {
  assert.deepEqual(primaryChatRoleFields({ featureFlags: { primary_chat: false } }, { session_role: 'primary' }), {});
});
