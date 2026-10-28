'use strict';

// Hosted/browser commands never reach the desktop-only row 59 bridges
// (chatWorkspace, sessionProposals, chatMessages, performance); split from command-router.test.js.

const assert = require('node:assert/strict');
const test = require('node:test');

const { command, createFixture, createSession } = require('../helpers/command-router-fixture');

test('hosted/browser commands cannot reach the desktop chatWorkspace operations', async (t) => {
  const { validateCommand } = require('../../server/api-contract');
  const f = createFixture(); t.after(() => f.close());
  const sessionId = await createSession(f);
  const operations = [
    ['chatWorkspace.getSummary', { schema_version: 1, session_id: sessionId }],
    ['chatWorkspace.setView', { schema_version: 1, session_id: sessionId, expected_revision: 0, patch: { rail_visible: true } }],
    ['chatWorkspace.listChanges', { schema_version: 1, session_id: sessionId }],
    ['chatWorkspace.getChangeDiff', { schema_version: 1, session_id: sessionId, path: 'a.txt' }],
    ['chat-workspace:get-change-diff', { path: '../../secret' }],
  ];
  for (const [operation, params] of operations) {
    const raw = command(f.a, operation, params, { session_id: sessionId });
    assert.deepEqual(validateCommand(raw), { ok: false, reason: 'invalid_command_envelope' }, operation);
    const result = await f.router.dispatch(raw, f.contextA);
    assert.equal(result.ok, false, operation);
    assert.equal(result.error.reason, 'invalid_command_envelope', operation);
  }
});

test('hosted/browser commands cannot reach the desktop performance operations', async (t) => {
  const { validateCommand } = require('../../server/api-contract');
  const f = createFixture(); t.after(() => f.close());
  const sessionId = await createSession(f);
  const operations = [
    ['performance.getSnapshot', { schema_version: 1, session_id: sessionId }],
    ['performance.updateSettings', { schema_version: 1, show_counter: true }],
    ['performance.dismissWarning', { schema_version: 1, session_id: sessionId, warning_id: '123e4567-e89b-42d3-a456-426614174000' }],
    ['performance:get-snapshot', { schema_version: 1, session_id: sessionId }],
  ];
  for (const [operation, params] of operations) {
    const raw = command(f.a, operation, params, { session_id: sessionId });
    assert.deepEqual(validateCommand(raw), { ok: false, reason: 'invalid_command_envelope' }, operation);
    const result = await f.router.dispatch(raw, f.contextA);
    assert.equal(result.ok, false, operation);
    assert.equal(result.error.reason, 'invalid_command_envelope', operation);
  }
});

test('hosted/browser commands cannot reach the desktop chatMessages operations', async (t) => {
  const { validateCommand } = require('../../server/api-contract');
  const f = createFixture(); t.after(() => f.close());
  const sessionId = await createSession(f);
  const operationId = '11111111-1111-4111-8111-111111111111';
  const operations = [
    ['chatMessages.listRecipients', { schema_version: 1, source_session_id: sessionId }],
    ['chatMessages.prepare', {
      schema_version: 1, source_session_id: sessionId, destination_session_id: sessionId, body: 'hi', gesture_id: operationId,
    }],
    ['chatMessages.send', { schema_version: 1, operation_id: operationId }],
    ['chatMessages.retry', { schema_version: 1, operation_id: operationId }],
    ['chatMessages.cancel', { schema_version: 1, operation_id: operationId }],
    ['chatMessages.list', { schema_version: 1, session_id: sessionId, direction: 'inbox' }],
    ['chatMessages.markRead', { schema_version: 1, session_id: sessionId, message_ids: [operationId] }],
    ['chatMessages.setContextDisposition', {
      schema_version: 1, session_id: sessionId, message_ids: [operationId], disposition: 'queued',
    }],
    ['chatMessages.discard', { schema_version: 1, session_id: sessionId, message_ids: [operationId] }],
    ['chatMessages.createGrant', { schema_version: 1 }],
    ['chat-messages:send', { operation_id: operationId }],
  ];
  for (const [operation, params] of operations) {
    const raw = command(f.a, operation, params, { session_id: sessionId });
    assert.deepEqual(validateCommand(raw), { ok: false, reason: 'invalid_command_envelope' }, operation);
    const result = await f.router.dispatch(raw, f.contextA);
    assert.equal(result.ok, false, operation);
    assert.equal(result.error.reason, 'invalid_command_envelope', operation);
  }
});

test('hosted/browser commands cannot reach the desktop sessionProposals operations', async (t) => {
  const { validateCommand } = require('../../server/api-contract');
  const f = createFixture(); t.after(() => f.close());
  const sessionId = await createSession(f);
  const proposalId = `proposal_${'a'.repeat(64)}`;
  const operations = [
    ['sessionProposals.get', { schema_version: 1, session_id: sessionId, proposal_id: proposalId }],
    ['sessionProposals.list', { schema_version: 1, session_id: sessionId }],
    ['sessionProposals.decide', {
      schema_version: 1, session_id: sessionId, proposal_id: proposalId, expected_revision: 1,
      decision_id: '11111111-1111-4111-8111-111111111111', choice: 'commit',
    }],
    ['sessionProposals.cancel', { schema_version: 1, session_id: sessionId, proposal_id: proposalId, expected_revision: 1, decision_id: '11111111-1111-4111-8111-111111111111' }],
    ['sessionProposals.retry', { schema_version: 1, session_id: sessionId, proposal_id: proposalId, expected_revision: 1, decision_id: '11111111-1111-4111-8111-111111111111' }],
    ['sessionProposals.startAll', { schema_version: 1, session_id: sessionId }],
    ['session-proposals:decide', { proposal_id: proposalId, choice: 'commit' }],
  ];
  for (const [operation, params] of operations) {
    const raw = command(f.a, operation, params, { session_id: sessionId });
    assert.deepEqual(validateCommand(raw), { ok: false, reason: 'invalid_command_envelope' }, operation);
    const result = await f.router.dispatch(raw, f.contextA);
    assert.equal(result.ok, false, operation);
    assert.equal(result.error.reason, 'invalid_command_envelope', operation);
  }
});

test('hosted/browser commands cannot reach the desktop primaryChat operations', async (t) => {
  const { validateCommand } = require('../../server/api-contract');
  const f = createFixture(); t.after(() => f.close());
  const sessionId = await createSession(f);
  const operations = [
    ['primaryChat.getState', { schema_version: 1 }],
    ['primaryChat.activity', { schema_version: 1, limit: 10 }],
    ['primaryChat.permissions', { schema_version: 1 }],
    ['primaryChat.pause', { schema_version: 1 }],
    ['primaryChat.grantLaunch', { schema_version: 1, project_id: '*' }],
    ['primaryChat.reset', { schema_version: 1, forget: true }],
    ['primary-chat:reset', { schema_version: 1 }],
  ];
  for (const [operation, params] of operations) {
    const raw = command(f.a, operation, params, { session_id: sessionId });
    assert.deepEqual(validateCommand(raw), { ok: false, reason: 'invalid_command_envelope' }, operation);
    const result = await f.router.dispatch(raw, f.contextA);
    assert.equal(result.ok, false, operation);
    assert.equal(result.error.reason, 'invalid_command_envelope', operation);
  }
});
