'use strict';

// Composes the Propose-mode suggestion service (row 35) against the live backend:
// the session store, the session's project authority (the apply root) and the
// sidecar's `workspace.apply_suggested_changes`. Desktop (services/main) pushes
// `emit` to the renderer bridge; the hosted composition re-reads on its own
// session revisions, so it passes none.

const { SuggestedChangesService } = require('./suggested-changes-service');
const { applySuggestedChanges } = require('./suggested-changes-apply');
const { API_VERSION } = require('./sidecar-client');
const { resolveRequestTimeoutMs } = require('./sidecar-request-timeouts');
const { isSessionBusy } = require('./chat-stream-admission');

function sidecarRequest(backendService) {
  const client = backendService.sidecarClient;
  if (!client || typeof client.request !== 'function') throw new Error('sidecar_unavailable');
  return (method, params, options) => client.request(method, params, options);
}

const LIST_METHOD = 'workspace.list_change_sets';
const CHANGE_SET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The journal change set an earlier apply wrote, found by the session and apply
// id its attribution recorded (`turn_id` is the apply id), or null. The list is
// bound to the session's workspace authority, as the apply was.
async function findApplyChangeSet(request, authority, sessionId, applyId) {
  const params = {
    accept_version: API_VERSION,
    workspace_root: authority.root_path,
    device_id: String(authority.device_id),
    inode: String(authority.inode),
  };
  const result = await request(LIST_METHOD, params, { timeoutMs: resolveRequestTimeoutMs(LIST_METHOD) });
  const match = (Array.isArray(result?.change_sets) ? result.change_sets : [])
    .find((item) => item && item.session_id === sessionId && item.turn_id === applyId);
  return match && CHANGE_SET_ID_PATTERN.test(String(match.change_set_id || ''))
    ? { change_set_id: match.change_set_id, state: String(match.state || '') }
    : null;
}

function createSuggestedChangesService({ backendService, emit = () => {}, log = () => {} }) {
  return new SuggestedChangesService({
    getStore: () => backendService.sessionStore || null,
    projectAuthority: {
      captureSession: (sessionId) => backendService.projectAuthority?.captureSession?.(sessionId) || null,
    },
    // The apply id saved with the attempt is the one the journal records.
    applyRequest: ({ authority, sessionId, items, applyId }) => applySuggestedChanges({
      request: sidecarRequest(backendService),
      authority,
      sessionId,
      items,
      applyId,
    }),
    findApplyChangeSet: ({ authority, sessionId, applyId }) => findApplyChangeSet(sidecarRequest(backendService), authority, sessionId, applyId),
    emit,
    logger: (level, event, details) => log(level, event, details),
    isSessionRunning: (sessionId) => isSessionBusy(backendService, { sessionId, store: backendService.sessionStore }),
  });
}

module.exports = { createSuggestedChangesService };
