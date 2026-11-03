const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionExecutionAuthority, getTrustedExecutionBinding } = require('../services/backend/session-execution-authority');

// A run-mode flip while a request is in flight (Plan toggled during the model
// load in the 2026-09-15 GUI gate) fails the request by design. The failure
// has to carry a stable code so the terminal error classifier can name the
// cause and offer the retry, instead of the generic "Retry available" copy a
// bare Error gets.
function createAuthority(summary) {
  const authority = Object.freeze({
    project_id: 'project_1',
    root_path: null,
    root_id: null,
    root_revision: 1,
    device_id: null,
    inode: null,
  });
  return new SessionExecutionAuthority({
    projectAuthority: {
      _sessionStore: { getSessionSummary: () => summary },
      captureSession: () => authority,
      requireCurrent: (captured) => captured,
    },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
    randomUUID: () => 'authority_revision_1',
  });
}

test('a run-mode change during the request throws the coded retryable run_mode_changed error', () => {
  const summary = { id: 'session_1', run_mode: 'ask', plan_mode: false };
  const authority = createAuthority(summary);
  const binding = authority.captureSession('session_1', {
    requestId: 'request_1',
    mode: 'assist',
    approvalMode: 'prompt',
  });
  assert.doesNotThrow(() => authority.requireCurrent(binding));

  summary.plan_mode = true;

  assert.throws(() => authority.requireCurrent(binding), (error) => {
    assert.equal(error.code, 'run_mode_changed');
    assert.equal(error.retryable, true);
    assert.match(error.message, /run mode changed/i);
    return true;
  });
});

// Propose (row 35): the binding records it, and entering or leaving Propose
// mid-request stops the reply like a Plan flip does.
test('entering or leaving Propose during the request throws run_mode_changed', () => {
  for (const [from, to] of [['ask', 'propose'], ['propose', 'ask'], ['propose', 'auto']]) {
    const summary = { id: 'session_1', run_mode: from, plan_mode: false };
    const authority = createAuthority(summary);
    const binding = authority.captureSession('session_1', {
      requestId: 'request_1', mode: 'assist', approvalMode: 'prompt',
    });
    assert.doesNotThrow(() => authority.requireCurrent(binding));
    summary.run_mode = to;
    assert.throws(() => authority.requireCurrent(binding), (error) => error.code === 'run_mode_changed',
      `${from} -> ${to}`);
  }
});

test('a Propose binding is read-only and stays put while the mode holds', () => {
  const summary = { id: 'session_1', run_mode: 'propose', plan_mode: false };
  const authority = createAuthority(summary);
  const binding = authority.captureSession('session_1', {
    requestId: 'request_1', mode: 'assist', approvalMode: 'prompt',
  });
  assert.doesNotThrow(() => authority.requireCurrent(binding));
  assert.equal(getTrustedExecutionBinding(binding).readOnly, true);
});

// 2026-10-31 session review: Ask -> Auto while an approval card was open left the
// binding at autoRun=false, so once the sidecar stopped asking every ask-class
// call was refused "Current tool policy does not authorize this operation." with
// no card. The binding now follows an observed Ask -> Auto transition.
const REVISION = '8f04ce56-3fd5-4f3f-907c-3a0a6ea83580';

function createRootedAuthority(summary) {
  const authority = Object.freeze({
    project_id: 'project_1',
    root_path: 'G:\\project',
    root_id: 'root_1',
    root_revision: 1,
    device_id: null,
    inode: null,
  });
  return new SessionExecutionAuthority({
    projectAuthority: {
      _sessionStore: { getSessionSummary: () => summary },
      captureSession: () => authority,
      requireCurrent: (captured) => captured,
    },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: { read_file: 'ask' }, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
    randomUUID: () => REVISION,
  });
}

function readOperation(operationId) {
  return {
    api_version: '2026-10-15',
    schema_version: 1,
    request_id: 'request_1',
    session_id: 'session_1',
    authority_revision: REVISION,
    operation_id: operationId,
    phase: 'check',
    tool_name: 'read_file',
    arguments: { path: 'README.md' },
  };
}

test('an Ask -> Auto flip mid-request authorizes later ask-class calls instead of refusing them', () => {
  const summary = { id: 'session_1', run_mode: 'ask', plan_mode: false };
  const authority = createRootedAuthority(summary);
  const binding = authority.captureSession('session_1', {
    requestId: 'request_1', mode: 'assist', approvalMode: 'prompt',
  });
  assert.equal(authority.checkRuntimeOperation(binding, readOperation('call_1')).error.reason,
    'policy_rejected');

  summary.run_mode = 'auto';
  assert.doesNotThrow(() => authority.requireCurrent(binding));
  assert.equal(authority.checkRuntimeOperation(binding, readOperation('call_2')).status, 'granted');
  assert.equal(getTrustedExecutionBinding(binding).autoRun, true);

  // Back to Ask is a downgrade: the request stops, as before.
  summary.run_mode = 'ask';
  assert.throws(() => authority.requireCurrent(binding), (error) => error.code === 'run_mode_changed');
});

test('a request captured with prompt approvals while the chat was already Auto keeps asking', () => {
  const summary = { id: 'session_1', run_mode: 'auto', plan_mode: false };
  const authority = createRootedAuthority(summary);
  const binding = authority.captureSession('session_1', {
    requestId: 'request_1', mode: 'assist', approvalMode: 'prompt',
  });
  assert.equal(authority.checkRuntimeOperation(binding, readOperation('call_1')).error.reason,
    'policy_rejected');
  assert.equal(getTrustedExecutionBinding(binding).autoRun, false);
});
