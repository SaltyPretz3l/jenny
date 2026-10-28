'use strict';

// A trusted live tool-call context for the caller chat (row 69): a real
// SessionExecutionAuthority binding plus the matching active turn, so
// `checkLiveCall(context)` (propose-tool-support.js) answers ok.

const os = require('node:os');
const { SessionExecutionAuthority } = require('../../services/backend/session-execution-authority');

function liveCallFields(sessionId, { projectId = 'project_general' } = {}) {
  const record = Object.freeze({
    project_id: projectId, root_path: os.tmpdir(), root_id: 'root_live', root_revision: 1, device_id: 'dev', inode: 'ino',
  });
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => record, requireCurrent: (captured) => captured },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
    randomUUID: () => 'authority_revision_live',
  });
  const executionAuthority = authority.captureSession(sessionId, { requestId: 'stream_live', mode: 'assist', approvalMode: 'prompt' });
  const activeTurn = { stream_id: 'stream_live', turn_id: 'turn_live', session_incarnation: 'inc_live' };
  return {
    activeTurn,
    fields: {
      sessionId, streamId: 'stream_live', logicalTurnId: 'turn_live', sessionIncarnation: 'inc_live',
      executionAuthority, projectAuthority: record,
    },
  };
}

module.exports = { liveCallFields };
