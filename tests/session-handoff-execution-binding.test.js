'use strict';

// The trusted execution binding of a linked chat's handoff-only preparation turn (row 59 checkpoint 5a-1,
// slice S3; split from session-handoff-turn.test.js): capture, fail-closed validation, runtime operation refusal.
const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionExecutionAuthority, getTrustedExecutionBinding } = require('../services/backend/session-execution-authority');
const { TOOL_ERROR_CODES } = require('../services/backend/error-codes');

const PROPOSAL = `proposal_${'cd34'.repeat(16)}`;
const ATTEMPT = '1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e';
const PREPARATION = { proposal_id: PROPOSAL, attempt_id: ATTEMPT };

function createAuthority() {
  const authority = Object.freeze({ project_id: 'project_1', root_path: null, root_id: null, root_revision: 1, device_id: null, inode: null });
  return new SessionExecutionAuthority({
    projectAuthority: {
      _sessionStore: { getSessionSummary: () => ({ id: 'session_1', run_mode: 'ask', plan_mode: false }) },
      captureSession: () => authority,
      requireCurrent: (captured) => captured,
    },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
    randomUUID: () => 'authority_revision_1',
  });
}

const operation = (toolName = 'read_file') => ({
  api_version: '2026-10-15', schema_version: 1, phase: 'check', request_id: 'request_1', session_id: 'session_1',
  authority_revision: 'authority_revision_1', operation_id: 'op_1', tool_name: toolName, arguments: {},
});

test('the trusted binding records handoffPreparation from the request, null otherwise', () => {
  const authority = createAuthority();
  const prep = authority.captureSession('session_1', { requestId: 'request_1', mode: 'assist', handoffPreparation: PREPARATION });
  assert.deepEqual(getTrustedExecutionBinding(prep).handoffPreparation, { proposalId: PROPOSAL, attemptId: ATTEMPT });
  assert.equal(Object.isFrozen(getTrustedExecutionBinding(prep).handoffPreparation), true);
  for (const absent of [undefined, null]) {
    const plain = authority.captureSession('session_1', { requestId: 'request_1', mode: 'assist', handoffPreparation: absent });
    assert.equal(getTrustedExecutionBinding(plain).handoffPreparation, null);
  }
  assert.equal(getTrustedExecutionBinding(authority.captureSession('session_1', { requestId: 'request_1' })).handoffPreparation, null);
});

test('a malformed preparation capture fails closed instead of running an unrestricted turn', () => {
  const authority = createAuthority();
  for (const bad of [{}, 'x', { proposal_id: PROPOSAL }, { ...PREPARATION, extra: 1 }, { proposal_id: 'proposal_x', attempt_id: ATTEMPT }]) {
    assert.throws(() => authority.captureSession('session_1', { requestId: 'request_1', handoffPreparation: bad }), /handoff preparation is invalid/i);
  }
});

test('checkRuntimeOperation refuses runtime operations in a preparation turn and not elsewhere', () => {
  const authority = createAuthority();
  const prep = authority.captureSession('session_1', { requestId: 'request_1', mode: 'assist', handoffPreparation: PREPARATION });
  const plain = authority.captureSession('session_1', { requestId: 'request_1', mode: 'assist' });
  for (const name of ['read_file', 'run_command', 'complete_session_handoff']) {
    const refused = authority.checkRuntimeOperation(prep, operation(name));
    assert.equal(refused.status, 'rejected', name);
    assert.equal(refused.error.reason, 'handoff_preparation_only', name);
    assert.equal(refused.error.code, TOOL_ERROR_CODES.POLICY_DENIED, name);
  }
  assert.notEqual(authority.checkRuntimeOperation(plain, operation('read_file')).error?.reason, 'handoff_preparation_only');
  // A mismatched authority revision is still reported as such first.
  assert.equal(authority.checkRuntimeOperation(prep, { ...operation(), authority_revision: 'other' }).error.reason, 'authority_mismatch');
});
