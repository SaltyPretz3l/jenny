'use strict';

/* services/main/primary-chat-wiring.js - desktop composition of the primary Jenny chat's
 * controls and activity log (row 76). The controls service keeps the pause flag, the
 * standing launch permissions and the control history in the `primaryChat` shell-config
 * block; the activity log is a read-only projector over the primary's own mail and
 * proposal containers, the runtime work index, its transcript's session_stop rows and the
 * controls state. Every port reads `backendService` lazily, so attach order inside the
 * composition root does not matter; the wake gate, the proposal publish and the
 * primaryChat.* IPC reach both through `backendService.primaryChatControls` and
 * `backendService.primaryActivityLog`. Invalidations ride the bridge-event bus.
 */

const { createSessionMailStore } = require('../backend/session-mail-store');
const { createChatProposalStore } = require('../backend/chat-proposal-store');
const { createPrimaryChatControls } = require('../primary-chat-controls');
const { createPrimaryActivityLog } = require('../primary-activity-log');

function attachPrimaryChat(backendService, { configService, emit = () => {}, log = () => {} }) {
  const store = () => backendService.sessionStore;
  backendService.primaryChatControls = createPrimaryChatControls({
    configService,
    sessionStore: store,
    featureFlags: () => backendService.featureFlags,
    projectService: () => backendService.projectService,
    resumeWake: (sessionId) => backendService.chatMessages?.resumeWake?.(sessionId) ?? null,
    emit,
    log,
  });
  backendService.primaryActivityLog = createPrimaryActivityLog({
    primarySessionId: () => backendService.primaryChatControls.primarySessionId(),
    // The raw read results: `{ok:false}` is one unavailable source in the log's diagnostics.
    readMail: (sessionId) => createSessionMailStore(store()).read(sessionId),
    readProposals: (sessionId) => createChatProposalStore(store()).read(sessionId),
    runtimeStore: () => backendService.sessionRuntime?.store || null,
    peekMessages: (sessionId) => store()?.peekSessionMessages?.(sessionId) || [],
    controls: () => backendService.primaryChatControls,
    getSessionSummary: (sessionId) => store()?.getSessionSummary?.(sessionId) ?? null,
    getProject: (projectId) => backendService.projectService?.get?.(projectId) ?? null,
    featureFlags: () => backendService.featureFlags ?? {},
    log,
  });
  return backendService;
}

module.exports = { attachPrimaryChat };
