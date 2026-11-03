'use strict';

// Row 87 (owner pick C1): a Jenny-chat message card to a chat it started offers "Always allow for chats Jenny
// started" when the backend made the offer (rememberOffer); the offer reaches the card from the live request
// and on a reopen. A call a rule refused before any card reads "Blocked by your rule".

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { renderApprovalBlock, resolveApprovalCardState } = require('../renderer/chat/renderer-approval-block');

function approval(overrides = {}) {
  return {
    schema_version: 1,
    destination: { session_id: 'kid-1', title: 'Hero copy', project_label: 'Website' },
    body: 'The hero copy is approved. Please draft the pricing section next.',
    envelope_sha256: 'a'.repeat(64),
    one_off_only: true,
    ...overrides,
  };
}

function render(extra = {}) {
  const html = renderApprovalBlock({
    toolCallId: 'call_1', approvalId: 'approval_1', toolName: 'session_message', mode: 'card',
    sessionMessageApproval: approval(), oneOffOnly: true, ...extra,
  }, { escapeHtml });
  return new JSDOM(`<!doctype html><body><div id="root">${html}</div></body>`).window.document.getElementById('root');
}

test('an offered message card adds the C1 button beside Allow once, with its note, and no plain Always allow', () => {
  const root = render({ rememberOffer: 'linked_children' });
  const buttons = Array.from(root.querySelectorAll('.tool-approval-actions button')).map((button) => button.textContent);
  assert.deepEqual(buttons, ['Allow once', 'Always allow for chats Jenny started', 'Deny']);
  const remember = root.querySelector('[data-approval-remember]');
  assert.equal(remember.getAttribute('data-approval-remember'), 'linked_children');
  assert.equal(remember.getAttribute('data-approval-scope'), 'once', 'the rule is the remember token, never a tool-wide always');
  assert.equal(remember.getAttribute('data-action'), 'approve');
  assert.equal(remember.getAttribute('data-call-id'), 'call_1');
  assert.equal(root.querySelector('.tool-approval-scope-note').textContent,
    'Always allow saves a rule you can remove in Activity > Permissions. Each message is still recorded.');
  assert.equal(root.querySelector('[data-approval-scope="always"]'), null);
});

test('no offer, another token, a body that did not arrive intact, or a paused card shows no C1 button', () => {
  for (const [label, extra] of [
    ['no offer', {}],
    ['another token', { rememberOffer: 'any' }],
    ['no intact body', { rememberOffer: 'linked_children', sessionMessageApproval: null }],
    ['paused', { rememberOffer: 'linked_children', cardState: 'paused', resumeKey: 'k' }],
  ]) {
    const root = render(extra);
    assert.equal(root.querySelector('[data-approval-remember]'), null, label);
    assert.equal(root.querySelector('.tool-approval-scope-note'), null, label);
  }
});

test('the live approval hands its offer to the card state; nothing else does', () => {
  const state = { pendingToolApprovals: new Map([['a', { callId: 'call_1', rememberOffer: 'linked_children' }], ['b', { callId: 'call_2', rememberOffer: 'x' }]]) };
  assert.equal(resolveApprovalCardState(state, { callId: 'call_1' }).rememberOffer, 'linked_children');
  assert.equal(Object.hasOwn(resolveApprovalCardState(state, { callId: 'call_2' }), 'rememberOffer'), false);
});

test('a denied call tagged rule_denied reads Blocked by your rule; other denials keep Denied', () => {
  assert.equal(toolCallUtils.getResultStatusLabel('denied', { metadata: { rule_denied: true, recovery: 'approval_resolved' } }), 'Blocked by your rule');
  assert.equal(toolCallUtils.getResultStatusLabel('denied', { metadata: { recovery: 'approval_resolved' } }), 'Denied');
  assert.equal(toolCallUtils.getResultStatusLabel('denied', { metadata: { rule_denied: 'yes' } }), 'Denied');
  assert.equal(toolCallUtils.getResultStatusLabel('completed', { metadata: { rule_denied: true } }), 'Success');
});
