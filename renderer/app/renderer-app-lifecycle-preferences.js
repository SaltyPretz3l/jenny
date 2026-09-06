(function initRendererAppLifecyclePreferences(root) {
  'use strict';

  const CHAT_SEND_LIFECYCLE = Object.freeze({
    IDLE: 'idle',
    PREFLIGHT: 'preflight',
    STREAMING: 'streaming',
    SETTLING: 'settling',
    FAILED: 'failed',
  });
  const MAX_REASONING_EXPANSION_SESSIONS = 128;
  const MAX_REASONING_EXPANSIONS_PER_SESSION = 512;
  const MAX_CHAT_TIMELINE_SIGNAL_KEYS_PER_SESSION = 512;

  function evictOldestMapEntries(map, limit) {
    if (!(map instanceof Map)) return;
    while (map.size > limit) {
      const oldestKey = map.keys().next().value;
      if (oldestKey === undefined) break;
      map.delete(oldestKey);
    }
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function createChatSendLifecycleController({ state }) {
    function getStore() {
      const lifecycleStore = state.ui?.chatSendLifecycleBySession;
      return lifecycleStore && typeof lifecycleStore.get === 'function' ? lifecycleStore : null;
    }

    function normalize(value) {
      const token = String(value || '').trim().toLowerCase();
      return Object.values(CHAT_SEND_LIFECYCLE).includes(token) ? token : CHAT_SEND_LIFECYCLE.IDLE;
    }

    function get(sessionId = state.currentSessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return CHAT_SEND_LIFECYCLE.IDLE;
      }
      const lifecycleStore = getStore();
      if (!lifecycleStore) {
        return CHAT_SEND_LIFECYCLE.IDLE;
      }
      return normalize(lifecycleStore.get(normalizedSessionId));
    }

    function set(sessionId, nextLifecycle) {
      const normalizedSessionId = String(sessionId || '').trim();
      const lifecycleStore = getStore();
      if (!normalizedSessionId || !lifecycleStore) {
        return CHAT_SEND_LIFECYCLE.IDLE;
      }
      const normalizedLifecycle = normalize(nextLifecycle);
      if (normalizedLifecycle === CHAT_SEND_LIFECYCLE.IDLE) {
        lifecycleStore.delete(normalizedSessionId);
        return CHAT_SEND_LIFECYCLE.IDLE;
      }
      lifecycleStore.set(normalizedSessionId, normalizedLifecycle);
      return normalizedLifecycle;
    }

    function clear(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      const lifecycleStore = getStore();
      if (!normalizedSessionId || !lifecycleStore) {
        return false;
      }
      return lifecycleStore.delete(normalizedSessionId);
    }

    function move(fromSessionId, toSessionId) {
      const fromId = String(fromSessionId || '').trim();
      const toId = String(toSessionId || '').trim();
      const lifecycleStore = getStore();
      if (!fromId || !toId || fromId === toId || !lifecycleStore) {
        return normalize(lifecycleStore?.get?.(toId));
      }
      const sourceLifecycle = normalize(lifecycleStore.get(fromId));
      lifecycleStore.delete(fromId);
      if (sourceLifecycle !== CHAT_SEND_LIFECYCLE.IDLE) {
        lifecycleStore.set(toId, sourceLifecycle);
      }
      return sourceLifecycle;
    }

    return {
      CHAT_SEND_LIFECYCLE,
      clearChatSendLifecycle: clear,
      getChatSendLifecycle: get,
      moveChatSendLifecycle: move,
      setChatSendLifecycle: set,
    };
  }

  function createReasoningPhaseExpansionController({
    state,
    storage,
    storageKey,
    getThinkingController = () => null,
  }) {
    function loadPreferences() {
      const expansionsBySession = new Map();
      try {
        const raw = storage?.getItem?.(storageKey);
        const parsed = raw ? JSON.parse(raw) : {};
        if (!isPlainObject(parsed)) {
          return expansionsBySession;
        }
        for (const [sessionId, phaseEntries] of Object.entries(parsed)) {
          const normalizedSessionId = String(sessionId || '').trim();
          if (!normalizedSessionId || !isPlainObject(phaseEntries)) {
            continue;
          }
          const sessionPhaseMap = new Map();
          for (const [phaseKey, expanded] of Object.entries(phaseEntries)) {
            const normalizedPhaseKey = String(phaseKey || '').trim();
            if (!normalizedPhaseKey || typeof expanded !== 'boolean') {
              continue;
            }
            sessionPhaseMap.set(normalizedPhaseKey, expanded);
            evictOldestMapEntries(sessionPhaseMap, MAX_REASONING_EXPANSIONS_PER_SESSION);
          }
          if (sessionPhaseMap.size) {
            expansionsBySession.set(normalizedSessionId, sessionPhaseMap);
            evictOldestMapEntries(expansionsBySession, MAX_REASONING_EXPANSION_SESSIONS);
          }
        }
      } catch (_error) {
        return new Map();
      }
      return expansionsBySession;
    }

    function getExpansionStore() {
      const expansionStore = state.ui?.reasoningPhaseExpansionBySession;
      return expansionStore && typeof expansionStore.get === 'function' ? expansionStore : null;
    }

    function getSessionStore(sessionId, options = {}) {
      const normalizedSessionId = String(sessionId || '').trim();
      const expansionStore = getExpansionStore();
      if (!normalizedSessionId || !expansionStore) {
        return null;
      }
      let sessionStore = expansionStore.get(normalizedSessionId);
      if (!(sessionStore instanceof Map) && options.create) {
        sessionStore = new Map();
        expansionStore.set(normalizedSessionId, sessionStore);
      }
      return sessionStore instanceof Map ? sessionStore : null;
    }

    function savePreferences() {
      const expansionStore = getExpansionStore();
      const payload = {};
      if (expansionStore && typeof expansionStore.entries === 'function') {
        evictOldestMapEntries(expansionStore, MAX_REASONING_EXPANSION_SESSIONS);
        for (const [sessionId, sessionStore] of expansionStore.entries()) {
          const normalizedSessionId = String(sessionId || '').trim();
          if (!normalizedSessionId || !(sessionStore instanceof Map) || !sessionStore.size) {
            continue;
          }
          evictOldestMapEntries(sessionStore, MAX_REASONING_EXPANSIONS_PER_SESSION);
          const sessionPayload = {};
          for (const [phaseKey, expanded] of sessionStore.entries()) {
            const normalizedPhaseKey = String(phaseKey || '').trim();
            if (!normalizedPhaseKey || typeof expanded !== 'boolean') {
              continue;
            }
            sessionPayload[normalizedPhaseKey] = expanded;
          }
          if (Object.keys(sessionPayload).length) {
            payload[normalizedSessionId] = sessionPayload;
          }
        }
      }
      try {
        storage?.setItem?.(storageKey, JSON.stringify(payload));
      } catch (_error) {
        // Storage may be unavailable or full.
      }
    }

    function buildPreferenceKey(messageId, phaseKey) {
      const normalizedMessageId = String(messageId || '').trim();
      const normalizedPhaseKey = String(phaseKey || '').trim();
      if (!normalizedMessageId || !normalizedPhaseKey) {
        return '';
      }
      return `${normalizedMessageId}::${normalizedPhaseKey}`;
    }

    function applyExpandedPreference(sessionId, messageId, phaseKey, expanded, options = {}) {
      const normalizedSessionId = String(sessionId || '').trim();
      const preferenceKey = buildPreferenceKey(messageId, phaseKey);
      if (!normalizedSessionId || !preferenceKey) {
        return null;
      }
      const shouldRemoveOverride = Boolean(expanded) === (options.defaultExpanded === true);
      const sessionStore = getSessionStore(normalizedSessionId, { create: !shouldRemoveOverride });
      if (!sessionStore) {
        return false;
      }
      if (shouldRemoveOverride) {
        sessionStore.delete(preferenceKey);
        if (!sessionStore.size) {
          getExpansionStore()?.delete(normalizedSessionId);
        }
        return false;
      }
      sessionStore.delete(preferenceKey);
      sessionStore.set(preferenceKey, expanded === true);
      evictOldestMapEntries(sessionStore, MAX_REASONING_EXPANSIONS_PER_SESSION);
      const expansionStore = getExpansionStore();
      if (expansionStore instanceof Map) {
        expansionStore.delete(normalizedSessionId);
        expansionStore.set(normalizedSessionId, sessionStore);
        evictOldestMapEntries(expansionStore, MAX_REASONING_EXPANSION_SESSIONS);
      }
      return true;
    }

    function setExpandedPreference(sessionId, messageId, phaseKey, expanded, options = {}) {
      const result = applyExpandedPreference(sessionId, messageId, phaseKey, expanded, options);
      if (result === null) {
        return false;
      }
      savePreferences();
      return result;
    }

    function setExpandedPreferences(sessionId, entries) {
      let handledCount = 0;
      for (const entry of Array.isArray(entries) ? entries : []) {
        const result = applyExpandedPreference(
          sessionId,
          entry?.messageId,
          entry?.phaseKey,
          entry?.expanded,
          { defaultExpanded: entry?.defaultExpanded === true },
        );
        if (result !== null) {
          handledCount += 1;
        }
      }
      if (handledCount > 0) {
        savePreferences();
      }
      return handledCount;
    }

    function syncPersistedExpansionState(sessionId, messages) {
      const controllerStore = getThinkingController()?.phaseExpansionState;
      if (!(controllerStore instanceof Map)) {
        return;
      }
      controllerStore.clear();
      const normalizedSessionId = String(sessionId || '').trim();
      const sessionStore = getSessionStore(normalizedSessionId);
      if (!(sessionStore instanceof Map) || !sessionStore.size) {
        return;
      }
      let pruned = false;
      if (Array.isArray(messages)) {
        const activeMessageIds = new Set(
          messages.map((message) => String(message?.id || '').trim()).filter(Boolean)
        );
        for (const preferenceKey of [...sessionStore.keys()]) {
          const separatorIndex = String(preferenceKey || '').indexOf('::');
          const messageId = separatorIndex >= 0
            ? String(preferenceKey).slice(0, separatorIndex)
            : '';
          if (!messageId || !activeMessageIds.has(messageId)) {
            sessionStore.delete(preferenceKey);
            pruned = true;
          }
        }
        if (!sessionStore.size) {
          getExpansionStore()?.delete(normalizedSessionId);
        }
      }
      if (pruned) {
        savePreferences();
      }
      for (const [phaseKey, expanded] of sessionStore.entries()) {
        const normalizedPhaseKey = String(phaseKey || '').trim();
        if (!normalizedPhaseKey) {
          continue;
        }
        controllerStore.set(normalizedPhaseKey, expanded === true);
      }
    }

    return {
      loadReasoningPhaseExpansionPreferences: loadPreferences,
      saveReasoningPhaseExpansionPreferences: savePreferences,
      setReasoningPhaseExpandedPreference: setExpandedPreference,
      setReasoningPhaseExpandedPreferences: setExpandedPreferences,
      syncPersistedReasoningPhaseExpansionState: syncPersistedExpansionState,
    };
  }

  function createStartupAuditRuntime({
    windowRef,
    state,
    dom,
    callbacks,
  }) {
    let rendererReadySignaled = false;
    let startupAuditAutoSendStarted = false;
    let startupAuditAutoSendInProgress = false;
    const {
      normalizeReasoningEffort = (value) => value,
      renderComposerState = () => {},
      startPromptSend = async () => {},
      syncComposerInputHeight = () => {},
      syncComposerVisualState = () => {},
    } = callbacks || {};
    const { chatInput, composerEffortSelect, composerModelSelect } = dom || {};

    function markStartupAudit(name, details = {}) {
      try {
        windowRef.__jennyStartupAudit?.mark?.(name, details);
      } catch (_error) {
        // Best-effort only.
      }
    }

    function signalRendererReadyOnce() {
      if (rendererReadySignaled) {
        return;
      }
      rendererReadySignaled = true;
      markStartupAudit('renderer-ready', {
        backendPhase: state.backend?.phase || '',
        authenticated: Boolean(state.auth?.authenticated),
      });
      try {
        windowRef.jennyShell?.lifecycle?.signalReady?.();
      } catch (_error) {
        // Best-effort only.
      }
    }

    async function runStartupAuditAutoSend() {
      if (startupAuditAutoSendStarted || startupAuditAutoSendInProgress) {
        return;
      }
      startupAuditAutoSendInProgress = true;
      try {
        const config = windowRef.__jennyStartupAudit?.config || await windowRef.jennyShell?.diagnostics?.getStartupAuditConfig?.().catch(() => null);
        if (config?.enabled !== true || !String(config.prompt || '').trim()) {
          return;
        }
        if (state.backend?.phase !== 'ready' || !state.auth?.authenticated) {
          return;
        }
        const preferredModel = String(config.model || '').trim();
        const reasoningEffort = normalizeReasoningEffort(config.reasoningEffort || 'high');
        if (preferredModel) {
          state.runtimeDraft.preferredModel = preferredModel;
          if (composerModelSelect) {
            composerModelSelect.value = preferredModel;
          }
        }
        state.runtimeDraft.reasoningEffort = reasoningEffort;
        if (composerEffortSelect) {
          composerEffortSelect.value = reasoningEffort;
        }
        chatInput.value = String(config.prompt || '');
        syncComposerInputHeight();
        syncComposerVisualState();
        renderComposerState();
        markStartupAudit('startup-audit-auto-send-ready', {
          model: preferredModel,
          reasoningEffort,
        });
        startupAuditAutoSendStarted = true;
        await startPromptSend(config.prompt, { startupAudit: true });
      } finally {
        if (!startupAuditAutoSendStarted) {
          startupAuditAutoSendInProgress = false;
        }
      }
    }

    return {
      markStartupAudit,
      runStartupAuditAutoSend,
      signalRendererReadyOnce,
    };
  }

  function createChatTimelinePreferenceController({
    state,
    storage,
    storageKeys,
    callbacks,
  }) {
    let hasStoredBatch4Preference = false;
    const {
      appendClientLog = () => {},
      clearProjectionContextCacheForSession = () => false,
      renderMessages = () => {},
    } = callbacks || {};
    const {
      batch4: batch4StorageKey,
    } = storageKeys || {};

    function getRowModelMetaStore() {
      if (!state.ui || typeof state.ui !== 'object') {
        state.ui = {};
      }
      if (!(state.ui.chatTimelineRowModelMetaBySession instanceof Map)) {
        state.ui.chatTimelineRowModelMetaBySession = new Map();
      }
      return state.ui.chatTimelineRowModelMetaBySession;
    }

    function createRowModelMeta(enabled, source = 'default') {
      return {
        enablement_source: String(source || 'default').trim() || 'default',
        sticky_rollback: false,
        rollback_reason: '',
        rollback_at: '',
        rollback_details: null,
        last_hydrated_projection_signature: null,
        last_hydrated_projection_digest: '',
        telemetry_counters: Object.create(null),
        signal_keys: new Map(),
        enabled: enabled === true,
      };
    }

    function getRowModelMeta(sessionId = state.currentSessionId, options = {}) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return null;
      }
      const metaStore = getRowModelMetaStore();
      let meta = metaStore.get(normalizedSessionId) || null;
      if (!meta && options.create) {
        meta = createRowModelMeta(options.enabled === true, options.source || 'default');
        metaStore.set(normalizedSessionId, meta);
      }
      return meta;
    }

    function buildSignalKey(signal, details = {}) {
      const normalizedSignal = String(signal || '').trim();
      if (!normalizedSignal) {
        return '';
      }
      if (normalizedSignal === 'orphan_row') {
        return `${normalizedSignal}:${String(details.subkind || details.orphanSubkind || '').trim()}`;
      }
      if (normalizedSignal === 'interrupted_running_tool_hydration') {
        return [
          normalizedSignal,
          String(details.turnId || details.turn_id || '').trim(),
          String(details.toolCallId || details.tool_call_id || '').trim(),
        ].join(':');
      }
      if (normalizedSignal === 'turn_article_suppressed_sibling' || normalizedSignal === 'turn_article_missing_primary') {
        return [
          normalizedSignal,
          String(details.turnId || '').trim(),
          String(details.messageId || '').trim(),
        ].join(':');
      }
      if (normalizedSignal === 'turn_article_stream_mismatch') {
        return [
          normalizedSignal,
          String(details.turnId || details.turn_id || '').trim(),
          String(details.phase || '').trim(),
        ].join(':');
      }
      if (normalizedSignal === 'stale_row_deletion') {
        return [
          normalizedSignal,
          String(details.turnId || details.turn_id || '').trim(),
        ].join(':');
      }
      if (normalizedSignal === 'active_turn_root_rebuild') {
        return String(details.outcome || '').trim() === 'morph_applied'
          ? `${normalizedSignal}:${String(details.reason || '').trim()}:morph_applied`
          : '';
      }
      if (normalizedSignal === 'streaming_article_rebuild') {
        return String(details.outcome || '').trim() === 'morph_applied'
          ? `${normalizedSignal}:morph_applied`
          : '';
      }
      // Every render lane records its DOM write, so the SUCCESSES are the
      // high-volume case -- one owner session logged 256 of them, 217 from the
      // row-list lane alone. Collapse a healthy lane to one line per session
      // (which is all the rollout gate asks of it: did this lane morph?) and
      // deliberately return NO key for any other outcome, so a fallback, a
      // parse failure or a morph that threw is counted every single time it
      // happens. Those are the numbers the lane-merge decisions ride on.
      if (normalizedSignal === 'timeline_dom_write') {
        return String(details.outcome || '').trim() === 'morph_applied'
          ? `${normalizedSignal}:${String(details.lane || '').trim()}:morph_applied`
          : '';
      }
      return '';
    }

    function resolveSignalLevel(signal, details = {}) {
      const normalizedSignal = String(signal || '').trim();
      if (
        normalizedSignal === 'interrupted_running_tool_hydration'
        || normalizedSignal === 'legacy_message_article_markup_render'
      ) {
        return 'INFO';
      }
      if (
        normalizedSignal === 'turn_article_stream_mismatch'
        && String(details?.phase || '').trim() === 'signature_hold'
      ) {
        return 'INFO';
      }
      // Healthy rebuild outcomes and affirmative projection/reconcile evidence
      // are expected rollout findings; their anomaly counterparts remain WARN.
      if (
        normalizedSignal === 'active_turn_root_rebuild'
        || normalizedSignal === 'streaming_article_rebuild'
      ) {
        return String(details?.outcome || '').trim() === 'morph_applied' ? 'INFO' : 'WARN';
      }
      if (
        normalizedSignal === 'canonical_projection_applied'
        || normalizedSignal === 'terminal_reconcile_clean'
        || normalizedSignal === 'terminal_canonical_parity'
      ) {
        return 'INFO';
      }
      // A DOM write that morphed is the EXPECTED outcome on all four render
      // lanes, and logging it at WARN buries the fallbacks worth finding under
      // hundreds of routine successes. Put the finding in the level itself:
      // grepping WARN then returns exactly the lanes that did not morph.
      if (normalizedSignal === 'timeline_dom_write') {
        return String(details?.outcome || '').trim() === 'morph_applied' ? 'INFO' : 'WARN';
      }
      return 'WARN';
    }

    function resolveDefaultBatch4Preference() {
      return true;
    }

    function resolveDefaultRowModelPreference() {
      return resolveDefaultBatch4Preference();
    }

    function getRowModelEnabled(sessionId = state.currentSessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return false;
      }
      const rowModelStore = state.ui?.chatTimelineRowModelBySession;
      if (!rowModelStore || typeof rowModelStore.get !== 'function' || typeof rowModelStore.set !== 'function') {
        return resolveDefaultRowModelPreference();
      }
      const defaultEnabled = resolveDefaultRowModelPreference();
      const meta = getRowModelMeta(normalizedSessionId, {
        create: true,
        enabled: rowModelStore.has(normalizedSessionId)
          ? rowModelStore.get(normalizedSessionId) === true
          : defaultEnabled,
        source: rowModelStore.has(normalizedSessionId) ? 'session_store' : 'default',
      });
      if (meta?.sticky_rollback === true) {
        rowModelStore.set(normalizedSessionId, false);
        meta.enabled = false;
        return false;
      }
      if (!rowModelStore.has(normalizedSessionId)) {
        rowModelStore.set(normalizedSessionId, defaultEnabled);
        if (meta) {
          meta.enabled = defaultEnabled;
        }
      }
      return rowModelStore.get(normalizedSessionId) === true;
    }

    function setRowModelEnabled(sessionId, enabled, options = {}) {
      const normalizedSessionId = String(sessionId || '').trim();
      const rowModelStore = state.ui?.chatTimelineRowModelBySession;
      if (!normalizedSessionId || !rowModelStore || typeof rowModelStore.set !== 'function') {
        return false;
      }
      const meta = getRowModelMeta(normalizedSessionId, {
        create: true,
        enabled: enabled === true,
        source: options.source || 'session_store',
      });
      if (enabled === true && meta?.sticky_rollback === true && options.force !== true) {
        rowModelStore.set(normalizedSessionId, false);
        meta.enabled = false;
        return false;
      }
      rowModelStore.set(normalizedSessionId, enabled === true);
      if (meta) {
        meta.enabled = enabled === true;
        if (options.source) {
          meta.enablement_source = String(options.source || 'session_store').trim() || 'session_store';
        }
        if (enabled !== true && options.source !== 'rollback' && meta.sticky_rollback !== true) {
          meta.rollback_reason = '';
          meta.rollback_at = '';
          meta.rollback_details = null;
        }
      }
      return rowModelStore.get(normalizedSessionId) === true;
    }

    function recordRolloutSignal(sessionId, signal, details = {}) {
      const normalizedSessionId = String(sessionId || '').trim();
      const normalizedSignal = String(signal || '').trim();
      if (!normalizedSessionId || !normalizedSignal) {
        return { logged: false, count: 0 };
      }
      const meta = getRowModelMeta(normalizedSessionId, {
        create: true,
        enabled: getRowModelEnabled(normalizedSessionId),
        source: 'telemetry',
      });
      if (!meta) {
        return { logged: false, count: 0 };
      }
      const counters = meta.telemetry_counters && typeof meta.telemetry_counters === 'object'
        ? meta.telemetry_counters
        : (meta.telemetry_counters = Object.create(null));
      counters[normalizedSignal] = Number(counters[normalizedSignal] || 0) + 1;
      const signalKey = buildSignalKey(normalizedSignal, details);
      const signalKeys = meta.signal_keys instanceof Map
        ? meta.signal_keys
        : (meta.signal_keys = new Map());
      if (signalKey && signalKeys.has(signalKey)) {
        return { logged: false, count: counters[normalizedSignal] };
      }
      if (signalKey) {
        signalKeys.set(signalKey, true);
        evictOldestMapEntries(signalKeys, MAX_CHAT_TIMELINE_SIGNAL_KEYS_PER_SESSION);
      }
      const level = resolveSignalLevel(normalizedSignal, details);
      appendClientLog(level, 'chat_timeline.row_model_rollout_signal', {
        sessionId: normalizedSessionId,
        signal: normalizedSignal,
        count: counters[normalizedSignal],
        stickyRollback: meta.sticky_rollback === true,
        ...(details && typeof details === 'object' ? details : {}),
      });
      return { logged: true, count: counters[normalizedSignal] };
    }

    function rollbackRowModel(sessionId, reason, details = {}, options = {}) {
      const normalizedSessionId = String(sessionId || '').trim();
      const normalizedReason = String(reason || '').trim();
      if (!normalizedSessionId || !normalizedReason) {
        return false;
      }
      const liveStateStore = state.ui?.chatTimelineLiveStateBySession;
      const meta = getRowModelMeta(normalizedSessionId, {
        create: true,
        enabled: false,
        source: 'rollback',
      });
      setRowModelEnabled(normalizedSessionId, false, {
        source: 'rollback',
        force: true,
      });
      if (meta) {
        meta.sticky_rollback = true;
        meta.rollback_reason = normalizedReason;
        meta.rollback_at = new Date().toISOString();
        meta.rollback_details = details && typeof details === 'object' ? { ...details } : {};
        meta.last_hydrated_projection_signature = null;
        meta.last_hydrated_projection_digest = '';
        meta.enablement_source = 'rollback';
        meta.enabled = false;
      }
      if (liveStateStore && typeof liveStateStore.delete === 'function') {
        liveStateStore.delete(normalizedSessionId);
      }
      clearProjectionContextCacheForSession(normalizedSessionId);
      // Widened render gate (ide_chat_dock): the open Workspace dock counts as
      // a live chat surface; falls back to the pre-dock predicate flag-off.
      const chatSurfaceLive = (globalThis.rendererChatSurfaceLiveUtils || {}).isChatSurfaceLive?.(state)
        ?? (state.ui?.activeView === 'chat');
      appendClientLog('WARN', 'chat_timeline.row_model_rollback', {
        sessionId: normalizedSessionId,
        reason: normalizedReason,
        visibleChatSession: normalizedSessionId === String(state.currentSessionId || '').trim() && chatSurfaceLive,
        ...(details && typeof details === 'object' ? details : {}),
      });
      if (
        options.renderNow !== false
        && normalizedSessionId === String(state.currentSessionId || '').trim()
        && chatSurfaceLive
      ) {
        renderMessages({ forceFullRender: true, forceLegacyRowModelFallback: true });
      }
      return true;
    }

    function loadBatch4Preference() {
      try {
        const raw = storage?.getItem?.(batch4StorageKey);
        if (raw === 'true') {
          hasStoredBatch4Preference = true;
          return true;
        }
        if (raw === 'false') {
          hasStoredBatch4Preference = true;
          return false;
        }
      } catch (_error) {
        // Best-effort local preference only.
      }
      return resolveDefaultBatch4Preference();
    }

    function saveBatch4Preference() {
      try {
        storage?.setItem?.(
          batch4StorageKey,
          state.ui.chatTimelineBatch4FastPathEnabled === true ? 'true' : 'false'
        );
        hasStoredBatch4Preference = true;
      } catch (_error) {
        // Best-effort local preference only.
      }
    }

    function refreshDefaultBatch4Preference() {
      if (hasStoredBatch4Preference) {
        return;
      }
      state.ui.chatTimelineBatch4FastPathEnabled = resolveDefaultBatch4Preference();
      saveBatch4Preference();
    }

    return {
      buildChatTimelineSignalKey: buildSignalKey,
      createChatTimelineRowModelMeta: createRowModelMeta,
      getChatTimelineRowModelEnabled: getRowModelEnabled,
      getChatTimelineRowModelMeta: getRowModelMeta,
      getChatTimelineRowModelMetaStore: getRowModelMetaStore,
      loadChatTimelineBatch4Preference: loadBatch4Preference,
      recordChatTimelineRolloutSignal: recordRolloutSignal,
      refreshDefaultChatTimelineBatch4Preference: refreshDefaultBatch4Preference,
      resolveChatTimelineRolloutSignalLevel: resolveSignalLevel,
      resolveDefaultChatTimelineBatch4Preference: resolveDefaultBatch4Preference,
      resolveDefaultChatTimelineRowModelPreference: resolveDefaultRowModelPreference,
      rollbackChatTimelineRowModel: rollbackRowModel,
      saveChatTimelineBatch4Preference: saveBatch4Preference,
      setChatTimelineRowModelEnabled: setRowModelEnabled,
    };
  }

  root.rendererAppLifecyclePreferences = {
    CHAT_SEND_LIFECYCLE,
    createChatSendLifecycleController,
    createChatTimelinePreferenceController,
    createReasoningPhaseExpansionController,
    createStartupAuditRuntime,
  };
})(typeof window !== 'undefined' ? window : globalThis);
