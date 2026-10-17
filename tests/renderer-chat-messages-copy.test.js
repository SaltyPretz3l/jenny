'use strict';

// Failure copy for the addressed-message surfaces (row 59 cp5b-2): the four authorization and
// limit tokens map to closed English phrases, by reason token or by code, never verbatim.

const test = require('node:test');
const assert = require('node:assert/strict');

const copy = require('../renderer/chat/renderer-chat-messages-copy');

test('the dialog line for each authorization and limit token is its own closed sentence', () => {
  const expected = {
    authorization_required: 'This message needs your approval before it can be sent.',
    authorization_revoked: 'Permission to send in this direction was revoked or has expired.',
    turn_send_limit: 'This chat has reached its message limit for one reply.',
    capacity: 'Too many directions are already allowed from this chat. Revoke one first.',
  };
  for (const [reason, text] of Object.entries(expected)) {
    assert.equal(copy.actionFailureText({ ok: false, reason }), text);
  }
  assert.equal(new Set(Object.values(expected)).size, 4);
  assert.equal(copy.actionFailureText({ ok: false, code: 'CMP-MESSAGE-0003' }), expected.authorization_required);
  assert.equal(copy.actionFailureText({ ok: false, code: 'CMP-MESSAGE-0004' }), expected.authorization_revoked);
});

test('the delivery-failure detail names the revoked, unapproved and over-limit cases', () => {
  assert.equal(copy.deliveryFailureDetail({ reason: 'authorization_required' }), 'it was not approved');
  assert.equal(copy.deliveryFailureDetail({ reason: 'authorization_revoked' }), 'permission to send was revoked or expired');
  assert.equal(copy.deliveryFailureDetail({ reason: 'turn_send_limit' }), 'too many messages in one reply');
  assert.equal(copy.deliveryFailureDetail({ reason: 'something_new' }), 'something went wrong');
});

test('an unknown reason is never printed verbatim', () => {
  assert.doesNotMatch(copy.actionFailureText({ ok: false, reason: 'rm_rf_everything' }), /rm_rf/u);
});

test('the grant expiry is a short readable date and an unreadable one is empty', () => {
  assert.match(copy.formatGrantExpiry('2026-10-22T15:38:00.000Z'), /22/u);
  assert.equal(copy.formatGrantExpiry('not a date'), '');
  assert.equal(copy.formatGrantExpiry(null), '');
  assert.equal(copy.GRANT_PURPOSE_MAX_BYTES, 512);
});
