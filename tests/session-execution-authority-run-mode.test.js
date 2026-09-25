const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');

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
