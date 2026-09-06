(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSessionUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_INTERACTIVE_ID_CHARS = 128;
  const MAX_CONTINUATION_TOKEN_TIMESTAMP_CHARS = 40;

  function normalizeStrictContinuationId(value) {
    if (typeof value !== 'string') {
      return '';
    }
    const id = value.trim();
    return id && id.length <= MAX_INTERACTIVE_ID_CHARS ? id : '';
  }

  function normalizeContinuationIssuedAt(value) {
    if (typeof value !== 'string') {
      return '';
    }
    const issuedAt = value.trim();
    if (
      !issuedAt
      || issuedAt.length > MAX_CONTINUATION_TOKEN_TIMESTAMP_CHARS
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(issuedAt)
    ) {
      return '';
    }
    const timestampMs = Date.parse(issuedAt);
    return Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : '';
  }

  function normalizeQuestionBatchContinuationToken(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const tokenId = normalizeStrictContinuationId(value.token_id);
    const sessionId = normalizeStrictContinuationId(value.session_id);
    const sessionIncarnation = normalizeStrictContinuationId(value.session_incarnation);
    const batchId = normalizeStrictContinuationId(value.batch_id);
    const priorGeneration = value.prior_generation;
    const issuedAt = normalizeContinuationIssuedAt(value.issued_at);
    if (
      !tokenId
      || !sessionId
      || !sessionIncarnation
      || !batchId
      || !Number.isSafeInteger(priorGeneration)
      || priorGeneration <= 0
      || typeof value.consumed !== 'boolean'
      || !issuedAt
    ) {
      return null;
    }
    return {
      token_id: tokenId,
      session_id: sessionId,
      session_incarnation: sessionIncarnation,
      batch_id: batchId,
      prior_generation: priorGeneration,
      consumed: value.consumed,
      issued_at: issuedAt,
    };
  }

  const COLLECTION_BRAND_PROBE = Object.freeze({});
  function hasNativeCollectionBrand(value, hasMethod) {
    if (!value) return false;
    try { hasMethod.call(value, COLLECTION_BRAND_PROBE); } catch (_error) { return false; }
    return true;
  }
  function isMapLike(value) { return hasNativeCollectionBrand(value, Map.prototype.has); }
  function isSetLike(value) { return hasNativeCollectionBrand(value, Set.prototype.has); }
  function repairSessionSetMapProperty(container, propertyName) {
    if (!container || typeof container !== 'object' || Array.isArray(container)) return null;
    if (!Object.prototype.hasOwnProperty.call(container, propertyName)) return null;
    if (isMapLike(container[propertyName])) return container[propertyName];
    container[propertyName] = new Map();
    return container[propertyName];
  }
  function rekeySessionSetMap(map, sourceSessionId, targetSessionId) {
    if (!isMapLike(map) || !map.has(sourceSessionId)) return;
    const sourceSet = map.get(sourceSessionId);
    map.delete(sourceSessionId);
    if (!isSetLike(sourceSet) || !sourceSet.size) return;
    const targetSet = map.get(targetSessionId);
    if (isSetLike(targetSet)) sourceSet.forEach((item) => targetSet.add(item));
    else map.set(targetSessionId, new Set(sourceSet));
  }

  function getComposerV2SessionState(state) {
    const composer = state?.ui?.composerV2;
    return composer && typeof composer === 'object' ? composer : null;
  }

  function removeComposerV2SessionState(state, sessionId) {
    const normalizedSessionId = String(sessionId || '').trim();
    const composer = getComposerV2SessionState(state);
    if (!normalizedSessionId || !composer) {
      return;
    }
    composer.draftsBySession?.delete?.(normalizedSessionId);
    composer.lifecycleBySession?.delete?.(normalizedSessionId);
    composer.modeListeners?.delete?.(normalizedSessionId);
  }

  function rekeyComposerV2SessionState(state, sourceSessionId, targetSessionId) {
    const normalizedSource = String(sourceSessionId || '').trim();
    const normalizedTarget = String(targetSessionId || '').trim();
    const composer = getComposerV2SessionState(state);
    if (!composer || !normalizedSource || !normalizedTarget || normalizedSource === normalizedTarget) {
      return;
    }

    if (isMapLike(composer.draftsBySession) && composer.draftsBySession.has(normalizedSource)) {
      const draft = composer.draftsBySession.get(normalizedSource);
      composer.draftsBySession.delete(normalizedSource);
      if (!composer.draftsBySession.has(normalizedTarget)) {
        composer.draftsBySession.set(
          normalizedTarget,
          draft && typeof draft === 'object'
            ? { ...draft, sessionId: normalizedTarget }
            : draft
        );
      }
    }

    if (isMapLike(composer.lifecycleBySession) && composer.lifecycleBySession.has(normalizedSource)) {
      const lifecycle = composer.lifecycleBySession.get(normalizedSource);
      composer.lifecycleBySession.delete(normalizedSource);
      if (String(lifecycle || '').trim() && !composer.lifecycleBySession.has(normalizedTarget)) {
        composer.lifecycleBySession.set(normalizedTarget, lifecycle);
      }
    }

    if (isMapLike(composer.modeListeners) && composer.modeListeners.has(normalizedSource)) {
      const sourceListeners = composer.modeListeners.get(normalizedSource);
      composer.modeListeners.delete(normalizedSource);
      if (isSetLike(sourceListeners) && sourceListeners.size) {
        const targetListeners = composer.modeListeners.get(normalizedTarget);
        if (isSetLike(targetListeners)) {
          sourceListeners.forEach((listener) => targetListeners.add(listener));
        } else {
          composer.modeListeners.set(normalizedTarget, sourceListeners);
        }
      }
    }
  }

  function noteSessionMessageAccess(state, sessionId) {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) {
      return;
    }
    if (!(state.sessionMessageAccessOrder instanceof Map)) {
      state.sessionMessageAccessOrder = new Map();
    }
    state.sessionMessageAccessOrder.delete(normalizedSessionId);
    state.sessionMessageAccessOrder.set(normalizedSessionId, Date.now());
  }

  function createSessionManager(deps) {
    const { state } = deps;
    const pendingBatchClearBySession = new Map();
    let disposed = false;

    const DEFAULT_INTERACTIVE_BATCH_ORPHAN_TIMEOUT_MS = 30 * 60 * 1000;
    const {
      INTERACTIVE_SEQUENCE_IDLE,
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
      MAX_INTERACTIVE_ROUNDS,
      MAX_INTERACTIVE_QUESTIONS,
      INTERACTIVE_BATCH_ORPHAN_TIMEOUT_MS = DEFAULT_INTERACTIVE_BATCH_ORPHAN_TIMEOUT_MS,
    } = deps.constants;

    const {
      normalizeChatMessage,
      normalizeChatMessages,
      isInteractiveOtherTrigger,
      getActiveSession,
      patchSessionSummary,
      rekeyDismissedMemorySession,
      rekeySessionArtifacts,
      clearProjectionContextCacheForSession = function noopClearProjectionContextCacheForSession() {},
      rekeyProjectionContextCache = function noopRekeyProjectionContextCache(_sourceSessionId, targetSessionId) {
        return String(targetSessionId || '').trim();
      },
      onRemoveSessionState = function noopOnRemoveSessionState() {},
      onRekeySessionState = function noopOnRekeySessionState(_sourceSessionId, targetSessionId) {
        return String(targetSessionId || '').trim();
      },
      notifySessionMessagesReplaced,
      appendClientLog = function noopAppendClientLog() {},
    } = deps.callbacks;

    function getMultiStreamController() {
      return globalThis.rendererMultiStreamController || null;
    }

    function resolveSessionId(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      return normalizedSessionId;
    }

    function getSessionMessages(sessionId) {
      const resolvedSessionId = resolveSessionId(sessionId);
      if (!resolvedSessionId) {
        return [];
      }
      noteSessionMessageAccess(state, resolvedSessionId);
      return state.messagesBySession.get(resolvedSessionId) || [];
    }

    function getTurnEventsStore() {
      if (!(state.turnEventsBySession instanceof Map)) {
        state.turnEventsBySession = new Map();
      }
      return state.turnEventsBySession;
    }

    function getSessionTurnEventState(sessionId) {
      const resolvedSessionId = resolveSessionId(sessionId);
      if (!resolvedSessionId) {
        return { turnEventLogVersion: 0, turnEvents: [] };
      }
      noteSessionMessageAccess(state, resolvedSessionId);
      return getTurnEventsStore().get(resolvedSessionId) || {
        turnEventLogVersion: 0,
        turnEvents: [],
        activeTurn: null,
      };
    }

    function setSessionTurnEventState(sessionId, payload = {}) {
      const resolvedSessionId = resolveSessionId(sessionId);
      if (!resolvedSessionId) {
        return;
      }
      // Replacing the whole turnEvents array here does NOT clear the downstream
      // projection/hydration caches (audit E1) — and does not need to. Those
      // caches are content-addressed (message fingerprints + event count + log
      // version + event_id:event_seq), and persisted events are immutable under a
      // stable event_id (append-only + dedupe-by-event_id backends), so a stale
      // cache entry survives only when its recomputed signature genuinely matches,
      // i.e. when reuse is correct. See the INVARIANT notes at the two cache-key
      // sites (renderer-render-pipeline-projection-context.js / -hydration.js).
      const turnEvents = Array.isArray(payload.turnEvents)
        ? payload.turnEvents.map((event) => (
          event && typeof event === 'object' && !Array.isArray(event) ? { ...event } : event
        ))
        : [];
      const turnEventLogVersion = Math.max(Number(payload.turnEventLogVersion || 0), 0);
      // The backend session summary's active_turn (object|null) is the gate the
      // rehydrate path consults so a settled session never re-seeds a phantom
      // Active Turn deck on reopen (session-persistence audit #2). Snapshot it so
      // later mutations of the summary can't retroactively flip the stored gate.
      const activeTurn = payload.activeTurn && typeof payload.activeTurn === 'object' && !Array.isArray(payload.activeTurn)
        ? { ...payload.activeTurn }
        : null;
      getTurnEventsStore().set(resolvedSessionId, {
        turnEventLogVersion,
        turnEvents,
        activeTurn,
      });
    }

    function isVisibleChatMessage(message) {
      return Boolean(message);
    }

    function getVisibleSessionMessages(sessionId) {
      return getSessionMessages(sessionId).filter(isVisibleChatMessage);
    }

    function setSessionMessages(sessionId, messages, fallbackIdPrefix) {
      const resolvedSessionId = resolveSessionId(sessionId);
      const normalizedMessages = normalizeChatMessages(messages, {
        fallbackIdPrefix: fallbackIdPrefix || 'message',
      });
      if (!resolvedSessionId) {
        return;
      }
      state.messagesBySession.set(resolvedSessionId, normalizedMessages);
      noteSessionMessageAccess(state, resolvedSessionId);
      if (typeof notifySessionMessagesReplaced === 'function') {
        notifySessionMessagesReplaced(resolvedSessionId, normalizedMessages);
      }
    }

    function createNormalizedMessage(role, content, extra) {
      const extraObj = extra || {};
      return normalizeChatMessage(
        {
          id: extraObj.id || `${role}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
          role,
          content,
          timestamp: extraObj.timestamp || new Date().toISOString(),
          ...extraObj,
        },
        { fallbackIdPrefix: role }
      );
    }

    function normalizeInteractiveSequenceState(value) {
      const token = String(value || '').trim().toLowerCase();
      if (token === INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE || token === INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED) {
        return token;
      }
      return INTERACTIVE_SEQUENCE_IDLE;
    }

    function normalizePendingQuestionBatch(batch) {
      if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
        return null;
      }
      const batchId = String(batch.batch_id || '').trim();
      const introText = String(batch.intro_text || '').trim();
      const parsedRoundIndex = Number(batch.round_index || 1);
      const roundIndex = Number.isFinite(parsedRoundIndex) && parsedRoundIndex > 0
        ? Math.max(1, Math.floor(parsedRoundIndex))
        : 1;
      const questions = Array.isArray(batch.questions)
        ? batch.questions
            .map((question) => {
              if (!question || typeof question !== 'object' || Array.isArray(question)) {
                return null;
              }
              const questionId = String(question.id || '').trim();
              const prompt = String(question.prompt || '').trim();
              if (!questionId || !prompt) {
                return null;
              }
              const options = Array.isArray(question.options)
                ? question.options
                    .map((option) => {
                      if (!option || typeof option !== 'object' || Array.isArray(option)) {
                        return null;
                      }
                      const optionId = String(option.id || '').trim();
                      const label = String(option.label || '').trim();
                      return optionId && label ? { id: optionId, label } : null;
                    })
                    .filter(Boolean)
                : [];
              if (!options.length) {
                return null;
              }
              return { id: questionId, prompt, options };
            })
            .filter(Boolean)
        : [];
      if (!batchId || !questions.length) {
        return null;
      }
      const continuationToken = normalizeQuestionBatchContinuationToken(batch.continuation_token);
      return {
        batch_id: batchId,
        round_index: roundIndex,
        intro_text: introText,
        questions,
        ...(continuationToken?.batch_id === batchId
          ? { continuation_token: continuationToken }
          : {}),
      };
    }

    function getPendingQuestionBatch(session) {
      const s = session !== undefined ? session : getActiveSession();
      return normalizePendingQuestionBatch(s && s.pending_question_batch);
    }

    function getInteractiveSequenceState(session) {
      const s = session !== undefined ? session : getActiveSession();
      return normalizeInteractiveSequenceState(s && s.interactive_sequence_state);
    }

    function hasStalePendingQuestionBatch(sessionId) {
      const sid = resolveSessionId(sessionId || state.currentSessionId);
      const session = state.sessions.find((entry) => resolveSessionId(entry?.id) === sid) || null;
      const batch = getPendingQuestionBatch(session);
      if (!batch) {
        return false;
      }
      const sequenceState = getInteractiveSequenceState(session);
      if (sequenceState === INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE) {
        return false;
      }
      if (sequenceState === INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED) {
        return true;
      }
      const messages = getSessionMessages(sid);
      if (!messages.length) {
        return false;
      }
      const recapForRound = messages.find(
        (message) =>
          String(message?.kind || '') === 'interactive_round_recap' &&
          Number(message?.interactive_round_recap?.round_index || 0) >= Number(batch.round_index || 0)
      );
      if (recapForRound) {
        return true;
      }
      const batchIndex = messages.findIndex(
        (message) =>
          String(message?.kind || '') === 'question_batch' &&
          String(message?.interactive_batch?.batch_id || '') === String(batch.batch_id || '')
      );
      return batchIndex !== -1 && batchIndex < messages.length - 1;
    }

    function hasOrphanedPendingQuestionBatch(sessionId) {
      const sid = resolveSessionId(sessionId || state.currentSessionId);
      const session = state.sessions.find((entry) => resolveSessionId(entry?.id) === sid) || null;
      const batch = getPendingQuestionBatch(session);
      if (!batch || !(state.interactiveDraftsBySession instanceof Map)) {
        return false;
      }
      const draft = state.interactiveDraftsBySession.get(resolveSessionId(sid));
      if (!draft || String(draft.batchId || '').trim() !== String(batch.batch_id || '').trim()) {
        return false;
      }
      const timeoutMs = Number.isFinite(Number(INTERACTIVE_BATCH_ORPHAN_TIMEOUT_MS))
        ? Math.max(0, Number(INTERACTIVE_BATCH_ORPHAN_TIMEOUT_MS))
        : DEFAULT_INTERACTIVE_BATCH_ORPHAN_TIMEOUT_MS;
      const touchedAt = Number.isFinite(Number(draft.lastTouchedAtMs))
        ? Number(draft.lastTouchedAtMs)
        : Number(draft.createdAtMs || Date.now());
      return (Date.now() - touchedAt) >= timeoutMs;
    }

    function getSessionPreferenceSetter() {
      const windowRef = typeof window !== 'undefined' ? window : null;
      const sessionsApi = windowRef?.jennyShell?.sessions || null;
      return sessionsApi && typeof sessionsApi.setPreferences === 'function'
        ? sessionsApi.setPreferences.bind(sessionsApi)
        : null;
    }

    function logBatchPersistFailure(sessionId, eventName, reason, error) {
      const details = { sessionId, reason };
      if (error && error.name) {
        details.errorName = String(error.name).slice(0, 80);
      }
      appendClientLog('WARN', eventName, details);
    }

    async function persistClearedPendingQuestionBatch(sessionId, preferences, eventName) {
      const setPreferences = getSessionPreferenceSetter();
      if (!setPreferences) {
        logBatchPersistFailure(sessionId, eventName, 'set_preferences_unavailable');
        return false;
      }
      try {
        const persisted = await setPreferences(sessionId, preferences);
        if (disposed) return false;
        if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) {
          logBatchPersistFailure(sessionId, eventName, 'persistence_unconfirmed');
          return false;
        }
        return true;
      } catch (error) {
        if (!disposed) logBatchPersistFailure(sessionId, eventName, 'set_preferences_failed', error);
        return false;
      }
    }

    async function performPendingQuestionBatchClear(sid) {
      const activeSession = state.sessions.find((session) => resolveSessionId(session?.id) === sid);
      const orphaned = hasOrphanedPendingQuestionBatch(sid);
      if (!activeSession || (!hasStalePendingQuestionBatch(sid) && !orphaned)) {
        return false;
      }
      const batchId = String(activeSession.pending_question_batch?.batch_id || '').trim();
      const persistFailureEvent = orphaned
        ? 'interactive.batch_orphan_persist_failed'
        : 'interactive.batch_stale_persist_failed';
      const persisted = await persistClearedPendingQuestionBatch(sid, {
        pending_question_batch: null,
        interactive_sequence_state: INTERACTIVE_SEQUENCE_IDLE,
        interactive_round_count: 0,
      }, persistFailureEvent);
      if (!persisted || disposed) return false;
      const currentSession = state.sessions.find((session) => resolveSessionId(session?.id) === sid);
      if (String(currentSession?.pending_question_batch?.batch_id || '').trim() !== batchId) {
        appendClientLog('WARN', 'interactive.batch_cleanup_result_stale', { sessionId: sid });
        return false;
      }
      patchSessionSummary(sid, {
        pending_question_batch: null,
        interactive_sequence_state: INTERACTIVE_SEQUENCE_IDLE,
        interactive_round_count: 0,
      });
      clearInteractiveDraft(sid);
      if (orphaned) {
        appendClientLog('WARN', 'interactive.batch_orphan_cleared', {
          sessionId: sid,
          batchId,
        });
      }
      return true;
    }

    function clearStalePendingQuestionBatch(sessionId) {
      const sid = resolveSessionId(sessionId || state.currentSessionId);
      if (disposed || !sid) return Promise.resolve(false);
      const pending = pendingBatchClearBySession.get(sid);
      if (pending) return pending;
      const operation = performPendingQuestionBatchClear(sid).finally(() => {
        if (pendingBatchClearBySession.get(sid) === operation) pendingBatchClearBySession.delete(sid);
      });
      pendingBatchClearBySession.set(sid, operation);
      return operation;
    }

    function dispose() {
      disposed = true;
      pendingBatchClearBySession.clear();
    }

    function clearInteractiveDraft(sessionId) {
      if (sessionId) {
        state.interactiveDraftsBySession.delete(resolveSessionId(sessionId));
      }
    }

    function ensureInteractiveDraft(batch, sessionId) {
      const normalizedBatch = normalizePendingQuestionBatch(batch);
      const key = resolveSessionId(sessionId || state.currentSessionId || '');
      if (!normalizedBatch || !key) {
        return null;
      }
      const existing = state.interactiveDraftsBySession.get(key);
      if (existing && existing.batchId === normalizedBatch.batch_id) {
        const touchedAt = Date.now();
        if (!Number.isFinite(Number(existing.createdAtMs))) {
          existing.createdAtMs = touchedAt;
        }
        if (!Number.isFinite(Number(existing.lastTouchedAtMs))) {
          existing.lastTouchedAtMs = touchedAt;
        }
        const maxIndex = Math.max(normalizedBatch.questions.length - 1, 0);
        existing.activeQuestionIndex = Math.min(
          Math.max(Number(existing.activeQuestionIndex) || 0, 0),
          maxIndex
        );
        existing.customTextByQuestionId = existing.customTextByQuestionId || {};
        existing.customModeByQuestionId = existing.customModeByQuestionId || {};
        existing.skippedByQuestionId = existing.skippedByQuestionId || {};
        return existing;
      }
      const createdAtMs = Date.now();
      const draft = {
        batchId: normalizedBatch.batch_id,
        selections: {},
        activeQuestionIndex: 0,
        customTextByQuestionId: {},
        customModeByQuestionId: {},
        skippedByQuestionId: {},
        createdAtMs,
        lastTouchedAtMs: createdAtMs,
      };
      state.interactiveDraftsBySession.set(key, draft);
      return draft;
    }

    function getInteractiveDraft(batch, sessionId) {
      const normalizedBatch = normalizePendingQuestionBatch(batch);
      const key = resolveSessionId(sessionId || state.currentSessionId || '');
      if (!normalizedBatch || !key) {
        return null;
      }
      return ensureInteractiveDraft(normalizedBatch, key);
    }

    function buildInteractiveQuestionBatchSummary(batch) {
      const normalizedBatch = normalizePendingQuestionBatch(batch);
      if (!normalizedBatch) {
        return '';
      }
      const lines = [];
      if (normalizedBatch.intro_text) {
        lines.push(normalizedBatch.intro_text);
      }
      normalizedBatch.questions.forEach((question, index) => {
        const options = question.options.map((option) => option.label).join(' / ');
        lines.push(`${index + 1}. ${question.prompt}${options ? ` (${options})` : ''}`);
      });
      return lines.join('\n').trim();
    }

    function buildInteractiveQuestionBatchVisibleText(batch) {
      return buildInteractiveQuestionBatchSummary(batch);
    }

    function shouldForceInteractiveGuardrail(batch) {
      const normalizedBatch = normalizePendingQuestionBatch(batch);
      return Boolean(normalizedBatch && Number(normalizedBatch.round_index || 0) >= MAX_INTERACTIVE_ROUNDS);
    }

    function buildInteractiveSelectedAnswers(batch, draft) {
      const normalizedBatch = normalizePendingQuestionBatch(batch);
      if (!normalizedBatch || !draft) {
        return [];
      }
      return normalizedBatch.questions
        .map((question) => {
          const optionId = String(draft.selections[question.id] || '').trim();
          if (!optionId) {
            return null;
          }
          if (isInteractiveOtherTrigger(question, optionId)) {
            const customText = String(draft.customTextByQuestionId?.[question.id] || '').trim();
            if (!customText || draft.customModeByQuestionId?.[question.id]) {
              return null;
            }
            return { question_id: question.id, option_id: '', text: customText };
          }
          return { question_id: question.id, option_id: optionId, text: '' };
        })
        .filter(Boolean);
    }

    function buildInteractiveAnswerPrompt(batch, answers, freeformText) {
      const normalizedBatch = normalizePendingQuestionBatch(batch);
      const freeform = String(freeformText || '').trim();
      if (freeform) {
        return freeform;
      }
      if (!normalizedBatch || !Array.isArray(answers) || !answers.length) {
        return '';
      }
      return normalizedBatch.questions
        .map((question) => {
          const answer = answers.find((entry) => entry.question_id === question.id);
          if (!answer) {
            return null;
          }
          const option = question.options.find((entry) => entry.id === answer.option_id);
          return String(option && option.label || answer.text || '').trim() || null;
        })
        .filter(Boolean)
        .join('\n');
    }

    function getCurrentSessionMessages() {
      return getSessionMessages(state.currentSessionId);
    }

    function getCurrentVisibleMessages() {
      return getVisibleSessionMessages(state.currentSessionId);
    }

    function getTokenCountedMessages(messages) {
      const list = Array.isArray(messages) ? messages : [];
      return list.filter((message) => {
        const kind = String(message && message.kind || '');
        return kind !== 'question_batch' && kind !== 'interactive_round_recap' &&
          kind !== 'tool_use' && kind !== 'tool_result' && kind !== 'slash_command_output';
      });
    }

    function estimateTokens(messages) {
      const characters = getTokenCountedMessages(messages).reduce(
        (sum, message) => sum + String(message.content || '').length, 0
      );
      return Math.max(Math.ceil(characters / 4), 0);
    }

    function upsertSessionSummary(sessionSummary, options = {}) {
      const summary =
        sessionSummary && typeof sessionSummary === 'object' && !Array.isArray(sessionSummary)
          ? { ...sessionSummary }
          : null;
      const sessionId = String(summary?.id || '').trim();
      if (!summary || !sessionId) {
        return null;
      }
      const prepend = options.prepend !== false;
      const existingIndex = state.sessions.findIndex(
        (session) => String(session?.id || '').trim() === sessionId
      );
      if (existingIndex !== -1) {
        state.sessions[existingIndex] = {
          ...state.sessions[existingIndex],
          ...summary,
        };
        return state.sessions[existingIndex];
      }
      if (prepend) {
        state.sessions.unshift(summary);
      } else {
        state.sessions.push(summary);
      }
      return summary;
    }

    function removeSessionState(sessionId, options = {}) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return;
      }
      const multiStreamController = getMultiStreamController();
      const preflight = multiStreamController?.getPreflight?.(normalizedSessionId) || null;
      if (preflight?.pending) {
        preflight.discarded = true;
      }
      state.sessions = state.sessions.filter((session) => {
        const sessionKey = String(session?.id || '').trim();
        return sessionKey !== normalizedSessionId;
      });
      state.messagesBySession.delete(normalizedSessionId);
      getTurnEventsStore().delete(normalizedSessionId);
      state.sessionMessageAccessOrder?.delete(normalizedSessionId);
      state.interactiveDraftsBySession.delete(normalizedSessionId);
      if (isMapLike(state.ui?.interactiveRecapExpandedBySession)) {
        state.ui.interactiveRecapExpandedBySession.delete(normalizedSessionId);
      }
      if (isMapLike(state.ui?.reasoningPhaseExpansionBySession)) {
        state.ui.reasoningPhaseExpansionBySession.delete(normalizedSessionId);
      }
      repairSessionSetMapProperty(state.ui, 'threadBranchesCollapsedBySession')?.delete(normalizedSessionId);
      if (isMapLike(state.ui?.chatSendLifecycleBySession)) {
        state.ui.chatSendLifecycleBySession.delete(normalizedSessionId);
      }
      if (isMapLike(state.ui?.chatTimelineRowModelBySession)) {
        state.ui.chatTimelineRowModelBySession.delete(normalizedSessionId);
      }
      if (isMapLike(state.ui?.chatTimelineRowModelMetaBySession)) {
        state.ui.chatTimelineRowModelMetaBySession.delete(normalizedSessionId);
      }
      if (isMapLike(state.ui?.chatTimelineLiveStateBySession)) {
        state.ui.chatTimelineLiveStateBySession.delete(normalizedSessionId);
      }
      state.ui?.chatTimelineVisibilityTracker?.clearSession?.(normalizedSessionId);
      removeComposerV2SessionState(state, normalizedSessionId);
      // UIUX-006: release/drop the session-owned composer record (text,
      // selection, attachments) the same way every other per-session cache
      // is torn down here — otherwise a backgrounded draft's attachment
      // assets leak past the session's deletion.
      globalThis.rendererComposerSessionStateController?.dropSession(normalizedSessionId);
      state.sendReceiptController?.clearFailedPayloads?.(normalizedSessionId);
      clearProjectionContextCacheForSession(normalizedSessionId);
      onRemoveSessionState(normalizedSessionId);
      if (state.sendOutboxController?.clearSession) {
        state.sendOutboxController.clearSession(normalizedSessionId);
      } else {
        state.sendOutboxBySession?.delete(normalizedSessionId);
        state.queuedSendBySession?.delete(normalizedSessionId);
      }
      state.turnClockBySession?.delete(normalizedSessionId); multiStreamController?.clearSessionStream?.(normalizedSessionId);
      multiStreamController?.forgetSessionGeneration?.(normalizedSessionId);
      multiStreamController?.clearPreflight?.(normalizedSessionId);
      // CTL-013: a delete mid-postwork must invalidate the generation token and
      // drop postwork membership so a late hydration/refresh continuation for
      // this (now gone) session cannot resurrect messagesBySession or any
      // other renderer state, and so the session-busy gate is not left set.
      multiStreamController?.clearTerminalPostwork?.(normalizedSessionId);
      // Audit A2: tombstone the deleted id so a sessions.list() snapshot that
      // was awaited BEFORE the backend delete cannot resurrect this session
      // into state.sessions when it resolves after this teardown (the
      // stale-snapshot TOCTOU behind late-refresh repopulation). Bounded and
      // TTL-pruned by the list-refresh side, so a genuine future re-list
      // (e.g. an import under a fresh id — ids are never reused) self-heals.
      // Opt-in ONLY for callers that know a delete actually happened: this
      // teardown is shared with reconcileSessionCaches, whose "orphan" verdict
      // comes from the same possibly-stale list snapshot the tombstone guards
      // against — tombstoning there would hide a LIVE session that a racing
      // list momentarily omitted for the full TTL (code review 2026-07-10).
      if (options.tombstone === true) {
        if (!(state.recentlyDeletedSessionIds instanceof Map)) {
          state.recentlyDeletedSessionIds = new Map();
        }
        state.recentlyDeletedSessionIds.set(normalizedSessionId, Date.now());
        while (state.recentlyDeletedSessionIds.size > 128) {
          const oldestDeletedId = state.recentlyDeletedSessionIds.keys().next().value;
          state.recentlyDeletedSessionIds.delete(oldestDeletedId);
        }
      }
      if (String(state.activeStreamSessionId || '').trim() === normalizedSessionId) {
        state.activeStreamSessionId = '';
      }
      if (String(state.currentSessionId || '').trim() === normalizedSessionId) {
        state.currentSessionId = '';
      }
    }

    function rekeySessionState(sourceSessionId, targetSessionId) {
      const normalizedSource = String(sourceSessionId || '').trim();
      const normalizedTarget = String(targetSessionId || '').trim();
      if (!normalizedSource || !normalizedTarget || normalizedSource === normalizedTarget) {
        return normalizedTarget || normalizedSource;
      }
      const multiStreamController = getMultiStreamController();

      const sourceMessages = state.messagesBySession.get(normalizedSource);
      const targetMessages = state.messagesBySession.get(normalizedTarget);
      if (sourceMessages) {
        state.messagesBySession.set(
          normalizedTarget,
          Array.isArray(targetMessages) && targetMessages.length ? targetMessages : sourceMessages
        );
        state.messagesBySession.delete(normalizedSource);
      }

      const sourceTurnEvents = getTurnEventsStore().get(normalizedSource);
      const targetTurnEvents = getTurnEventsStore().get(normalizedTarget);
      if (sourceTurnEvents) {
        getTurnEventsStore().set(
          normalizedTarget,
          targetTurnEvents && Array.isArray(targetTurnEvents.turnEvents) && targetTurnEvents.turnEvents.length
            ? targetTurnEvents
            : sourceTurnEvents
        );
        getTurnEventsStore().delete(normalizedSource);
      }

      const accessOrder = state.sessionMessageAccessOrder;
      if (accessOrder instanceof Map && accessOrder.has(normalizedSource)) {
        const accessTimestamp = accessOrder.get(normalizedSource);
        accessOrder.delete(normalizedSource);
        accessOrder.set(normalizedTarget, accessTimestamp);
      }

      if (state.interactiveDraftsBySession.has(normalizedSource)) {
        const draft = state.interactiveDraftsBySession.get(normalizedSource);
        state.interactiveDraftsBySession.set(normalizedTarget, draft);
        state.interactiveDraftsBySession.delete(normalizedSource);
      }

      rekeySessionSetMap(state.ui?.interactiveRecapExpandedBySession, normalizedSource, normalizedTarget);
      const threadCollapseMap = repairSessionSetMapProperty(state.ui, 'threadBranchesCollapsedBySession');
      rekeySessionSetMap(threadCollapseMap, normalizedSource, normalizedTarget);

      if (isMapLike(state.ui?.reasoningPhaseExpansionBySession) && state.ui.reasoningPhaseExpansionBySession.has(normalizedSource)) {
        const sourcePhaseOverrides = state.ui.reasoningPhaseExpansionBySession.get(normalizedSource);
        state.ui.reasoningPhaseExpansionBySession.delete(normalizedSource);
        if (sourcePhaseOverrides && typeof sourcePhaseOverrides.entries === 'function') {
          const existingTargetOverrides = state.ui.reasoningPhaseExpansionBySession.get(normalizedTarget);
          const mergedTargetOverrides = existingTargetOverrides instanceof Map
            ? new Map(existingTargetOverrides)
            : new Map();
          for (const [phaseKey, expanded] of sourcePhaseOverrides.entries()) {
            mergedTargetOverrides.set(phaseKey, expanded === true);
          }
          if (mergedTargetOverrides.size) {
            state.ui.reasoningPhaseExpansionBySession.set(normalizedTarget, mergedTargetOverrides);
          }
        }
      }

      if (isMapLike(state.ui?.chatSendLifecycleBySession) && state.ui.chatSendLifecycleBySession.has(normalizedSource)) {
        const sourceLifecycle = String(state.ui.chatSendLifecycleBySession.get(normalizedSource) || '').trim();
        state.ui.chatSendLifecycleBySession.delete(normalizedSource);
        if (sourceLifecycle) {
          state.ui.chatSendLifecycleBySession.set(normalizedTarget, sourceLifecycle);
        }
      }

      if (isMapLike(state.ui?.chatTimelineRowModelBySession) && state.ui.chatTimelineRowModelBySession.has(normalizedSource)) {
        const sourceRowModel = state.ui.chatTimelineRowModelBySession.get(normalizedSource) === true;
        state.ui.chatTimelineRowModelBySession.delete(normalizedSource);
        state.ui.chatTimelineRowModelBySession.set(normalizedTarget, sourceRowModel);
      }

      if (isMapLike(state.ui?.chatTimelineRowModelMetaBySession) && state.ui.chatTimelineRowModelMetaBySession.has(normalizedSource)) {
        const sourceRowModelMeta = state.ui.chatTimelineRowModelMetaBySession.get(normalizedSource);
        state.ui.chatTimelineRowModelMetaBySession.delete(normalizedSource);
        state.ui.chatTimelineRowModelMetaBySession.set(normalizedTarget, sourceRowModelMeta);
      }

      if (isMapLike(state.ui?.chatTimelineLiveStateBySession) && state.ui.chatTimelineLiveStateBySession.has(normalizedSource)) {
        const liveState = state.ui.chatTimelineLiveStateBySession.get(normalizedSource);
        state.ui.chatTimelineLiveStateBySession.delete(normalizedSource);
        state.ui.chatTimelineLiveStateBySession.set(normalizedTarget, liveState);
      }

      state.ui?.chatTimelineVisibilityTracker?.rekeySession?.(normalizedSource, normalizedTarget);

      rekeyComposerV2SessionState(state, normalizedSource, normalizedTarget);
      // UIUX-006: an optimistic local session id migrating to its
      // server-assigned id must carry its composer record (text/selection/
      // attachments) forward the same way interactiveDraftsBySession does
      // above, or a draft typed before the id resolved vanishes.
      globalThis.rendererComposerSessionStateController?.rekeySession(normalizedSource, normalizedTarget);
      rekeyProjectionContextCache(normalizedSource, normalizedTarget);
      onRekeySessionState(normalizedSource, normalizedTarget);

      if (state.sendOutboxController?.rekeySession) {
        state.sendOutboxController.rekeySession(normalizedSource, normalizedTarget);
      } else if (state.sendOutboxBySession?.has(normalizedSource)) {
        const outbox = (state.sendOutboxBySession.get(normalizedSource) || []).map((entry) => Object.freeze({
          ...entry,
          sessionId: normalizedTarget,
          revision: (Number(entry?.revision) || 0) + 1,
        }));
        state.sendOutboxBySession.set(normalizedTarget, outbox);
        state.sendOutboxBySession.delete(normalizedSource);
      }

      if (state.queuedSendBySession?.has(normalizedSource)) {
        const queuedSend = state.queuedSendBySession.get(normalizedSource);
        state.queuedSendBySession.set(normalizedTarget, { ...queuedSend, sessionId: normalizedTarget });
        state.queuedSendBySession.delete(normalizedSource);
      }
      if (state.turnClockBySession?.has(normalizedSource)) { state.turnClockBySession.set(normalizedTarget, state.turnClockBySession.get(normalizedSource)); state.turnClockBySession.delete(normalizedSource); }
      const sourceIndex = state.sessions.findIndex(
        (session) => String(session?.id || '').trim() === normalizedSource
      );
      if (sourceIndex !== -1) {
        const sourceSession = state.sessions[sourceIndex];
        const targetIndex = state.sessions.findIndex(
          (session, index) => index !== sourceIndex && String(session?.id || '').trim() === normalizedTarget
        );
        if (targetIndex !== -1) {
          state.sessions[targetIndex] = {
            ...state.sessions[targetIndex],
            ...sourceSession,
            id: normalizedTarget,
          };
          state.sessions.splice(sourceIndex, 1);
        } else {
          state.sessions[sourceIndex] = {
            ...sourceSession,
            id: normalizedTarget,
          };
        }
      }

      if (String(state.currentSessionId || '').trim() === normalizedSource) {
        state.currentSessionId = normalizedTarget;
      }
      if (String(state.activeStreamSessionId || '').trim() === normalizedSource) {
        state.activeStreamSessionId = normalizedTarget;
      }
      multiStreamController?.rekeySessionStream?.(normalizedSource, normalizedTarget);

      if (state.sendPreflight && typeof state.sendPreflight === 'object') {
        if (String(state.sendPreflight.sessionId || '').trim() === normalizedSource) {
          state.sendPreflight.sessionId = normalizedTarget;
        }
        if (String(state.sendPreflight.optimisticSessionId || '').trim() === normalizedSource) {
          state.sendPreflight.optimisticSessionId = normalizedTarget;
        }
        if (String(state.sendPreflight.previousSessionId || '').trim() === normalizedSource) {
          state.sendPreflight.previousSessionId = normalizedTarget;
        }
      }
      const controllerPreflight = multiStreamController?.getPreflight?.(normalizedSource) || null;
      if (controllerPreflight) {
        multiStreamController.clearPreflight?.(normalizedSource);
        if (String(controllerPreflight.sessionId || '').trim() === normalizedSource) {
          controllerPreflight.sessionId = normalizedTarget;
        }
        if (String(controllerPreflight.optimisticSessionId || '').trim() === normalizedSource) {
          controllerPreflight.optimisticSessionId = normalizedTarget;
        }
        if (String(controllerPreflight.previousSessionId || '').trim() === normalizedSource) {
          controllerPreflight.previousSessionId = normalizedTarget;
        }
        multiStreamController.registerPreflight?.(normalizedTarget, controllerPreflight);
      }

      for (const approval of state.pendingToolApprovals.values()) {
        if (!approval || typeof approval !== 'object') {
          continue;
        }
        if (String(approval.sessionId || '').trim() === normalizedSource) {
          approval.sessionId = normalizedTarget;
        }
      }

      rekeyDismissedMemorySession?.(normalizedSource, normalizedTarget);
      rekeySessionArtifacts?.(normalizedSource, normalizedTarget);

      return normalizedTarget;
    }

    return {
      resolveSessionId,
      getSessionMessages,
      getSessionTurnEventState,
      getVisibleSessionMessages,
      setSessionMessages,
      setSessionTurnEventState,
      createNormalizedMessage,
      normalizePendingQuestionBatch,
      getPendingQuestionBatch,
      getInteractiveSequenceState,
      hasStalePendingQuestionBatch,
      hasOrphanedPendingQuestionBatch,
      clearStalePendingQuestionBatch,
      dispose,
      clearInteractiveDraft,
      ensureInteractiveDraft,
      getInteractiveDraft,
      buildInteractiveQuestionBatchSummary,
      buildInteractiveQuestionBatchVisibleText,
      shouldForceInteractiveGuardrail,
      buildInteractiveSelectedAnswers,
      buildInteractiveAnswerPrompt,
      getCurrentSessionMessages,
      getCurrentVisibleMessages,
      getTokenCountedMessages,
      estimateTokens,
      upsertSessionSummary,
      removeSessionState,
      rekeySessionState,
    };
  }

  return { createSessionManager };
});
