const { createRejectedEntry } = require('./attachment-service');
const { createEmptyCalendarSnapshot } = require('./calendar-service');
const path = require('path');

const { registerIpcInvokeHandlers } = require('./ipc-contract');
const { registerWorkspaceRecoveryIpcHandlers } = require('./workspace-recovery-ipc-handlers');
const { resolveTimeZone } = require('./proactive/briefing');
const { createUnavailableSetupState } = require('./setup-service');
const {
  assertProactiveReminderIpcPayload,
  normalizeRuntimeToolStatusMap,
} = require('./ipc-validation-helpers');
const { normalizeToolName } = require('./tools/tool-permission-store');
const { readToolResultAttachment } = require('./backend/tool-result-attachments');
const { getWindowStateSnapshot } = require('./window-state-service');
const {
  validateChatStartPayload,
} = require('./backend/generated-chat-lifecycle-contract');
const { CHAT_PROTOCOL_ERROR_CODES, SETUP_ERROR_CODES } = require('./backend/error-codes');
const { loadAccelerationCatalog } = require('./backend/llama-server-acceleration');
const { buildFeatureFlags } = require('./feature-flags');
const { normalizePreferredEngineType } = require('./shell-config-state');
const { defaultOllamaFallbackUrl } = require('./ollama-install-service');
const { CONTEXT_LENGTH_STEPS } = require('./shell-config-compaction-tuning');
const { buildNextTurnContextSummary } = require('./backend/next-turn-context-summary');
const {
  createChatGptAuthServiceDefault,
  ensureChatgptAuthService,
  triggerProviderSidecarReinit,
} = require('./provider-auth-runtime');

const TOOL_RUNTIME_NOT_READY_REASON = 'Managed sidecar is not ready yet.';
const TOOL_STATUS_MISSING_REASON = 'Tool availability has not been reported yet.';
const MAX_INTERACTIVE_USAGE_ROWS = 200;
const MAX_EXPORT_USAGE_ROWS = 500;
const USAGE_EXPORT_SCOPES = new Set(['session', 'today', 'all']);
const IMAGE_DROP_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function cloneJsonSafe(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return fallback;
  }
}

function boundedUsageLimit(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function unavailableUsageExport(scope = '') {
  return {
    ok: false,
    scope,
    rows: [],
    persistence: { available: false, durable: false, read_only_reason: 'unavailable' },
    retention: { max_age_days: 30, max_turns: 500, retained_turns: 0, oldest_at: '' },
    error: 'Usage history is unavailable.',
  };
}

function unavailableUsageSnapshot() {
  return {
    available: false,
    persistence: { available: false, durable: false, read_only_reason: 'unavailable' },
    retention: { max_age_days: 30, max_turns: 500, retained_turns: 0, oldest_at: '' },
    session_id: '',
    today: {},
    session: {},
    cumulative: {},
    recent_turns: [],
    last_record_error: null,
  };
}

function setupUnavailableValidation() {
  return { ok: false, code: 'setup_unavailable', message: 'Setup service is unavailable.' };
}

function setupUnavailablePull() {
  return { requestId: '', model: '', status: 'failed', summary: 'Setup service is unavailable.' };
}

function setupUnavailableCancel(payload = {}) {
  const requestId = String(payload?.requestId || payload?.request_id || '').trim().slice(0, 120);
  return {
    cancelled: false,
    termination_confirmed: false,
    request_id: requestId,
    status: 'unavailable',
    code: 'setup_unavailable',
    error_code: SETUP_ERROR_CODES.TERMINATION_FAILED,
  };
}

function getSetupStatePayload(setupService) {
  if (!setupService) {
    return createUnavailableSetupState();
  }
  if (typeof setupService.refreshReadiness === 'function') {
    return setupService.refreshReadiness();
  }
  return setupService.getState();
}

function codexCliUnavailable() {
  return {
    ok: false,
    status: 'unavailable',
    code: 'codex_cli_unavailable',
    message: 'Codex CLI runtime service is unavailable.',
  };
}

async function companionFollowUpOptions(personalityWorkspace) {
  return {
    timeZone: await resolveTimeZone(personalityWorkspace),
  };
}

function getBackendStatusPhase(backendService) {
  try {
    if (backendService && typeof backendService.getBackendStatus === 'function') {
      return String(backendService.getBackendStatus()?.phase || '').trim().toLowerCase();
    }
    if (
      backendService
      && backendService.sidecarManager
      && typeof backendService.sidecarManager.getStatus === 'function'
    ) {
      return String(backendService.sidecarManager.getStatus()?.phase || '').trim().toLowerCase();
    }
  } catch (_error) {
    return '';
  }
  return '';
}

function unavailableRuntimeStatus(name, runtimeStatus, reason) {
  const status = runtimeStatus && typeof runtimeStatus === 'object' ? runtimeStatus : {};
  return {
    ...status,
    name,
    available: false,
    reason,
  };
}

function getToolListUnavailableReason(backendService, toolsStatus) {
  const phase = getBackendStatusPhase(backendService);
  if (phase && phase !== 'ready') {
    return TOOL_RUNTIME_NOT_READY_REASON;
  }
  if (!Object.keys(toolsStatus).length) {
    return TOOL_STATUS_MISSING_REASON;
  }
  return '';
}

function normalizeToolListEntry(tool, runtimeStatus) {
  const name = String(tool?.name || runtimeStatus?.name || '').trim();
  if (!name) {
    return null;
  }
  const status = runtimeStatus && typeof runtimeStatus === 'object' ? runtimeStatus : null;
  return {
    name,
    description: String(tool?.description || '').trim(),
    readOnly: tool?.readOnly === true,
    category: String(tool?.category || status?.toolFamily || 'builtin').trim() || 'builtin',
    available: status ? status.available === true : true,
    reason: status && typeof status.reason === 'string' ? status.reason : '',
  };
}

// Live-push a permission-store change into the running sidecar config (same
// path the approval card's "Always allow" checkbox uses).
function pushToolPermissionUpdate(backendService) {
  if (backendService && typeof backendService.refreshManagedConfig === 'function') {
    Promise.resolve(backendService.refreshManagedConfig('tool_permission_updated')).catch(
      () => null
    );
  }
}

function assertChatStartIpcPayload(payload, { requireEditedMessageId = false, log = null } = {}) {
  const result = validateChatStartPayload(payload, { requireEditedMessageId });
  if (result.ok) return result.value;
  const details = result.error || {};
  if (typeof log === 'function') {
    log('WARN', 'chat.ipc_payload_rejected', {
      code: details.code,
      path: details.path,
      reason: details.reason,
      byteCount: details.byte_count,
    });
  }
  const error = new TypeError(
    `Invalid chat IPC payload: ${String(details.reason || 'invalid_payload')} at ${String(details.path || '$')}`
  );
  error.code = details.code || CHAT_PROTOCOL_ERROR_CODES.INVALID_PAYLOAD;
  error.path = details.path || '$';
  error.reason = details.reason || 'invalid_payload';
  throw error;
}

function registerAuxiliaryIpcHandlers({
  ipcMainLike,
  personalityWorkspace,
  artifactService,
  backendService,
  getProactiveStatePayload,
  shellConfigService,
  companionService,
  suggestionCache,
  getCachedOrGenerateSuggestions,
  generateCommitMessage,
  generateInlineCompletion,
  listLoadedInlineModels,
  unloadInlineModel,
  offlineIntelligenceService,
  modelTuningService = null,
  engineTuningService = null,
  dialog,
  getMainWindow,
  workspaceRootCoordinator = null,
  ipcAuthorization = {},
  prepareAttachmentEntries,
  attachmentAssetStore,
  processRef,
  os,
  isChildPath,
  clipboard,
  log,
  getMainLifecycle,
  toolExecutor,
  toolPermissionStore,
  usageHistory,
  setupService,
  ollamaInstallService,
  mcpDiscoveryService,
  schedulerService,
  weatherService,
  linkStatusService,
  calendarService,
  homeAssistantService,
  chatStreamBridge,
  getWindowState,
  windowExitGuard = null,
  createAuthService = createChatGptAuthServiceDefault,
} = {}) {
  const getWindowStatePayload = () => {
    if (typeof getWindowState === 'function') {
      return getWindowState();
    }
    return getWindowStateSnapshot(typeof getMainWindow === 'function' ? getMainWindow() : null);
  };
  const emitTuningIpcFailure = (event, reason) => {
    try {
      log?.('WARN', event, { reason });
    } catch (_error) {
      // IPC fallback shapes must not depend on diagnostics availability.
    }
  };
  const getFallbackModelTuningState = () => {
    try {
      return shellConfigService?.getModelTuning?.() || {};
    } catch (_error) {
      emitTuningIpcFailure('model_tuning.ipc_failed', 'config_read_failed');
      return {};
    }
  };
  const getFallbackCompactionTuningState = () => {
    try {
      return {
        ...(shellConfigService?.getCompactionTuning?.() || {}),
        contextLengthSteps: CONTEXT_LENGTH_STEPS,
      };
    } catch (_error) {
      emitTuningIpcFailure('model_tuning.ipc_failed', 'config_read_failed');
      return { ratioByModel: {}, contextLengthByModel: {}, customPrompt: '', contextLengthSteps: CONTEXT_LENGTH_STEPS };
    }
  };
  // ONE bridge shape for every tuning service (model, compaction, engine): never
  // throw across the bridge, and always answer with the same {status, reason,
  // state} contract the renderer branches on - a bare rejection would leave the
  // field spinning. `fallbackState` may be overridden per call because the
  // compaction channel rides on the model-tuning service with its own state shape.
  const createTuningIpcBridge = ({ service, eventPrefix, fallbackState }) => {
    const readState = () => {
      try {
        return service?.getState?.() || fallbackState();
      } catch (_error) {
        emitTuningIpcFailure(`${eventPrefix}.ipc_failed`, 'service_read_failed');
        return fallbackState();
      }
    };
    const call = async (method, payload, fallbackStateOverride = fallbackState) => {
      if (!service?.[method]) {
        return {
          status: 'rejected',
          reason: `${eventPrefix}_service_unavailable`,
          state: fallbackStateOverride(),
        };
      }
      try {
        const result = await service[method](payload);
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          emitTuningIpcFailure(`${eventPrefix}.ipc_failed`, 'malformed_service_result');
          return { status: 'rejected', reason: 'malformed_service_result', state: fallbackStateOverride() };
        }
        return result;
      } catch (_error) {
        emitTuningIpcFailure(`${eventPrefix}.ipc_failed`, `service_${method}_failed`);
        return { status: 'rejected', reason: 'request_failed', state: fallbackStateOverride() };
      }
    };
    return { readState, call };
  };
  const modelTuningBridge = createTuningIpcBridge({
    service: modelTuningService,
    eventPrefix: 'model_tuning',
    fallbackState: getFallbackModelTuningState,
  });
  const engineTuningBridge = createTuningIpcBridge({
    service: engineTuningService,
    eventPrefix: 'engine_tuning',
    fallbackState: () => ({ values: {}, fields: [], groups: [], pending: false, activeStream: false }),
  });
  ensureChatgptAuthService({ backendService, log, createAuthService });
  registerIpcInvokeHandlers(ipcMainLike, {
    'artifacts.read': (_, sessionId, artifactId) =>
      artifactService.readArtifact(sessionId, artifactId),
    'artifacts.save': (_, sessionId, artifactId, content) =>
      artifactService.saveArtifact(sessionId, artifactId, content),
    'artifacts.reveal': (_, sessionId, artifactId) =>
      artifactService.revealArtifact(sessionId, artifactId),
    'artifacts.openExternal': (_, sessionId, artifactId) =>
      artifactService.openArtifactExternal(sessionId, artifactId),
    'artifacts.delete': (_, sessionId, artifactId) =>
      artifactService.deleteArtifact(sessionId, artifactId),
    'artifacts.deleteSession': (_, sessionId) =>
      artifactService.deleteSessionArtifacts(sessionId),
    'memory.suggestForSession': (_, sessionId) =>
      backendService.suggestMemoriesForSession(sessionId),
    'memory.status': () => backendService.getMemoryStatus(),
    'memory.save': (_, sessionId, candidate) =>
      backendService.saveMemoryForSession(sessionId, candidate),
    'memory.listApproved': () => backendService.listApprovedMemories(),
    'memory.listPending': () => backendService.listPendingMemories(),
    'memory.update': (_, memoryId, patch) =>
      backendService.updateApprovedMemory(memoryId, patch),
    'memory.delete': (_, memoryId) => backendService.deleteApprovedMemory(memoryId),
    'memory.deletePending': (_, sessionId, contentFingerprint) =>
      backendService.deletePendingMemory(sessionId, contentFingerprint),
    'memory.dismiss': (_, fingerprint) => backendService.dismissMemorySuggestion(fingerprint),
    'harness.inspect': (_, options) => backendService.inspectHarness(options),
    'diagnostics.getJennyStatus': (_, options) => backendService.getJennyStatus(options),
    'diagnostics.phasePercentiles.get': () => backendService.getPhasePercentilesSnapshot(),
    'diagnostics.phasePercentiles.reset': () => backendService.resetPhasePercentiles(),
    'codexCli.getState': () =>
      backendService?.getCodexCliState?.() || codexCliUnavailable(),
    'codexCli.openLoginTerminal': () =>
      backendService?.openCodexCliLoginTerminal?.() || codexCliUnavailable(),
    'codexCli.refresh': () =>
      backendService?.refreshCodexCliState?.() || codexCliUnavailable(),
    'setup.getState': () => getSetupStatePayload(setupService),
    'setup.updateState': (_, patch) =>
      setupService ? setupService.updateState(patch) : createUnavailableSetupState(),
    'setup.complete': () =>
      setupService ? setupService.complete() : createUnavailableSetupState(),
    'setup.reset': () =>
      setupService ? setupService.reset() : createUnavailableSetupState(),
    'setup.factoryReset': () =>
      setupService ? setupService.factoryReset() : createUnavailableSetupState(),
    'setup.validateEndpoint': (_, payload) =>
      setupService
        ? setupService.validateEndpoint(payload)
        : setupUnavailableValidation(),
    'setup.saveEndpoint': (_, payload) =>
      setupService && typeof setupService.saveEndpoint === 'function'
        ? setupService.saveEndpoint(payload)
        : {
            ...createUnavailableSetupState(),
            endpoint_result: {
              ok: false,
              code: 'setup_unavailable',
              error_code: SETUP_ERROR_CODES.ENDPOINT_INVALID,
              message: 'Setup is unavailable.',
              retryable: true,
            },
          },
    'setup.startOllamaPull': (_, payload) =>
      setupService
        ? setupService.startOllamaPullPublic(payload)
        : setupUnavailablePull(),
    'setup.cancelOllamaPull': (_, payload) =>
      setupService
        ? setupService.cancelOllamaPull(payload)
        : setupUnavailableCancel(payload),
    'setup.detectOllama': (_, payload) =>
      setupService
        ? setupService.detectOllama(payload)
        : { installed: false, running: false, version: '', installPath: '', source: 'none' },
    'setup.getOllamaInstallPlan': () =>
      ollamaInstallService
        ? ollamaInstallService.getInstallPlan()
        : { available: false, url: '', version: '', sizeBytes: 0, sha256: '', license: '', manualFallbackUrl: defaultOllamaFallbackUrl(process.platform) },
    'setup.installOllama': (_, payload) =>
      ollamaInstallService
        ? ollamaInstallService.installOllama(payload)
        : { status: 'failed', code: 'unavailable', manualFallbackUrl: defaultOllamaFallbackUrl(process.platform) },
    'setup.cancelOllamaInstall': (_, payload) =>
      ollamaInstallService
        ? ollamaInstallService.cancelOllamaInstall(payload)
        : setupUnavailableCancel(payload),
    'mcpDiscovery.getState': () =>
      mcpDiscoveryService ? mcpDiscoveryService.getState() : { servers: [], readOnly: true },
    'mcpDiscovery.refresh': () =>
      mcpDiscoveryService ? mcpDiscoveryService.refresh() : { servers: [], readOnly: true },
    'mcpDiscovery.createServer': (_, payload) =>
      mcpDiscoveryService ? mcpDiscoveryService.createServer(payload) : { ok: false, error: { code: 'unavailable' } },
    'mcpDiscovery.updateServer': (_, payload) =>
      mcpDiscoveryService ? mcpDiscoveryService.updateServer(payload) : { ok: false, error: { code: 'unavailable' } },
    'mcpDiscovery.removeServer': (_, payload) =>
      mcpDiscoveryService ? mcpDiscoveryService.removeServer(payload) : { ok: false, error: { code: 'unavailable' } },
    'mcpDiscovery.testServer': (_, payload) =>
      mcpDiscoveryService ? mcpDiscoveryService.testServer(payload) : { ok: false, error: { code: 'unavailable' } },
    'mcpDiscovery.approveServer': (_, payload) =>
      mcpDiscoveryService ? mcpDiscoveryService.approveServer(payload) : { ok: false, error: { code: 'unavailable' } },
    'mcpDiscovery.setServerEnabled': (_, payload) =>
      mcpDiscoveryService ? mcpDiscoveryService.setServerEnabled(payload) : { ok: false, error: { code: 'unavailable' } },
    // mcpAuth.* — SECURITY: these handlers must never surface a decrypted
    // secret to the renderer (see services/mcp-discovery-service.js).
    'mcpAuth.getStatus': () =>
      mcpDiscoveryService
        ? mcpDiscoveryService.getMcpAuthStatus()
        : { loaded: false, store: { status: 'unavailable', recoveryTitle: '', recoveryHint: '' }, servers: [] },
    'mcpAuth.set': (_, payload) =>
      mcpDiscoveryService
        ? mcpDiscoveryService.setMcpAuthToken(payload)
        : { ok: false, error: { code: 'unavailable', message: 'MCP auth is unavailable.' } },
    'mcpAuth.delete': (_, payload) =>
      mcpDiscoveryService
        ? mcpDiscoveryService.deleteMcpAuthToken(payload)
        : { ok: false, error: { code: 'unavailable', message: 'MCP auth is unavailable.' } },
    'scheduler.getState': () =>
      schedulerService && typeof schedulerService.getStateSnapshot === 'function'
        ? schedulerService.getStateSnapshot()
        : { upcoming: [], running: [], generatedAt: '', relevant: false, lifecycle: { phase: 'unavailable', relevant: false, qualifyingTaskCount: 0, reason: 'service_unavailable', error: '', updatedAt: '' } },
    'home.getConfig': () => shellConfigService.getHomeConfig(),
    'home.updateConfig': (_, patch) => shellConfigService.updateHomeConfig(patch),
    // Attribution/undo journal for assistant-made Home changes. All decision
    // logic (supersede, ring cap, the three undo refusals) lives in
    // HomeAssistantService; these two handlers only marshal.
    'home.getAiJournal': () =>
      homeAssistantService && typeof homeAssistantService.listJournal === 'function'
        ? homeAssistantService.listJournal()
        : { entries: [] },
    'home.undoAiEntry': (_, entryId) =>
      homeAssistantService && typeof homeAssistantService.undo === 'function'
        ? homeAssistantService.undo(entryId)
        : { ok: false, reason: 'unavailable' },
    'weather.getState': () =>
      weatherService && typeof weatherService.getState === 'function'
        ? weatherService.getState()
        : { available: false, configured: false, error: 'unavailable' },
    'linkStatus.getState': () =>
      linkStatusService && typeof linkStatusService.getState === 'function'
        ? linkStatusService.getState()
        : { byTileId: {} },
    'calendar.getState': () =>
      calendarService && typeof calendarService.getState === 'function'
        ? calendarService.getState()
        : createEmptyCalendarSnapshot(),
    'calendar.createEvent': (_, payload) =>
      calendarService && typeof calendarService.createEvent === 'function'
        ? calendarService.createEvent(payload)
        : createEmptyCalendarSnapshot(),
    'calendar.updateEvent': (_, id, patch) =>
      calendarService && typeof calendarService.updateEvent === 'function'
        ? calendarService.updateEvent(id, patch)
        : createEmptyCalendarSnapshot(),
    'calendar.deleteEvent': (_, id) =>
      calendarService && typeof calendarService.deleteEvent === 'function'
        ? calendarService.deleteEvent(id)
        : createEmptyCalendarSnapshot(),
    'proactive.getState': () => getProactiveStatePayload(),
    'companion.getState': () => companionService.getState(),
    'companion.setMode': (_, mode) => companionService.setMode(mode),
    'companion.addFollowUp': async (_, payload) => {
      shellConfigService.upsertFollowUp(payload, await companionFollowUpOptions(personalityWorkspace));
      return companionService.getState();
    },
    'companion.updateFollowUp': async (_, id, patch) => {
      shellConfigService.updateFollowUp(id, patch, await companionFollowUpOptions(personalityWorkspace));
      return companionService.getState();
    },
    'companion.deferFollowUp': async (_, id, preset) => {
      shellConfigService.deferFollowUp(id, preset, await companionFollowUpOptions(personalityWorkspace));
      return companionService.getState();
    },
    'companion.activateFollowUp': (_, id) => {
      shellConfigService.activateFollowUp(id);
      return companionService.getState();
    },
    'companion.resolveFollowUp': (_, id) => {
      shellConfigService.resolveFollowUp(id);
      return companionService.getState();
    },
    'companion.archiveFollowUp': (_, id) => {
      shellConfigService.archiveFollowUp(id);
      return companionService.getState();
    },
    'companion.unarchiveFollowUp': (_, id) => {
      shellConfigService.unarchiveFollowUp(id);
      return companionService.getState();
    },
    'companion.deleteFollowUp': (_, id) => {
      shellConfigService.deleteFollowUp(id);
      return companionService.getState();
    },
    'suggestions.generate': async () => {
      try {
        const companionState = await companionService.getState();
        return getCachedOrGenerateSuggestions(backendService, companionState, suggestionCache);
      } catch (_error) {
        return { suggestions: [] };
      }
    },
    // One-shot, off-transcript local-model commit-message generation from the
    // staged diff (Source Control panel "Write message"). The diff stays on the
    // machine and never enters the chat transcript; failures degrade to a
    // structured { ok:false } shape rather than throwing.
    'commit.generateMessage': async (_, payload) => {
      try {
        return await generateCommitMessage(backendService, payload || {});
      } catch (_error) {
        return { ok: false, reason: 'generate_failed' };
      }
    },
    // One-shot, off-transcript fill-in-the-middle code completion for the editor
    // cursor (inline ghost text). The file content stays on the machine
    // and never enters the chat transcript; every failure degrades to a
    // structured { ok:false } shape (the renderer shows no suggestion).
    'inline.complete': async (_, payload) => {
      try {
        return await generateInlineCompletion(backendService, payload || {});
      } catch (_error) {
        return { ok: false, reason: 'generate_failed' };
      }
    },
    // Which Ollama models are currently loaded in the daemon (for the IDE
    // completion menu's live loaded/unloaded indicator). Degrades to empty.
    'inline.loadedModels': async () => {
      try {
        return await listLoadedInlineModels(backendService);
      } catch (_error) {
        return { ok: false, loaded: [], reason: 'query_failed' };
      }
    },
    // Evict a specific FIM completion model from the Ollama daemon by tag.
    'inline.unloadModel': async (_, payload) => {
      try {
        return await unloadInlineModel(backendService, payload || {});
      } catch (_error) {
        return { ok: false, reason: 'unload_failed' };
      }
    },
    'offline.getState': () => offlineIntelligenceService.getState(),
    // Bounded engine-settings snapshot for the Settings → Offline engines panel;
    // reads shell config only (no secrets — tokens stay in SecureStore).
    'engines.getSettings': () => {
      const flags = buildFeatureFlags(processRef?.env || process.env,
        shellConfigService?.getState?.()?.featureOverrides || {});
      // Anchor the catalog to the services/ parent, not cwd — a packaged app
      // launches with an arbitrary working directory.
      const catalog = flags.llama_server_acceleration === true
        ? loadAccelerationCatalog({ repoRoot: path.join(__dirname, '..') }).catalog : null;
      const accelerationCatalog = catalog && {
        defaults: { vramHeadroomMb: catalog.defaults.vramHeadroomMb },
        families: catalog.families.map(({ family, matchPrefixes, mtp, vramHeadroomMb }) => ({
          family,
          matchPrefixes,
          mtp,
          ...(Number.isFinite(vramHeadroomMb) && vramHeadroomMb >= 0 ? { vramHeadroomMb } : {}),
        })),
      };
      return {
        localEngines: shellConfigService?.getLocalEngines?.() || null,
        preferredEngineType: String(shellConfigService?.getState?.()?.preferredEngineType || ''),
        ...(flags.llama_server_acceleration === true ? { accelerationCatalog } : {}),
      };
    },
    'engines.updateSettings': (_, payload) => {
      const currentSettings = () => ({
        localEngines: shellConfigService?.getLocalEngines?.() || null,
        preferredEngineType: String(shellConfigService?.getState?.()?.preferredEngineType || ''),
      });
      if (Object.prototype.hasOwnProperty.call(payload || {}, 'preferredEngineType')) {
        const requested = String(payload.preferredEngineType || '').trim().toLowerCase();
        const preferredEngineType = normalizePreferredEngineType(requested);
        if (preferredEngineType === requested) {
          shellConfigService?.updatePreferredEngineType?.(preferredEngineType);
          if (preferredEngineType === 'chatgpt') {
            triggerProviderSidecarReinit(backendService, shellConfigService, log, 'engine_switched');
          }
        }
      }
      const hasAcceleration = Object.prototype.hasOwnProperty.call(payload || {}, 'acceleration');
      const hasManaged = Object.prototype.hasOwnProperty.call(payload || {}, 'managed');
      const keys = hasManaged ? Object.keys(payload.managed?.perModel || {})
        .filter((key) => typeof key === 'string').map((key) => key.slice(0, 128)).slice(0, 64).sort() : [];
      const roots = hasManaged && Array.isArray(payload.managed?.libraryRoots)
        ? payload.managed.libraryRoots.length : 0;
      if (hasAcceleration || hasManaged) {
        const flags = buildFeatureFlags(
          processRef?.env || process.env,
          shellConfigService?.getState?.()?.featureOverrides || {}
        );
        if (flags.llama_server_acceleration === true) {
          if (hasAcceleration) {
            shellConfigService?.updateLocalEngineAcceleration?.(payload.acceleration);
          }
          if (hasManaged) {
            shellConfigService?.updateManagedLlamaServer?.(payload.managed);
            log?.('INFO', 'engines.managed_updated', { keys, roots });
          }
        } else if (hasManaged) {
          log?.('WARN', 'engines.managed_dropped_flag_off', { keys, roots });
        }
      }
      return currentSettings();
    },
    'offline.getDiagnostics': () => offlineIntelligenceService.getDiagnostics(),
    'offline.updateSettings': (_, patch) => offlineIntelligenceService.updateSettings(patch),
    'chatUi.getState': () => shellConfigService.getChatUiState(),
    'chatUi.updateSettings': (_, patch) => {
      shellConfigService.updateChatUiSettings(patch);
      return shellConfigService.getChatUiState();
    },
    'windowUi.getState': () => shellConfigService.getWindowUiState(),
    'windowUi.updateSettings': (event, patch) => {
      const nextWindowUi = shellConfigService.updateWindowUiSettings(patch);
      // Apply the overall app zoom live to the requesting renderer's frame.
      // Startup application is handled at window creation via webPreferences.
      try {
        const factor = (Number(nextWindowUi?.appZoomPercent) || 100) / 100;
        const sender = event && event.sender;
        if (sender && typeof sender.setZoomFactor === 'function') {
          sender.setZoomFactor(factor);
        }
      } catch (_error) {
        // setZoomFactor throws if the frame is gone; the persisted value still
        // applies on next launch, so ignore.
      }
      return shellConfigService.getWindowUiState();
    },
    'modelTuning.getState': () => modelTuningBridge.readState(),
    'modelTuning.update': (_, payload) => modelTuningBridge.call('update', payload),
    'engineTuning.getState': () => engineTuningBridge.readState(),
    'engineTuning.update': (_, payload) => engineTuningBridge.call('update', payload),
    'engineTuning.reset': (_, payload) => engineTuningBridge.call('reset', payload),
    'compaction.getTuning': () => getFallbackCompactionTuningState(),
    'compaction.setTuning': (_, payload = {}) => (
      modelTuningBridge.call('update', payload, getFallbackCompactionTuningState)
    ),
    'chat.getNextTurnContextSummary': (_, sessionId, draftMetadata = {}) => (
      buildNextTurnContextSummary(backendService?.sessionStore, sessionId, draftMetadata)
    ),
    'proactive.chooseWorkspaceRoot': async () => {
      const prepared = typeof workspaceRootCoordinator?.prepareChoose === 'function'
        ? await workspaceRootCoordinator.prepareChoose()
        : {
            prepared: false,
            changed: false,
            canceled: false,
            blocked: true,
            code: 'workspace_root_coordinator_unavailable',
          };
      return { ...getProactiveStatePayload(), ...prepared };
    },
    'proactive.clearWorkspaceRoot': async () => {
      const prepared = typeof workspaceRootCoordinator?.prepareClear === 'function'
        ? await workspaceRootCoordinator.prepareClear()
        : {
            prepared: false,
            changed: false,
            canceled: false,
            blocked: true,
            code: 'workspace_root_coordinator_unavailable',
          };
      return { ...getProactiveStatePayload(), ...prepared };
    },
    'proactive.upsertReminder': (_, reminder) => {
      assertProactiveReminderIpcPayload(shellConfigService, reminder);
      shellConfigService.upsertReminder(reminder);
      return getProactiveStatePayload();
    },
    'proactive.deleteReminder': (_, reminderId) => {
      shellConfigService.deleteReminder(reminderId);
      return getProactiveStatePayload();
    },
    'chat.startStream': (_, payload) => backendService.startChatStream(
      assertChatStartIpcPayload(payload, { log })
    ),
    'chat.editAndRegenerate': (_, payload) => backendService.editAndRegenerate(
      assertChatStartIpcPayload(payload, { requireEditedMessageId: true, log })
    ),
    'chat.retryUnsavedReply': (_, payload) => backendService.retryUnsavedReply(payload),
    'chat.discardUnsavedReply': (_, payload) => backendService.discardUnsavedReply(payload),
    'chat.getActiveTurnState': (_, sessionId) => backendService.getActiveTurnState(sessionId),
    'chat.cancelStream': (_, streamId, options = {}) => backendService.cancelChatStream(
      streamId,
      options && typeof options === 'object'
        ? (options.cancel_reason || options.cancelReason || options.reason)
        : ''
    ),
    'chat.compactNow': (_, sessionId) => backendService.compactContextNow(sessionId),
    'chat.ackEnvelopeReceipt': (_, record) => {
      if (chatStreamBridge && typeof chatStreamBridge.recordEnvelopeAck === 'function') {
        return chatStreamBridge.recordEnvelopeAck(record);
      }
      return {
        ok: false,
        reason: 'stream_envelope_gate_unavailable',
        legacy_reopened: true,
        rehydrate_required: true,
      };
    },
    'attachments.pick': async () => {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Select attachments',
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: 'Supported attachments',
            extensions: [
              'txt', 'md', 'markdown', 'js', 'cjs', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'css', 'html',
              'htm', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'py', 'rb', 'go', 'rs', 'java', 'kt',
              'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php', 'sh', 'ps1', 'sql', 'csv', 'log',
              'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
            ],
          },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (result.canceled) {
        return { accepted: [], rejected: [] };
      }
      return prepareAttachmentEntries(result.filePaths, {
        cwd: processRef.cwd(),
        assetStore: attachmentAssetStore,
      });
    },
    'attachments.prepare': (_, filePaths) => {
      const allowedRoots = [];
      const workspaceRoot = shellConfigService.getState().toolsWorkspaceRoot;
      if (workspaceRoot) {
        allowedRoots.push(workspaceRoot);
      }
      const safePaths = [];
      const rejectedOutsideRoots = [];
      for (const filePath of Array.isArray(filePaths) ? filePaths : []) {
        if (
          IMAGE_DROP_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase())
          || allowedRoots.some((root) => isChildPath(root, filePath))
        ) {
          safePaths.push(filePath);
          continue;
        }
        // Filtered paths must still produce a rejected entry: dropping them
        // silently makes the whole drag-drop surface look like a no-op.
        rejectedOutsideRoots.push(createRejectedEntry(
          filePath,
          workspaceRoot
            ? 'File is outside the tools workspace root, so it cannot be attached.'
            : 'Set a tools workspace root in Settings before attaching dropped files.'
        ));
      }
      const prepared = prepareAttachmentEntries(safePaths, {
        cwd: processRef.cwd(),
        assetStore: attachmentAssetStore,
      });
      return {
        ...prepared,
        rejected: [...rejectedOutsideRoots, ...(prepared.rejected || [])],
      };
    },
    'attachments.saveImageAsset': (_, payload) => {
      const byteLength = payload?.bytes?.byteLength ?? payload?.bytes?.length ?? null;
      const bytesKind = payload?.bytes == null ? 'missing' : (Buffer.isBuffer(payload.bytes) ? 'buffer' : (ArrayBuffer.isView(payload.bytes) ? 'view' : (payload.bytes instanceof ArrayBuffer ? 'arraybuffer' : (Array.isArray(payload.bytes) ? 'array' : typeof payload.bytes))));
      if (!attachmentAssetStore) {
        if (typeof log === 'function') { log('WARN', 'attachments.save_image_asset', { ok: false, reason: 'store_unavailable', bytesKind, byteLength, mimeType: payload?.mimeType || '', sourceKind: payload?.sourceKind || '' }); }
        throw new Error('Image attachments are unavailable.');
      }
      try {
        const result = attachmentAssetStore.saveImageBuffer(payload?.bytes, {
          mimeType: payload?.mimeType, displayName: payload?.displayName,
          sourceKind: payload?.sourceKind, captureMeta: payload?.captureMeta,
        });
        if (typeof log === 'function') { log('INFO', 'attachments.save_image_asset', { ok: true, bytesKind, byteLength, mimeType: payload?.mimeType || '', sourceKind: payload?.sourceKind || '', id: result?.id || '' }); }
        return result;
      } catch (error) {
        if (typeof log === 'function') { log('WARN', 'attachments.save_image_asset', { ok: false, bytesKind, byteLength, mimeType: payload?.mimeType || '', sourceKind: payload?.sourceKind || '', message: error?.message || String(error) }); }
        throw error;
      }
    },
    'attachments.saveAudioAsset': (_, payload) => {
      if (!attachmentAssetStore) {
        throw new Error('Audio attachments are unavailable.');
      }
      return attachmentAssetStore.saveAudioBuffer(payload?.bytes, {
        mimeType: payload?.mimeType,
        displayName: payload?.displayName,
        sourceKind: payload?.sourceKind,
        durationMs: payload?.durationMs,
        transcriptText: payload?.transcriptText,
        transcriptStatus: payload?.transcriptStatus,
        transcriptLanguage: payload?.transcriptLanguage,
      });
    },
    'attachments.releaseAssets': (_, assetPaths) => {
      if (!attachmentAssetStore) {
        return { deletedCount: 0, deletedPaths: [] };
      }
      return attachmentAssetStore.deleteAssets(assetPaths);
    },
    // Bounded ID-based read of a tool-result attachment previously
    // ingested into the managed asset store from a live sidecar tool.result.
    'attachments.readToolResultAsset': (_, attachmentId) => {
      if (!backendService) {
        return { ok: false, reason: 'backend service unavailable' };
      }
      return readToolResultAttachment(backendService, attachmentId);
    },
    'clipboard.writeText': (_, text) => {
      clipboard.writeText(String(text || ''));
      return { ok: true };
    },
    'window.getState': () => getWindowStatePayload(),
    // Renderer→main reply to a native-close dirty preflight. Resolves
    // the exit guard's pending entry (proceed:true closes; proceed:false keeps
    // the window). Fail-soft when no guard is wired.
    'window.respondExitPreflight': (_, payload) => {
      if (windowExitGuard && typeof windowExitGuard.resolvePreflight === 'function') {
        return windowExitGuard.resolvePreflight(payload);
      }
      return { ok: false, code: 'guard_unavailable' };
    },
    windowControl: (_, action) => {
      log('DEBUG', 'window.control', { action });
      const mainWindow = getMainWindow();
      if (!mainWindow) {
        return { ok: false, maximized: false, minimized: false };
      }
      if (action === 'minimize') {
        mainWindow.minimize();
      }
      if (action === 'maximize') {
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize();
        } else {
          mainWindow.maximize();
        }
      }
      if (action === 'close' && !mainWindow.isDestroyed()) {
        // The renderer already ran the dirty preflight before invoking, so tell
        // the native-close guard to bypass its interceptor (else it would
        // re-prompt). authorizeNextClose() MUST run before close() fires the
        // 'close' event — and only when close() will actually fire one: a
        // destroyed window would leave the one-shot bypass latched, silently
        // authorizing the NEXT genuine native close to skip the dirty prompt.
        if (windowExitGuard && typeof windowExitGuard.authorizeNextClose === 'function') {
          windowExitGuard.authorizeNextClose();
        }
        mainWindow.close();
      }
      if (action === 'reload') {
        const mainLifecycle = getMainLifecycle();
        if (mainLifecycle && mainLifecycle.isAppQuitting()) {
          return { ok: false, maximized: false, minimized: false };
        }
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.reloadIgnoringCache();
        }
      }
      if (action === 'toggle-devtools' && !mainWindow.isDestroyed()) {
        mainWindow.webContents.toggleDevTools();
      }
      return getWindowStatePayload();
    },
    'tools.list': () => {
      const toolsStatus = normalizeRuntimeToolStatusMap(
        backendService && backendService.currentStatus
          ? backendService.currentStatus.tools_status
          : null
      );
      const unavailableReason = getToolListUnavailableReason(backendService, toolsStatus);
      const registeredStatusKeys = new Set();
      const registryTools = toolExecutor && toolExecutor.registry
        && typeof toolExecutor.registry.getAllTools === 'function'
        ? toolExecutor.registry.getAllTools()
        : [];
      const entries = [];
      for (const tool of registryTools) {
        const statusKey = normalizeToolName(tool.name);
        registeredStatusKeys.add(statusKey);
        const runtimeStatus = unavailableReason
          ? unavailableRuntimeStatus(statusKey, toolsStatus[statusKey], unavailableReason)
          : toolsStatus[statusKey];
        const entry = normalizeToolListEntry(tool, runtimeStatus);
        if (entry) {
          entries.push(entry);
        }
      }
      for (const [name, status] of Object.entries(toolsStatus)) {
        if (registeredStatusKeys.has(name)) {
          continue;
        }
        const runtimeStatus = unavailableReason
          ? unavailableRuntimeStatus(name, status, unavailableReason)
          : { ...status, name };
        const entry = normalizeToolListEntry({ name }, runtimeStatus);
        if (entry) {
          entries.push(entry);
        }
      }
      return entries;
    },
    'tools.approve': (_, callId, options) => {
      const approvedByBackend = backendService && backendService.approveToolCall(callId, options);
      if (approvedByBackend) {
        return true;
      }
      return toolExecutor.approve(callId, options);
    },
    'tools.deny': (_, callId) => {
      const deniedByBackend = backendService && backendService.denyToolCall(callId);
      if (deniedByBackend) {
        return true;
      }
      return toolExecutor.deny(callId);
    },
    'tools.getPermissions': () => ({
      policies: toolPermissionStore.getAllPolicies(),
      // saved = the user's own decisions (Settings > Tools > Approval rules).
      saved: toolPermissionStore.listStoredDecisions(),
      blanket_auto_approve_retired: toolPermissionStore.consumeBlanketRuleRetiredNotice(),
    }),
    'tools.setPermission': (_, name, policy) => {
      toolPermissionStore.setPolicy(name, policy);
      pushToolPermissionUpdate(backendService);
    },
    'tools.clearPermission': (_, name) => {
      const result = toolPermissionStore.clearPolicy(name);
      pushToolPermissionUpdate(backendService);
      return result;
    },
    'tools.removePermissionRule': (_, ruleId) => {
      const result = toolPermissionStore.removeRule(ruleId);
      pushToolPermissionUpdate(backendService);
      return result;
    },
    'usage.getSnapshot': (_, payload = {}) => {
      const request = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload
        : {};
      const mode = String(request.mode || 'interactive').trim().toLowerCase();
      const sessionId = String(request.sessionId || '').trim();
      if (mode === 'export') {
        const scope = String(request.scope || '').trim().toLowerCase();
        if (!USAGE_EXPORT_SCOPES.has(scope)) {
          return unavailableUsageExport(scope || 'invalid');
        }
        const result = usageHistory?.getExportRows?.({
          sessionId,
          scope,
          limit: MAX_EXPORT_USAGE_ROWS,
        }) || unavailableUsageExport(scope);
        return cloneJsonSafe(result, unavailableUsageExport(scope));
      }
      if (mode !== 'interactive') {
        return cloneJsonSafe(unavailableUsageExport('invalid'), unavailableUsageExport('invalid'));
      }
      const result = usageHistory?.getSnapshot?.({
        sessionId,
        limit: boundedUsageLimit(request.limit, MAX_INTERACTIVE_USAGE_ROWS, MAX_INTERACTIVE_USAGE_ROWS),
      }) || unavailableUsageSnapshot();
      return cloneJsonSafe(result, unavailableUsageSnapshot());
    },
    'usage.clearHistory': () => usageHistory?.clearHistory?.() || ({
      ok: false,
      cleared_turn_count: 0,
      durable: false,
      error: 'Usage history is unavailable.',
    }),
  }, ipcAuthorization);

  registerWorkspaceRecoveryIpcHandlers({ ipcMainLike, backendService, ipcAuthorization });
}

module.exports = {
  assertChatStartIpcPayload,
  normalizeRuntimeToolStatusMap,
  normalizeToolListEntry,
  registerAuxiliaryIpcHandlers,
};
