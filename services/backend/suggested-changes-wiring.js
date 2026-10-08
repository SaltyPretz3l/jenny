'use strict';

// Composes the Propose-mode suggestion service (row 35) against the live backend:
// the session store, the session's project authority (the apply root) and the
// sidecar's `workspace.apply_suggested_changes`. Desktop (services/main) pushes
// `emit` to the renderer bridge; the hosted composition re-reads on its own
// session revisions, so it passes none.

const { SuggestedChangesService } = require('./suggested-changes-service');
const { applySuggestedChanges } = require('./suggested-changes-apply');
const { isSessionBusy } = require('./chat-stream-admission');

function createSuggestedChangesService({ backendService, emit = () => {}, log = () => {} }) {
  return new SuggestedChangesService({
    getStore: () => backendService.sessionStore || null,
    projectAuthority: {
      captureSession: (sessionId) => backendService.projectAuthority?.captureSession?.(sessionId) || null,
    },
    applyRequest: ({ authority, sessionId, items }) => {
      const client = backendService.sidecarClient;
      if (!client || typeof client.request !== 'function') throw new Error('sidecar_unavailable');
      return applySuggestedChanges({
        request: (method, params, options) => client.request(method, params, options),
        authority,
        sessionId,
        items,
      });
    },
    emit,
    logger: (level, event, details) => log(level, event, details),
    isSessionRunning: (sessionId) => isSessionBusy(backendService, { sessionId, store: backendService.sessionStore }),
  });
}

module.exports = { createSuggestedChangesService };
