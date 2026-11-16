'use strict';

// A real trusted execution binding for an approval test (the binding a turn carries is opaque; only
// SessionExecutionAuthority's trusted context answers its mode). `summary` is the session as the run-state read sees
// it: { run_mode, plan_mode }; `readOnly` is the capture's own read-only flag.

const os = require('node:os');

const { SessionExecutionAuthority } = require('../../services/backend/session-execution-authority');

function trustedTurn(sessionId, { runMode = 'assist', planMode = false, readOnly = false, approvalMode = 'prompt' } = {}) {
  const project = { project_id: 'p', root_path: os.tmpdir(), root_id: 'r', root_revision: 1, device_id: 'd', inode: 'i' };
  const summary = { id: sessionId, run_mode: runMode, plan_mode: planMode };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: (current) => current,
      _sessionStore: { getSessionSummary: () => summary } },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  return authority.captureSession(sessionId, { requestId: 'req-trusted', mode: 'assist', approvalMode, readOnly });
}

module.exports = { trustedTurn };
