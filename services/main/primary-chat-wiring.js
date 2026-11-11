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
const { createPrimaryActionRules } = require('../primary-action-rules');
const { createPrimaryFullAuto } = require('../primary-full-auto');
const { createPrimaryActivityLog } = require('../primary-activity-log');
const { wirePrimaryScheduledChecks } = require('../primary-scheduled-check');
const { createPrimarySettingsService } = require('../primary-settings-service');
const { createPrimaryChatManageService } = require('../primary-chat-manage-service');
const { createPrimaryChatPlacementService } = require('../primary-chat-placement-service');
const { createAppViewService } = require('../app-view-service');
const { createPrimaryChatExportService } = require('../primary-chat-export-service');
const { createTerminalToolsService } = require('../terminal-tools-service');
const { createPrimaryScheduleService } = require('../primary-schedule-service');
const { createAppearanceRelay } = require('./appearance-relay');

// `protectedPaths` (row 94 P2): folders the Jenny chat may never bind to a project (Jenny's data, its install when packaged).
function attachPrimaryChat(backendService, {
  configService, emit = () => {}, sendBridgeEvent = () => {}, log = () => {}, getMainWindow = null, protectedPaths = () => [],
  getDownloadsDir = () => null,
}) {
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
  // Row 87 D2: the per-action rules matcher. A wake, fired check or digest turn, or a turn that admitted another
  // chat's queued mail, never spends an allow rule; without the messaging service or a turn id it counts as a wake.
  backendService.primaryActionRules = createPrimaryActionRules({
    controls: () => backendService.primaryChatControls,
    getSessionSummary: (sessionId) => store()?.getSessionSummary?.(sessionId) ?? null,
    isWakeTurn: (_sessionId, turnId) => {
      if (typeof turnId !== 'string' || !turnId) return true;
      const depth = backendService.chatMessages?.wakeDepth?.(turnId);
      return !Number.isSafeInteger(depth) || depth > 0 || backendService.chatMessages?.mailTurn?.(turnId) === true;
    },
    log,
  });
  // Full auto: the in-memory armed state over the Jenny chat's Auto mode (never persisted). A change rides the
  // existing primaryChat.onChanged invalidation; the renderer refetches getFullAuto.
  backendService.primaryFullAuto = createPrimaryFullAuto({
    primarySessionId: () => backendService.primaryChatControls?.primarySessionId?.() || '',
    getRunMode: (sessionId) => store()?.getSessionSummary?.(sessionId)?.run_mode ?? '',
    isEnabled: () => backendService.featureFlags?.primary_full_auto !== false && backendService.featureFlags?.primary_chat !== false,
    onChange: () => emit({ schema_version: 1, session_id: backendService.primaryChatControls?.primarySessionId?.() || '' }),
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
  // Row 94 P1: the port behind chat_organize / chat_configure and Activity's Undo for their changes. It applies
  // each change through the same backend and project paths the sidebar uses, so their guards still apply.
  backendService.primaryChatManage = createPrimaryChatManageService({
    backendService: () => backendService,
    sessionStore: store,
    projectApplicationService: () => backendService.projectApplicationService,
    controls: () => backendService.primaryChatControls,
    featureFlags: () => backendService.featureFlags,
    primarySessionId: () => backendService.primaryChatControls?.primarySessionId?.() ?? null,
    isSessionBusy: (sessionId) => require('../projects/application-execution-composition').isSessionBusy(backendService, sessionId),
    resolveEffort: (effort, model) => require('../backend/backend-managed-reasoning').resolveRequestReasoningEffort(backendService, effort, model),
    placement: () => backendService.primaryChatPlacement,
    log,
  });
  // Row 94 P2: the port behind project_create / projects_list, their card and the Undo of a created project.
  // A project is created and bound through the same project application paths the sidebar uses.
  backendService.primaryChatPlacement = createPrimaryChatPlacementService({
    projectApplicationService: () => backendService.projectApplicationService,
    projectService: () => backendService.projectService,
    sessionStore: store,
    controls: () => backendService.primaryChatControls,
    featureFlags: () => backendService.featureFlags,
    primarySessionId: () => backendService.primaryChatControls?.primarySessionId?.() ?? null,
    hostMode: () => backendService.hostMode,
    emitSessionsChanged: (payload) => backendService.emitSessionsChanged?.(payload),
    protectedPaths,
    log,
  });
  // Row 94 P3: the port behind app_view; its push goes to the main window only (sendBridgeEvent).
  backendService.appView = createAppViewService({
    sendBridgeEvent,
    isRendererAvailable: () => { const win = getMainWindow?.(); return Boolean(win) && !win.isDestroyed(); },
    featureFlags: () => backendService.featureFlags,
    primarySessionId: () => backendService.primaryChatControls?.primarySessionId?.() ?? null,
    hostMode: () => backendService.hostMode,
    projectService: () => backendService.projectService,
    projectApplicationService: () => backendService.projectApplicationService,
    log,
  });
  const primarySessionId = () => backendService.primaryChatControls?.primarySessionId?.() ?? null;
  const rendererAvailable = () => { const win = getMainWindow?.(); return Boolean(win) && !win.isDestroyed(); };
  // Row 94 P4: the port behind session_export and its card; it writes a redacted Markdown copy into Downloads.
  backendService.primaryChatExport = createPrimaryChatExportService({
    sessionStore: store,
    sessionDirectory: () => backendService.getSessionDirectory?.() ?? null,
    featureFlags: () => backendService.featureFlags,
    primarySessionId,
    hostMode: () => backendService.hostMode,
    getDownloadsDir,
    protectedPaths,
    log,
  });
  // Row 94 P4: the port behind terminal_read / terminal_run; reads the pty service's tail, and its run push goes to the
  // main window only (the IDE opens a terminal of its own for the command).
  backendService.terminalTools = createTerminalToolsService({
    ptyService: () => backendService.workspacePtyService ?? null,
    featureFlags: () => backendService.featureFlags,
    primarySessionId,
    hostMode: () => backendService.hostMode,
    workspaceRoot: () => configService()?.getToolsWorkspaceRoot?.() ?? '',
    sessionSummary: () => (sessionId) => store()?.getSessionSummary?.(sessionId) ?? null,
    projectService: () => backendService.projectService,
    projectApplicationService: () => backendService.projectApplicationService,
    sendBridgeEvent,
    isRendererAvailable: rendererAvailable,
    log,
  });
  // Row 85 D8: the port behind schedule_list / schedule_change and their card. Scheduled checks are Home
  // reminders, written through the same shell-config path the Home view uses.
  backendService.primarySchedules = createPrimaryScheduleService({
    shellConfigService: configService,
    controls: () => backendService.primaryChatControls,
    featureFlags: () => backendService.featureFlags,
    log,
  });
  // Row 85 D5: the notifier's port; a due Jenny check runs a turn in the Jenny chat.
  wirePrimaryScheduledChecks(backendService, {
    log,
    getReminder: (id) => {
      const reminders = configService()?.getState?.()?.proactive?.reminders;
      return Array.isArray(reminders) ? reminders.find((entry) => entry?.id === id) || null : undefined;
    },
  });
  // Row 86: presence and the "While you were away" digests (desktop only: they need the main window).
  if (typeof getMainWindow === 'function') require('./primary-digest-wiring').attachPrimaryDigests(backendService, { configService, getMainWindow, log });
  return backendService;
}

// Row 88: the settings port behind settings_get / settings_change, their card and Activity's Undo,
// and the appearance relay (D8) that reads and applies the renderer-owned appearance keys. Attached
// with the IPC handlers, where the feature-settings facade and the main window getter exist; the
// caller registers `appearance.respondRelay` with the returned relay.
function attachPrimarySettings(backendService, { configService, applyFeatureSettingsPatch, getMainWindow = () => null, log = () => {} }) {
  const appearanceRelay = createAppearanceRelay({ getWindow: getMainWindow, log });
  backendService.primarySettings = createPrimarySettingsService({
    shellConfigService: configService,
    applyFeatureSettingsPatch: () => applyFeatureSettingsPatch,
    appearanceRelay: () => appearanceRelay,
    controls: () => backendService.primaryChatControls,
    featureFlags: () => backendService.featureFlags,
    primarySessionId: () => backendService.primaryChatControls?.primarySessionId?.() ?? null,
    log,
  });
  return { appearanceRelay };
}

module.exports = { attachPrimaryChat, attachPrimarySettings };
