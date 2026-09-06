const { normalizeString } = require('../../renderer/shared/string-utils');
const {
  createConversationStorePort,
  messageIntentMatches,
} = require('./conversation-store-port');
const {
  normalizeContextPreferences,
} = require('./context-preferences');
const {
  normalizeConversationMode,
  normalizeInteractiveSequenceState,
  normalizeInteractiveRoundCount,
  normalizeMessageFields,
  normalizePlanMode,
  normalizePendingQuestionBatch,
  normalizePendingPlanProposal,
  normalizeInteractiveRoundRecap,
  normalizeMessageRole,
  normalizeToolCallMetadata,
  normalizeToolResultMetadata,
  normalizeProactiveSuggestionMetadata,
} = require('./message-normalization');
const {
  activeTurnClearMatchIsExplicit,
  activeTurnMatchesRequest,
  activeTurnPassesStreamCas,
  buildTouchedActiveTurn,
  normalizeActiveTurn,
  normalizeActiveTurnMatch,
  normalizeActiveTurnStatus,
  normalizePreferredModel,
  normalizeReasoningEffort,
} = require('./session-normalizers');
const {
  normalizeBranchOrigin,
} = require('./session-store-migrations');
const {
  SessionStorageBackend,
  deriveSessionsDirectory,
} = require('./session-storage-backend');
const {
  TURN_EVENT_LOG_VERSION,
  appendTurnEventsToSession,
  normalizeAndSortTurnEvents,
  resolveReanchoredHistory,
  truncateTurnEventsAtEditBoundary,
} = require('./session-turn-events');
const { settleStalePendingPlanDocuments } = require('./plan-document-events');

// Bumped from 3 -> 4 when the on-disk layout changed from a single
// session-shadow.json to a session-shadow/<id>.json + _index.json directory;
// v5 adds normalized branch_origin lineage summaries. v6 adds message reaction
// markers on transcript messages. v7 persists the bounded external edit mask
// that prevents remote pre-edit descendants from reappearing after hydration.
// v8 persists the session-incarnation and monotonic turn-generation identity
// used by the session-local actor across process restarts and actor eviction.
// Old v1/v2/v3
// monolithic files auto-migrate via SessionStorageBackend's
// legacyMaxSchemaVersion path.
const STORE_SCHEMA_VERSION = 8;
const LEGACY_MONOLITHIC_MAX_SCHEMA_VERSION = 3;
const MAX_EXTERNAL_EDIT_HIDDEN_MESSAGE_IDS = 4096;
const MAX_EXTERNAL_EDIT_HIDDEN_MESSAGE_ID_BYTES = 512;
const MAX_EXTERNAL_EDIT_HIDDEN_MESSAGE_IDS_SERIALIZED_BYTES = 256 * 1024;

function normalizeTurnGeneration(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeExternalEditHiddenMessageId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  if (!id || Buffer.byteLength(id, 'utf8') > MAX_EXTERNAL_EDIT_HIDDEN_MESSAGE_ID_BYTES) {
    return '';
  }
  for (let index = 0; index < id.length; index += 1) {
    const codeUnit = id.charCodeAt(index);
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) return '';
  }
  return id;
}

function normalizeExternalEditHiddenMessageIds(value) {
  const ids = [];
  const seen = new Set();
  let serializedBytes = 2; // JSON array brackets.
  for (const candidate of Array.isArray(value) ? value : []) {
    const id = normalizeExternalEditHiddenMessageId(candidate);
    if (!id || seen.has(id)) continue;
    const idSerializedBytes = Buffer.byteLength(JSON.stringify(id), 'utf8');
    const nextSerializedBytes = serializedBytes + idSerializedBytes + (ids.length ? 1 : 0);
    if (nextSerializedBytes > MAX_EXTERNAL_EDIT_HIDDEN_MESSAGE_IDS_SERIALIZED_BYTES) {
      continue;
    }
    seen.add(id);
    ids.push(id);
    serializedBytes = nextSerializedBytes;
    if (ids.length >= MAX_EXTERNAL_EDIT_HIDDEN_MESSAGE_IDS) break;
  }
  return ids;
}

function nowIso() {
  return new Date().toISOString();
}

function createLocalMessage(role, content, model) {
  const source =
    content && typeof content === 'object' && !Array.isArray(content)
      ? content
      : { content };
  const normalizedFields = normalizeMessageFields(source, model || '');
  if (!normalizedFields) {
    return null;
  }
  const interactiveBatch = normalizePendingQuestionBatch(source.interactive_batch);
  const interactiveRoundRecap = normalizeInteractiveRoundRecap(source.interactive_round_recap);
  const toolCall = normalizeToolCallMetadata(source.tool_call);
  const toolResult = normalizeToolResultMetadata(source.tool_result);
  const proactiveSuggestion = normalizeProactiveSuggestionMetadata(source.proactive_suggestion);
  const kind =
    normalizeString(source.kind) === 'interactive_round_recap' && interactiveRoundRecap
      ? 'interactive_round_recap'
      : normalizeString(source.kind);
  const localMessageId = String(
    normalizedFields.id || source.id || `local_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
  );
  const clientMessageId =
    !kind && (role === 'user' || role === 'assistant')
      ? String(normalizedFields.client_message_id || localMessageId)
      : String(normalizedFields.client_message_id || '');

  return {
    ...normalizedFields,
    id: localMessageId,
    role: normalizeMessageRole(role),
    kind,
    client_message_id: clientMessageId,
    interactive_batch: interactiveBatch,
    interactive_round_recap: interactiveRoundRecap,
    tool_call: toolCall,
    tool_result: toolResult,
    proactive_suggestion: proactiveSuggestion,
    provider_used: 'electron',
    local: true,
  };
}

function getPreviewText(message, fallback = '') {
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const content = String(message.content || '').trim();
    if (content) {
      return content;
    }
  }
  return String(message || fallback || '');
}

function hasMeaningfulMessageContent(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  if (String(message.kind || '').trim() === 'question_batch') {
    return Boolean(
      String(message.content || '').trim() || normalizePendingQuestionBatch(message.interactive_batch)
    );
  }
  if (String(message.kind || '').trim() === 'interactive_round_recap') {
    return Boolean(normalizeInteractiveRoundRecap(message.interactive_round_recap));
  }
  if (String(message.kind || '').trim() === 'tool_use') {
    return Boolean(normalizeToolCallMetadata(message.tool_call));
  }
  if (String(message.kind || '').trim() === 'tool_result') {
    return Boolean(normalizeToolResultMetadata(message.tool_result));
  }
  if (String(message.kind || '').trim() === 'proactive_suggestion') {
    return Boolean(normalizeProactiveSuggestionMetadata(message.proactive_suggestion))
      || Boolean(String(message.content || '').trim());
  }
  if (String(message.content || '').trim()) {
    return true;
  }
  if (String(message.stream_error || '').trim()) {
    return true;
  }
  if (Array.isArray(message.reasoning?.entries) && message.reasoning.entries.length > 0) {
    return true;
  }
  return Array.isArray(message.attachments) && message.attachments.length > 0;
}

function isPlainUserAssistantMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  const role = String(message.role || '').trim();
  const kind = String(message.kind || '').trim();
  return (role === 'user' || role === 'assistant') && !kind;
}

function normalizeShadowSession(sessionId, input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const {
    turnEvents,
    maxSeq: maxPersistedTurnEventSeq,
  } = normalizeAndSortTurnEvents(source.turn_events);
  const activeTurnSource =
    source.active_turn
    && typeof source.active_turn === 'object'
    && !Array.isArray(source.active_turn)
      ? {
          ...source.active_turn,
          started_at:
            source.active_turn.started_at
            || source.active_turn.startedAt
            || source.created_at
            || source.updated_at,
          last_event_at:
            source.active_turn.last_event_at
            || source.active_turn.lastEventAt
            || source.updated_at
            || source.created_at,
        }
      : null;
  const lastModel = source.last_model_used || '';
  const messages = Array.isArray(source.messages)
    ? source.messages
        .map((message) =>
          createLocalMessage(String(message?.role || 'assistant'), message, lastModel)
        )
        .filter(Boolean)
    : [];
  return {
    ...source,
    id: String(source.id || sessionId || '').trim() || sessionId,
    title: String(source.title || 'New Chat'),
    session_type: String(source.session_type || 'chat'),
    created_at: String(source.created_at || nowIso()),
    updated_at: String(source.updated_at || nowIso()),
    message_count: Math.max(Number(source.message_count || 0), messages.length, 0),
    last_message_preview: String(source.last_message_preview || ''),
    last_model_used: String(lastModel),
    messages,
    turn_event_log_version: Math.max(Number(source.turn_event_log_version || 0), 0),
    turn_event_seq_counter: Math.max(
      Number(source.turn_event_seq_counter || 0),
      maxPersistedTurnEventSeq + 1,
      turnEvents.length,
      0
    ),
    turn_events: turnEvents,
    active_turn: normalizeActiveTurn(activeTurnSource),
    session_incarnation: String(source.session_incarnation || '').trim(),
    turn_generation: normalizeTurnGeneration(source.turn_generation),
    external_edit_hidden_message_ids: normalizeExternalEditHiddenMessageIds(
      source.external_edit_hidden_message_ids
    ),
    branch_origin: normalizeBranchOrigin(source.branch_origin || source.branchOrigin),
  };
}

function summarizeShadowSession(session) {
  const source = session && typeof session === 'object' && !Array.isArray(session) ? session : {};
  const messageCount = Math.max(
    Number(source.message_count || 0),
    Array.isArray(source.messages) ? source.messages.length : 0,
    0
  );
  return {
    id: String(source.id || ''),
    title: String(source.title || 'New Chat'),
    session_type: String(source.session_type || 'chat'),
    created_at: String(source.created_at || ''),
    updated_at: String(source.updated_at || ''),
    session_start_date: String(source.session_start_date || ''),
    message_count: messageCount,
    last_message_preview: String(source.last_message_preview || ''),
    last_model_used: String(source.last_model_used || ''),
    preferred_model: String(source.preferred_model || ''),
    reasoning_effort: String(source.reasoning_effort || 'default'),
    conversation_mode: source.conversation_mode || 'chat',
    pending_question_batch: source.pending_question_batch || null,
    pending_plan_proposal: source.pending_plan_proposal || null,
    interactive_sequence_state: source.interactive_sequence_state || 'idle',
    interactive_round_count: Number(source.interactive_round_count || 0),
    plan_mode: source.plan_mode === true,
    context_preferences: source.context_preferences || null,
    linked_session_ids: Array.isArray(source.linked_session_ids) ? source.linked_session_ids : [],
    branch_origin: normalizeBranchOrigin(source.branch_origin || source.branchOrigin),
    turn_event_log_version: Number(source.turn_event_log_version || 0),
  };
}

function migrateShadowPayload(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const sessions =
    source.sessions && typeof source.sessions === 'object' && !Array.isArray(source.sessions)
      ? source.sessions
      : {};
  return {
    schema_version: STORE_SCHEMA_VERSION,
    sessions,
  };
}

// Trailing-edge coalesce window for per-session FileJsonStore instances is
// opt-in: production wiring (services/backend/backend-service.js) passes a
// non-zero writeDebounceMs; tests default to 0 (immediate writes). Callers
// using debouncing MUST call flush() / dispose() before shutdown.
const DEFAULT_WRITE_DEBOUNCE_MS = 0;

class SessionShadowStore {
  constructor(filePath, { logger = null, writeDebounceMs = DEFAULT_WRITE_DEBOUNCE_MS } = {}) {
    this.filePath = filePath;
    this._logger = typeof logger === 'function' ? logger : null;
    const sessionsDir = deriveSessionsDirectory(filePath);
    this._backend = new SessionStorageBackend(sessionsDir, {
      legacyMonolithicPath: filePath,
      schemaVersion: STORE_SCHEMA_VERSION,
      legacyMaxSchemaVersion: LEGACY_MONOLITHIC_MAX_SCHEMA_VERSION,
      migratePayload: migrateShadowPayload,
      normalizeSession: normalizeShadowSession,
      summarizeSession: summarizeShadowSession,
      writeDebounceMs,
      logger: this._logger,
      storeName: 'session_shadow_store',
    });
    this.turnEventLogVersion = TURN_EVENT_LOG_VERSION;
    this._stalePlanAuditSessionIds = new Set();
    this.conversationStore = createConversationStorePort(this, { kind: 'shadow' });
  }

  // Test-injection seam: tests override `store.store.write` to simulate disk
  // failures. The legacy backend exposed a single FileJsonStore; the split
  // backend exposes the index store here so the same override pattern still
  // produces a `session_shadow_store.write_failed` log without updating the
  // cache.
  get store() {
    return this._backend._indexStore;
  }

  _read() {
    return this._backend.getIndexSnapshot();
  }

  _write(payload) {
    const incoming =
      payload && payload.sessions && typeof payload.sessions === 'object' && !Array.isArray(payload.sessions)
        ? payload.sessions
        : {};
    const indexSnapshot = this._backend.getIndexSnapshot();
    const currentSessions = indexSnapshot.sessions || {};

    for (const currentId of Object.keys(currentSessions)) {
      if (!Object.prototype.hasOwnProperty.call(incoming, currentId)) {
        this._backend.deleteSession(currentId);
      }
    }
    for (const incomingId of Object.keys(incoming)) {
      const incomingValue = incoming[incomingId];
      const cachedValue = currentSessions[incomingId];
      if (incomingValue && cachedValue && incomingValue === cachedValue) {
        continue;
      }
      this._backend.upsertSession(incomingId, incomingValue, { persist: true });
    }
  }

  hasPendingMigrations() {
    return this._backend.hasPendingMigrations();
  }

  async runPendingMigrations(options = {}) {
    return this._backend.runPendingMigrations(options);
  }

  _withSessionMutation(sessionId, mutator, {
    bumpUpdatedAt = true,
    allowCreate = false,
  } = {}) {
    const existing = this._backend.getSession(sessionId);
    if (!existing && !allowCreate) {
      return null;
    }
    const current = existing || {
      title: 'New Chat',
      created_at: nowIso(),
      updated_at: nowIso(),
      message_count: 0,
      last_message_preview: '',
      messages: [],
    };
    const patch = typeof mutator === 'function' ? mutator(current) : mutator;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return null;
    }
    const next = {
      ...current,
      ...patch,
      id: String(current.id || sessionId || '').trim() || sessionId,
      updated_at: bumpUpdatedAt ? nowIso() : current.updated_at,
    };
    const ok = this._backend.upsertSession(sessionId, next, { persist: true });
    if (!ok) {
      return null;
    }
    return this._backend.getSession(sessionId);
  }

  // Returns the cached index sessions: summaries only, by reference. Callers
  // that need full session content (messages/turn_events) must use
  // `getSession(id)` / `getMessages(id)` / `getTurnEvents(id)` so we don't
  // bulk-load every per-session file just to enumerate the directory.
  summarize() {
    return this._backend.getIndexSnapshot().sessions || {};
  }

  getSession(sessionId) {
    let session = this._backend.getSession(sessionId);
    if (session && !this._stalePlanAuditSessionIds.has(sessionId)) {
      this._stalePlanAuditSessionIds.add(sessionId);
      try {
        const settled = settleStalePendingPlanDocuments(session);
        if (settled.changed && !this._backend.hasNewerSchema()) {
          const normalized = normalizeShadowSession(sessionId, settled.session);
          if (this._backend.upsertSession(sessionId, normalized, { persist: true, alreadyNormalized: true })) {
            session = normalized;
          } else {
            this._stalePlanAuditSessionIds.delete(sessionId);
          }
        }
      } catch (error) {
        this._stalePlanAuditSessionIds.delete(sessionId);
        this._logger?.('WARN', 'session_shadow_store.stale_plan_settlement_failed', {
          sessionId, message: String(error?.message || error || '').slice(0, 240),
        });
      }
    }
    return session ? normalizeShadowSession(sessionId, session) : null;
  }

  getMessages(sessionId) {
    const session = this.getSession(sessionId);
    return Array.isArray(session && session.messages) ? [...session.messages] : [];
  }

  getSessionMessages(sessionId) {
    return this.getMessages(sessionId);
  }

  getTurnEvents(sessionId) {
    const session = this.getSession(sessionId);
    return Array.isArray(session && session.turn_events) ? [...session.turn_events] : [];
  }

  getSessionTurnEvents(sessionId) {
    return this.getTurnEvents(sessionId);
  }

  getActiveTurn(sessionId) {
    return normalizeActiveTurn(this.getSession(sessionId)?.active_turn);
  }

  upsertSession(sessionId, patch, { bumpUpdatedAt = true, allowCreate = true } = {}) {
    const nextPatch = { ...patch };
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'preferred_model')) {
      nextPatch.preferred_model = normalizePreferredModel(nextPatch.preferred_model);
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'reasoning_effort')) {
      nextPatch.reasoning_effort = normalizeReasoningEffort(nextPatch.reasoning_effort);
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'conversation_mode')) {
      nextPatch.conversation_mode = normalizeConversationMode(nextPatch.conversation_mode);
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'pending_question_batch')) {
      nextPatch.pending_question_batch = normalizePendingQuestionBatch(
        nextPatch.pending_question_batch
      );
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'pending_plan_proposal')) {
      nextPatch.pending_plan_proposal = normalizePendingPlanProposal(
        nextPatch.pending_plan_proposal
      );
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'interactive_sequence_state')) {
      nextPatch.interactive_sequence_state = normalizeInteractiveSequenceState(
        nextPatch.interactive_sequence_state
      );
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'interactive_round_count')) {
      nextPatch.interactive_round_count = normalizeInteractiveRoundCount(
        nextPatch.interactive_round_count
      );
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'plan_mode')) {
      nextPatch.plan_mode = normalizePlanMode(nextPatch.plan_mode);
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'context_preferences')) {
      nextPatch.context_preferences = normalizeContextPreferences(nextPatch.context_preferences);
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'active_turn')) {
      nextPatch.active_turn = normalizeActiveTurn(nextPatch.active_turn);
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'external_edit_hidden_message_ids')) {
      nextPatch.external_edit_hidden_message_ids = normalizeExternalEditHiddenMessageIds(
        nextPatch.external_edit_hidden_message_ids
      );
    }

    return this._withSessionMutation(sessionId, nextPatch, { bumpUpdatedAt, allowCreate });
  }

  appendLocalMessage(sessionId, message, options = {}) {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }
    const normalized = createLocalMessage(
      String(message && message.role ? message.role : 'assistant'),
      message,
      options.model || session.last_model_used || ''
    );
    if (!hasMeaningfulMessageContent(normalized)) {
      return session;
    }
    const messageId = String(normalized.id || '').trim();
    const matches = session.messages.filter((entry) => String(entry?.id || '') === messageId);
    if (matches.length) {
      return matches.length === 1 && messageIntentMatches(matches[0], normalized) ? session : null;
    }

    const nextMessages = [...(session.messages || []), normalized];
    const updated = this.upsertSession(sessionId, {
      messages: nextMessages,
      message_count: nextMessages.length,
      last_message_preview: options.updatePreview === false
        ? session.last_message_preview
        : getPreviewText(normalized, session.last_message_preview || '').slice(0, 160),
      last_model_used: String(options.model || session.last_model_used || ''),
    });
    return updated;
  }

  appendTurnEvents(sessionId, events, options = {}) {
    return appendTurnEventsToSession(this, sessionId, events, options);
  }

  updateMessage(sessionId, messageId, patch = {}) {
    const session = this.getSession(sessionId);
    if (!session || !Array.isArray(session.messages)) {
      return null;
    }

    const targetId = String(messageId || '').trim();
    if (!targetId) {
      return null;
    }
    if (session.messages.filter((message) => String(message?.id || '') === targetId).length !== 1) {
      return null;
    }

    let updated = null;
    const nextMessages = session.messages.map((message) => {
      if (String(message && message.id || '') !== targetId) {
        return message;
      }
      updated = createLocalMessage(
        String(message.role || 'assistant'),
        {
          ...message,
          ...patch,
          id: message.id,
          timestamp: message.timestamp,
        },
        session.last_model_used || ''
      );
      return updated;
    });

    if (!updated) {
      return null;
    }

    return this.upsertSession(sessionId, {
      messages: nextMessages,
      message_count: nextMessages.length,
    });
  }

  // Mirror of ElectronSessionStore.truncateAfterMessage. F2 edit-and-resend flow
  // calls this in lockstep with the primary store so the shadow's listing path
  // stays consistent with truncated history. Returns null on missing session,
  // missing message, or a target that isn't role: 'user'.
  truncateAfterMessage(sessionId, messageId, options = {}) {
    const session = this.getSession(sessionId);
    if (!session || !Array.isArray(session.messages)) {
      return null;
    }
    const targetId = String(messageId || '').trim();
    if (!targetId) {
      return null;
    }
    const targetIndex = session.messages.findIndex(
      (message) => String(message?.id || '') === targetId
    );
    if (targetIndex < 0) {
      return null;
    }
    const targetMessage = session.messages[targetIndex];
    if (!targetMessage || targetMessage.role !== 'user') {
      return null;
    }
    const replaceContent = options.replaceMessageContent;
    const replaceAttachments = options.replaceMessageAttachments;
    const headMessages = session.messages.slice(0, targetIndex);
    let survivingTarget = targetMessage;
    if (typeof replaceContent === 'string' || Array.isArray(replaceAttachments)) {
      const patch = {
        ...targetMessage,
        id: targetMessage.id,
        timestamp: targetMessage.timestamp,
      };
      if (typeof replaceContent === 'string') {
        patch.content = replaceContent;
      }
      if (Array.isArray(replaceAttachments)) {
        patch.attachments = replaceAttachments;
      }
      survivingTarget = createLocalMessage(
        String(targetMessage.role || 'user'),
        patch,
        session.last_model_used || ''
      ) || targetMessage;
    }
    // Both re-anchor modes live in session-turn-events (shared with the
    // primary-store implementation so the two stores cannot drift).
    const { messages: nextMessages, turnEvents: nextTurnEvents } = resolveReanchoredHistory({
      messages: session.messages,
      targetIndex,
      targetId,
      survivingTarget,
      turnEvents: session.turn_events,
      preserveSupersededTurn: options.preserveSupersededTurn,
    });
    const updated = this.upsertSession(sessionId, {
      messages: nextMessages,
      message_count: nextMessages.length,
      last_message_preview: getPreviewText(nextMessages[nextMessages.length - 1], '').slice(0, 160),
      turn_events: nextTurnEvents,
      active_turn: options.preserveActiveTurn === true ? session.active_turn : null,
      ...(Array.isArray(options.externalHiddenMessageIds)
        ? {
            external_edit_hidden_message_ids: normalizeExternalEditHiddenMessageIds(
              options.externalHiddenMessageIds
            ),
          }
        : {}),
    });
    if (!updated) return null;
    return {
      ...updated,
      survivingTurnIds: [...new Set(nextTurnEvents.map((event) => String(event.turn_id || '')).filter(Boolean))],
    };
  }

  prunePersistedPlainMessages(sessionId, clientMessageIds) {
    const session = this.getSession(sessionId);
    if (!session || !Array.isArray(session.messages)) {
      return null;
    }

    const ids = new Set(
      Array.isArray(clientMessageIds)
        ? clientMessageIds.map((value) => String(value || '').trim()).filter(Boolean)
        : []
    );
    if (!ids.size) {
      return session;
    }

    const nextMessages = session.messages.filter((message) => {
      if (!isPlainUserAssistantMessage(message)) {
        return true;
      }
      const clientMessageId = String(message.client_message_id || message.id || '').trim();
      return !ids.has(clientMessageId);
    });

    if (nextMessages.length === session.messages.length) {
      return session;
    }

    return this.upsertSession(sessionId, {
      messages: nextMessages,
      message_count: nextMessages.length,
    });
  }

  setSessionPreferences(sessionId, preferences) {
    if (!preferences || typeof preferences !== 'object') {
      return this.upsertSession(sessionId, {}, { allowCreate: false });
    }
    const patch = {};
    if ('preferred_model' in preferences) {
      patch.preferred_model = preferences.preferred_model;
    }
    if ('reasoning_effort' in preferences) {
      patch.reasoning_effort = preferences.reasoning_effort;
    }
    if ('conversation_mode' in preferences) {
      patch.conversation_mode = preferences.conversation_mode;
    }
    if ('pending_question_batch' in preferences) {
      patch.pending_question_batch = preferences.pending_question_batch;
    }
    if ('pending_plan_proposal' in preferences) {
      patch.pending_plan_proposal = preferences.pending_plan_proposal;
    }
    if ('interactive_sequence_state' in preferences) {
      patch.interactive_sequence_state = preferences.interactive_sequence_state;
    }
    if ('interactive_round_count' in preferences) {
      patch.interactive_round_count = preferences.interactive_round_count;
    }
    if ('plan_mode' in preferences) {
      patch.plan_mode = preferences.plan_mode;
    }
    if ('context_preferences' in preferences) {
      patch.context_preferences = preferences.context_preferences;
    }
    return this.upsertSession(sessionId, patch, { allowCreate: false });
  }

  // `expectedPriorStreamId` is an optional CAS guard (defense-in-depth behind
  // the chat-stream-admission gate): when set, the write is skipped unless the
  // CURRENT active_turn is absent or its stream_id matches. Omitted (default)
  // preserves the historical bare-overwrite behavior for existing callers.
  setActiveTurn(sessionId, activeTurn, { expectedPriorStreamId } = {}) {
    if (
      expectedPriorStreamId
      && !activeTurnPassesStreamCas(this.getActiveTurn(sessionId), expectedPriorStreamId)
    ) {
      return null;
    }
    return this.upsertSession(sessionId, {
      active_turn: normalizeActiveTurn(activeTurn),
    }, {
      bumpUpdatedAt: false,
      allowCreate: false,
    });
  }

  touchActiveTurn(sessionId, match = {}, patch = {}) {
    const current = this.getActiveTurn(sessionId);
    if (!current) {
      return null;
    }
    const activeTurnMatch = normalizeActiveTurnMatch(match);
    if (!activeTurnMatchesRequest(current, activeTurnMatch)) {
      return null;
    }
    return this.upsertSession(sessionId, {
      active_turn: buildTouchedActiveTurn(current, patch),
    }, {
      bumpUpdatedAt: false,
    });
  }

  clearActiveTurn(sessionId, match = {}) {
    const current = this.getActiveTurn(sessionId);
    if (!current) {
      return null;
    }
    const activeTurnMatch = normalizeActiveTurnMatch(match);
    // F-06 containment (parity with ElectronSessionStore.clearActiveTurn):
    // a bare empty match is never a legitimate wildcard — it would clear
    // whichever turn is current regardless of ownership. Refuse it.
    if (!activeTurnClearMatchIsExplicit(activeTurnMatch)) {
      if (this._logger) {
        this._logger('WARN', 'shadow_store.clear_active_turn_refused_empty_match', {
          sessionId,
        });
      }
      return null;
    }
    if (!activeTurnMatchesRequest(current, activeTurnMatch)) {
      return null;
    }
    return this.upsertSession(sessionId, {
      active_turn: null,
    }, {
      bumpUpdatedAt: false,
    });
  }

  // Normalize to a strict boolean: the backend now returns
  // `{ ok: false, reason: 'delete_failed' }` (not bare `false`) when the
  // underlying file removal genuinely failed, so callers of this public
  // surface must not see that object mistaken for a truthy success.
  scrubLinkedSessionReferences(sessionId) {
    const failedSessionIds = [];
    for (const [currentSessionId, summary] of Object.entries(this.summarize())) {
      if (currentSessionId === sessionId) continue;
      const linkedIds = Array.isArray(summary?.linked_session_ids)
        ? summary.linked_session_ids
        : [];
      if (!linkedIds.includes(sessionId)) continue;
      const session = this.getSession(currentSessionId);
      if (!session) continue;
      const updated = this.upsertSession(currentSessionId, {
        linked_session_ids: linkedIds.filter((id) => id !== sessionId),
      }, { allowCreate: false });
      if (!updated) failedSessionIds.push(currentSessionId);
    }
    return { ok: failedSessionIds.length === 0, failedSessionIds };
  }

  setTurnIdentity(sessionId, { session_incarnation, turn_generation } = {}) {
    return this.upsertSession(sessionId, {
      session_incarnation: String(session_incarnation || '').trim(),
      turn_generation: normalizeTurnGeneration(turn_generation),
    }, { bumpUpdatedAt: false, allowCreate: false });
  }

  deleteSession(sessionId, { scrubLinks = true } = {}) {
    const deleted = this._backend.deleteSession(sessionId) === true;
    if (deleted && scrubLinks) this.scrubLinkedSessionReferences(sessionId);
    return deleted;
  }

  // Drain any pending debounced writes synchronously. Call before app shutdown
  // or before reading the file from a different process.
  flush() {
    return this._backend.flush();
  }

  hasPendingWrites() {
    return this._backend.hasPendingWrites();
  }

  flushSession(sessionId) {
    return this._backend.flushSession(sessionId);
  }

  async flushAsync() {
    return this._backend.flushAsync();
  }

  dispose() {
    this._backend.dispose();
  }

  async disposeAsync() {
    await this._backend.disposeAsync();
  }
}

module.exports = {
  MAX_EXTERNAL_EDIT_HIDDEN_MESSAGE_ID_BYTES,
  MAX_EXTERNAL_EDIT_HIDDEN_MESSAGE_IDS,
  MAX_EXTERNAL_EDIT_HIDDEN_MESSAGE_IDS_SERIALIZED_BYTES,
  SessionShadowStore,
  STORE_SCHEMA_VERSION,
  TURN_EVENT_LOG_VERSION,
  normalizeConversationMode,
  normalizeInteractiveSequenceState,
  normalizeInteractiveRoundCount,
  normalizeExternalEditHiddenMessageId,
  normalizeExternalEditHiddenMessageIds,
  normalizeActiveTurn,
  normalizeActiveTurnStatus,
  normalizePendingQuestionBatch,
  normalizeInteractiveRoundRecap,
  normalizeToolCallMetadata,
  normalizeToolResultMetadata,
  normalizeProactiveSuggestionMetadata,
  normalizePlanMode,
  isPlainUserAssistantMessage,
};
