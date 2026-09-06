const crypto = require('crypto');
const {
  createConversationStorePort,
  messageIntentMatches,
} = require('./conversation-store-port');
const {
  normalizeContextPreferences,
} = require('./context-preferences');
const {
  normalizeConversationMode,
  normalizeInteractiveRoundCount,
  normalizeInteractiveSequenceState,
  normalizePendingQuestionBatch,
  normalizePendingPlanProposal,
  normalizePlanMode,
  normalizeMessageFields,
  normalizeSkillInvocationMetadata,
} = require('./message-normalization');
const {
  activeTurnClearMatchIsExplicit,
  activeTurnMatchesRequest,
  activeTurnPassesStreamCas,
  buildTouchedActiveTurn,
  getLocalISODate,
  localIsoDateFromTimestamp,
  normalizeActiveTurn,
  normalizeActiveTurnMatch,
  normalizeActiveTurnStatus,
  normalizePreferredModel,
  normalizeReasoningEffort,
  normalizeSessionStartDate, normalizeToolCategoryOverrides,
} = require('./session-normalizers');
const { buildSessionPreferencesPatch, normalizeRunMode } = require('./session-preferences-patch');
const {
  normalizeCompactionSnapshot,
  retainCompactionSnapshotForMessages,
} = require('./session-compaction-snapshot');
const { normalizeSessionContextUsage } = require('./session-context-usage');
const { buildSessionSummary } = require('./session-summary-projection');
const {
  TURN_EVENT_LOG_VERSION, settleStalePlanDocumentsOnRead,
  appendTurnEventsToSession,
  compactTurnEventsToWholeTurns,
  normalizeAndSortTurnEvents,
  resolveReanchoredHistory,
  truncateTurnEventsAtEditBoundary,
} = require('./session-turn-events');
const {
  SessionStorageBackend,
  deriveSessionsDirectory,
} = require('./session-storage-backend');
const {
  createOfficialImagePluginSession,
  enforcePluginOperationMetadataBudget,
  normalizePluginSession,
  normalizeSessionType,
  sessionAllowsChatSend,
} = require('./session-type');
const {
  LEGACY_MONOLITHIC_MAX_SCHEMA_VERSION,
  STORE_SCHEMA_VERSION,
  migrateStorePayload,
  normalizeBranchOrigin,
  normalizeDiagnosticMetadata,
  normalizeLinkedSessionIds, normalizeLinkedTaskId,
  summarizeMessage,
} = require('./session-store-migrations');
const {
  MAX_FOLLOW_UP_BODY_CHARS,
  MAX_FOLLOW_UP_LABEL_CHARS,
} = require('../shell-config-followups-schema');
// TURN_EVENT_LOG_VERSION and the turn-event append/persist helpers now live in
// ./session-turn-events (imported above and re-exported below); the constant is
// still surfaced from this module for backward compatibility with importers.
const DEFAULT_MAX_TURN_EVENTS_PER_SESSION = 5000;
const DEFAULT_TURN_EVENT_COMPACTION_KEEP = 4000;
// Trailing-edge coalesce window for per-session FileJsonStore instances is
// opt-in: production wiring (services/backend/backend-service.js) passes a
// non-zero writeDebounceMs; tests default to 0 (immediate writes) so they
// don't need to flush before reading back from disk. With the per-session
// split landing in this module, each write is O(one session) regardless of
// total history size, but bursts during streaming (active-turn touches,
// terminal phase) still benefit from coalescing.
const DEFAULT_WRITE_DEBOUNCE_MS = 0;
const COMPOSER_DRAFT_CLIP_MARKER = '\n\n[clipped]';
const MAX_COMPOSER_DRAFT_CHARS = MAX_FOLLOW_UP_LABEL_CHARS + 2 + MAX_FOLLOW_UP_BODY_CHARS;

function normalizeComposerDraft(value) {
  const text = typeof value === 'string' ? value.replace(/\0/g, '').trim() : '';
  return text.length > MAX_COMPOSER_DRAFT_CHARS
    ? `${text.slice(0, MAX_COMPOSER_DRAFT_CHARS - COMPOSER_DRAFT_CLIP_MARKER.length).trimEnd()}${COMPOSER_DRAFT_CLIP_MARKER}`
    : text;
}

function nowIso() {
  return new Date().toISOString();
}

function createSessionId() {
  return `sess_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function clipTitle(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'New Chat';
  }
  return normalized.length > 80 ? `${normalized.slice(0, 77).trim()}...` : normalized;
}

// Non-enumerable sentinel stamped on every normalizeMessage output recording
// the fallback model it was normalized under. normalizeSession can then
// identity-skip re-normalizing a message whose only external dependency
// (fallbackModel) is unchanged, turning the per-chunk-commit message-array
// re-normalization from O(messages) into O(touched messages). The
// property is non-enumerable so it never serializes to disk, never appears in
// JSON/Object.spread, and is invisible to deepEqual.
const NORMALIZED_MESSAGE_MODEL = Symbol('normalizedMessageModel');

function normalizeMessage(input, fallbackModel = '') {
  const normalizedFields = normalizeMessageFields(input, fallbackModel);
  if (!normalizedFields) {
    return null;
  }
  const normalized = {
    ...normalizedFields,
    finalizedAt: input.finalizedAt == null ? null : String(input.finalizedAt),
    interactive_round_recap: input.interactive_round_recap || null,
    skill_invocation: normalizeSkillInvocationMetadata(input.skill_invocation),
  };
  Object.defineProperty(normalized, NORMALIZED_MESSAGE_MODEL, {
    value: String(fallbackModel || ''),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return normalized;
}

function normalizeSession(sessionId, input = {}, { reuseTaggedMessages = false } = {}) {
  const fallbackModel = String(input.last_model_used || '');
  const composerDraft = normalizeComposerDraft(input.composer_draft);
  const normalizedMessages = Array.isArray(input.messages)
    ? input.messages
        .map((message) => (
          // Identity-skip messages already normalized under the same fallback
          // model. Only enabled on the cache-bound mutation path;
          // getSession() keeps reuseTaggedMessages=false so external callers
          // still receive fresh, mutation-isolated message objects.
          reuseTaggedMessages
          && message
          && typeof message === 'object'
          && message[NORMALIZED_MESSAGE_MODEL] === fallbackModel
            ? message
            : normalizeMessage(message, fallbackModel)
        ))
        .filter(Boolean)
    : [];
  const messageList = enforcePluginOperationMetadataBudget(normalizedMessages);
  const requestedTurnEventLogVersion = Number(input.turn_event_log_version || 0);
  const normalizedTurnEventLogVersion = Number.isInteger(requestedTurnEventLogVersion) && requestedTurnEventLogVersion >= 0
    ? requestedTurnEventLogVersion
    : 0;
  const {
    turnEvents,
    maxSeq: maxPersistedTurnEventSeq,
  } = normalizeAndSortTurnEvents(input.turn_events);
  const createdAt = String(input.created_at || nowIso());
  // Schema v18 persists chat or plugin ownership. Legacy image sessions are
  // adopted into the official provider binding during normalization/migration.
  const rawSessionType = String(input.session_type || '').trim().toLowerCase();
  const sessionType = normalizeSessionType(input.session_type);
  const pluginSession = sessionType === 'plugin'
    ? (normalizePluginSession(input.plugin_session)
      || (rawSessionType === 'image' ? createOfficialImagePluginSession(input.image_config) : null))
    : null;
  return {
    id: sessionId,
    title: clipTitle(input.title),
    session_type: sessionType,
    plugin_session: pluginSession,
    ...normalizeDiagnosticMetadata(input),
    created_at: createdAt,
    updated_at: String(input.updated_at || nowIso()),
    message_count: Math.max(Number(input.message_count || messageList.length || 0), 0),
    last_message_preview: String(input.last_message_preview || summarizeMessage(messageList[messageList.length - 1]) || ''),
    last_model_used: String(input.last_model_used || ''),
    session_start_date: normalizeSessionStartDate(input.session_start_date, createdAt),
    preferred_model: normalizePreferredModel(input.preferred_model),
    reasoning_effort: normalizeReasoningEffort(input.reasoning_effort),
    conversation_mode: normalizeConversationMode(input.conversation_mode),
    pending_question_batch: normalizePendingQuestionBatch(input.pending_question_batch),
    pending_plan_proposal: normalizePendingPlanProposal(input.pending_plan_proposal),
    interactive_sequence_state: normalizeInteractiveSequenceState(input.interactive_sequence_state),
    interactive_round_count: normalizeInteractiveRoundCount(input.interactive_round_count),
    plan_mode: normalizePlanMode(input.plan_mode),
    run_mode: normalizeRunMode(input.run_mode, { planModeFallback: normalizePlanMode(input.plan_mode) === true }),
    pre_plan_run_mode: input.pre_plan_run_mode === 'auto' || input.pre_plan_run_mode === 'ask' ? input.pre_plan_run_mode : '',
    lockdown: input.lockdown === true,
    pinned: input.pinned === true,
    archived_at: input.archived_at ? String(input.archived_at) : null,
    context_preferences: normalizeContextPreferences(input.context_preferences),
    tool_category_overrides: normalizeToolCategoryOverrides(input.tool_category_overrides),
    session_incarnation: String(input.session_incarnation || '').trim(),
    turn_generation: Number.isSafeInteger(Number(input.turn_generation))
      && Number(input.turn_generation) >= 0
      ? Number(input.turn_generation)
      : 0,
    active_turn: normalizeActiveTurn(input.active_turn),
    compaction_snapshot: normalizeCompactionSnapshot(input.compaction_snapshot),
    context_usage: normalizeSessionContextUsage(input.context_usage),
    branch_origin: normalizeBranchOrigin(input.branch_origin || input.branchOrigin),
    linked_session_ids: normalizeLinkedSessionIds(
      input.linked_session_ids || input.linkedSessionIds,
      sessionId
    ),
    linked_task_id: normalizeLinkedTaskId(input.linked_task_id),
    ...(composerDraft ? { composer_draft: composerDraft } : {}),
    messages: messageList,
    message_seq_counter: Number(input.message_seq_counter || 0),
    turn_event_log_version: normalizedTurnEventLogVersion,
    turn_event_seq_counter: Math.max(
      Number(input.turn_event_seq_counter || 0),
      maxPersistedTurnEventSeq + 1,
      0
    ),
    turn_events: turnEvents,
  };
}

// Concurrency contract: final session mutations route through one helper so
// normalization, compaction, and persistence writes stay centralized.
class ElectronSessionStore {
  constructor(filePath, {
    shellConfigService = null,
    logger = null,
    maxTurnEventsPerSession = DEFAULT_MAX_TURN_EVENTS_PER_SESSION,
    turnEventCompactionKeep = DEFAULT_TURN_EVENT_COMPACTION_KEEP,
    writeDebounceMs = DEFAULT_WRITE_DEBOUNCE_MS,
  } = {}) {
    this.filePath = filePath;
    this._logger = typeof logger === 'function' ? logger : null;
    this._maxTurnEventsPerSession = DEFAULT_MAX_TURN_EVENTS_PER_SESSION;
    this._turnEventCompactionKeep = DEFAULT_TURN_EVENT_COMPACTION_KEEP;
    this.configureCompaction({ maxTurnEventsPerSession, turnEventCompactionKeep });
    const sessionsDir = deriveSessionsDirectory(filePath);
    this._backend = new SessionStorageBackend(sessionsDir, {
      legacyMonolithicPath: filePath,
      schemaVersion: STORE_SCHEMA_VERSION,
      legacyMaxSchemaVersion: LEGACY_MONOLITHIC_MAX_SCHEMA_VERSION,
      migratePayload: (payload) => migrateStorePayload(payload, { normalizeMessage }),
      normalizeSession: (id, record) => normalizeSession(id, record),
      summarizeSession: (session) => this._toSummary(session),
      writeDebounceMs,
      logger: this._logger,
      storeName: 'session_store',
    });
    this.turnEventLogVersion = TURN_EVENT_LOG_VERSION;
    this.conversationStore = createConversationStorePort(this, { kind: 'electron' });
    this.shellConfigService = shellConfigService;
  }

  // Test-injection seam: tests override `store.store.write` to simulate disk
  // failures. The legacy backend exposed a single FileJsonStore; the split
  // backend exposes the index store here so the same override pattern still
  // produces a `session_store.write_failed` log without updating the cache.
  get store() {
    return this._backend._indexStore;
  }

  configureCompaction({
    maxTurnEventsPerSession = DEFAULT_MAX_TURN_EVENTS_PER_SESSION,
    turnEventCompactionKeep = DEFAULT_TURN_EVENT_COMPACTION_KEEP,
  } = {}) {
    const maxEvents = Math.max(0, Math.floor(Number(maxTurnEventsPerSession) || 0));
    const keepEvents = Math.max(0, Math.floor(Number(turnEventCompactionKeep) || 0));
    this._maxTurnEventsPerSession = maxEvents || DEFAULT_MAX_TURN_EVENTS_PER_SESSION;
    this._turnEventCompactionKeep = Math.min(
      keepEvents || DEFAULT_TURN_EVENT_COMPACTION_KEEP,
      this._maxTurnEventsPerSession
    );
  }

  // Compatibility shim for services/backend/session-store-mirror.js. Returns
  // the cached index: `getIndexSnapshot()` already returns a fresh sessions
  // map whose values are summary objects by reference, so a caller that adds
  // a new entry without touching existing entries can pass the same payload
  // back through `_write()` and the diff will write only the new entry. Don't
  // reach into existing entries' `messages`/`turn_events` through this;
  // those live in per-session files and are not loaded eagerly.
  _read() {
    return this._backend.getIndexSnapshot();
  }

  // Compatibility shim for session-store-mirror's "insert a new session"
  // pattern. Diffs `payload.sessions` against the cached index by reference:
  // unchanged entries (same reference as cache) are skipped; new or replaced
  // entries are upserted; missing entries are deleted. This keeps mirror's
  // single-session add fast (O(1) upsert) instead of rewriting every session.
  _write(payload, { persist = true } = {}) {
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
      this._backend.upsertSession(incomingId, incomingValue, { persist });
    }
  }

  _withSessionMutation(sessionId, patch, { bumpUpdatedAt = true, persist = true } = {}) {
    // `current` comes straight from the backend cache, which already holds a
    // canonical normalizeSession() object and is only read by the spread below.
    const current = this._backend.getSession(sessionId);
    if (!current) {
      return null;
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return null;
    }
    // Reuse already-normalized (tagged) message objects so an active turn's
    // repeated patches don't re-walk the entire message array each commit, and
    // tell the backend the record is already canonical so it skips a fourth
    // normalize.
    const next = normalizeSession(sessionId, {
      ...current,
      ...patch,
      updated_at: bumpUpdatedAt ? nowIso() : current.updated_at,
    }, { reuseTaggedMessages: true });
    const ok = this._backend.upsertSession(sessionId, next, { persist, alreadyNormalized: true });
    if (!ok) {
      return null;
    }
    return this._toSummary(next);
  }

  flush() {
    return this._backend.flush();
  }

  hasPendingWrites() {
    return this._backend.hasPendingWrites();
  }

  // Force one session's cached record to disk immediately; true only when the
  // bytes landed. Used by the turn-event persistence path to confirm durability
  // before the crash-recovery journal is cleared.
  flushSession(sessionId) {
    return this._backend.flushSession(sessionId);
  }

  async flushAsync() {
    return this._backend.flushAsync();
  }

  // True when an on-disk schema newer than this build froze all writes —
  // callers use this to diagnose a refused append as `future_schema`.
  hasNewerSchema() {
    return this._backend.hasNewerSchema();
  }

  hasPendingMigrations() {
    return this._backend.hasPendingMigrations();
  }

  async runPendingMigrations(options = {}) {
    return this._backend.runPendingMigrations(options);
  }

  dispose() {
    this._backend.dispose();
  }

  async disposeAsync() {
    await this._backend.disposeAsync();
  }

  listSessions() {
    const indexSessions = this._backend.getIndexSnapshot().sessions || {};
    const summaries = Object.values(indexSessions);
    summaries.sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')));
    return summaries.map((summary) => ({
      ...summary,
      ...normalizeDiagnosticMetadata(summary),
      linked_task_id: normalizeLinkedTaskId(summary?.linked_task_id),
      branch_origin: normalizeBranchOrigin(summary?.branch_origin || summary?.branchOrigin),
    }));
  }

  // Bulk lifecycle surface (companion Home state, managed-sidecar active-turn
  // reconciliation): index summaries plus `active_turn` from the backend's
  // scan registry. Never loads message bodies and never touches the backend
  // session LRU — the previous per-id getSession() walk reloaded and evicted
  // the whole 30-slot cache (hot active session included) on every pass.
  listSessionRecords() {
    const activeTurns = this._backend.getActiveTurnSnapshots();
    return this.listSessions().map((summary) => ({
      ...summary,
      active_turn: normalizeActiveTurn(activeTurns.get(summary.id)),
    }));
  }

  // Cache-neutral full-record read for bulk scans (attachment-asset sweep).
  // Returns the backend's canonical record: treat as READ-ONLY — unlike
  // getSession() there is no isolating re-normalize copy.
  peekSession(sessionId) {
    return this._backend.peekSession(sessionId);
  }

  getSessionIds() {
    return this._backend.getSessionIds();
  }

  // `sessionType` / `imageConfig` are the schema-v17 opt-in (contract C2):
  // omitting them — which every existing caller does — creates a chat session
  // exactly as before, and `imageConfig` is dropped unless the type is 'image'.
  createSession({ title, preferences, sessionType, pluginSession, imageConfig, composerDraft, linkedTaskId } = {}) {
    const sessionId = createSessionId();
    return this._createSessionRecord(sessionId, {
      title, preferences, sessionType, pluginSession, imageConfig, composerDraft, linkedTaskId,
    });
  }

  createSessionWithId(sessionId, {
    title, preferences, sessionType, pluginSession, imageConfig,
  } = {}) {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) {
      return null;
    }
    return this._createSessionRecord(normalizedSessionId, {
      title,
      preferences,
      sessionType,
      pluginSession,
      imageConfig,
    });
  }

  _createSessionRecord(sessionId, {
    title, preferences, sessionType, pluginSession, imageConfig, composerDraft, linkedTaskId,
  } = {}) {
    const createdAt = nowIso();
    const rawSessionType = String(sessionType || '').trim().toLowerCase();
    const normalizedType = normalizeSessionType(rawSessionType);
    const normalizedPluginSession = normalizedType === 'plugin'
      ? (normalizePluginSession(pluginSession)
        || (rawSessionType === 'image' ? createOfficialImagePluginSession(imageConfig) : null))
      : null;
    if (normalizedType === 'plugin' && !normalizedPluginSession) return null;
    const session = normalizeSession(sessionId, {
      title: clipTitle(title),
      session_type: normalizedType,
      plugin_session: normalizedPluginSession,
      session_start_date: normalizeSessionStartDate(
        preferences && preferences.session_start_date,
        createdAt
      ),
      ...this._preferencesPatch(preferences),
      created_at: createdAt,
      updated_at: createdAt,
      session_incarnation: `inc_${crypto.randomUUID().replace(/-/g, '')}`,
      ...(composerDraft ? { composer_draft: composerDraft } : {}),
      ...(linkedTaskId ? { linked_task_id: linkedTaskId } : {}),
      messages: [],
    });
    const ok = this._backend.upsertSession(sessionId, session, { persist: true });
    if (!ok) {
      // The backend refused the write (newer-schema read-only mode) and did
      // not cache the record: returning a summary here would fabricate a
      // session that getSession() cannot find.
      return null;
    }
    return this._toSummary(session);
  }

  getSession(sessionId) {
    const session = settleStalePlanDocumentsOnRead({ backend: this._backend, logger: this._logger, sessionId, session: this._backend.getSession(sessionId), normalizeSession });
    return session ? normalizeSession(sessionId, session) : null;
  }

  getSessionMessages(sessionId) {
    const session = this.getSession(sessionId);
    return session ? [...session.messages] : [];
  }

  // Lookup-only message view. getSessionMessages() goes through
  // getSession(), re-normalizing every message and normalizing + sorting the
  // whole turn_events log just to hand back an array the caller scans for one
  // id. The backend cache is already canonical, so copying the array is enough
  // to isolate array identity; message objects are shared BY REFERENCE and must
  // only be read (write paths replace messages, never mutate them). Callers
  // needing mutation isolation or turn_events must use getSessionMessages().
  peekSessionMessages(sessionId) {
    const session = this._backend.getSession(sessionId);
    return session ? [...session.messages] : [];
  }

  getSessionTurnEvents(sessionId) {
    const session = this.getSession(sessionId);
    return session ? [...session.turn_events] : [];
  }

  getActiveTurn(sessionId) {
    return normalizeActiveTurn(this.getSession(sessionId)?.active_turn);
  }

  renameSession(sessionId, title) {
    return this.updateSession(sessionId, { title: clipTitle(title) });
  }

  scrubLinkedSessionReferences(sessionId) {
    const failedSessionIds = [];
    const indexSessions = this._backend.getIndexSnapshot().sessions || {};
    for (const [currentSessionId, summary] of Object.entries(indexSessions)) {
      if (currentSessionId === sessionId) continue;
      const linkedIds = Array.isArray(summary.linked_session_ids)
        ? summary.linked_session_ids
        : [];
      if (!linkedIds.includes(sessionId)) continue;
      const session = this._backend.getSession(currentSessionId);
      if (!session) continue;
      const next = normalizeSession(currentSessionId, {
        ...session,
        linked_session_ids: normalizeLinkedSessionIds(
          session.linked_session_ids,
          currentSessionId
        ).filter((linkedSessionId) => linkedSessionId !== sessionId),
      });
      if (this._backend.upsertSession(currentSessionId, next, { persist: true }) !== true) {
        failedSessionIds.push(currentSessionId);
      }
    }
    return { ok: failedSessionIds.length === 0, failedSessionIds };
  }

  // JCA-003 manual-compaction snapshot: pass null to clear. History-rewrite
  // mutations below invalidate it eagerly via retainCompactionSnapshotForMessages.
  setCompactionSnapshot(sessionId, snapshot) {
    return this._updateSessionRecord(sessionId, {
      compaction_snapshot: normalizeCompactionSnapshot(snapshot),
    }, {
      bumpUpdatedAt: false,
    });
  }

  // Last authoritative terminal context reading (composer-ring cold-reopen
  // seed). Pass null to clear. History-rewrite mutations below drop it.
  setSessionContextUsage(sessionId, record) {
    return this._updateSessionRecord(sessionId, {
      context_usage: normalizeSessionContextUsage(record),
    }, {
      bumpUpdatedAt: false,
    });
  }

  setTurnIdentity(sessionId, { session_incarnation, turn_generation } = {}) {
    return this.updateSession(sessionId, {
      session_incarnation: String(session_incarnation || '').trim(),
      turn_generation: Number(turn_generation),
    });
  }

  deleteSession(sessionId, { scrubLinks = true } = {}) {
    if (!this._backend.hasSession(sessionId)) {
      return false;
    }
    // The backend now returns a non-boolean failure shape
    // (`{ ok: false, reason: 'delete_failed' }`) when the underlying file
    // removal genuinely failed, so a bare truthiness check would let that
    // object slip through as "removed". Require the literal success value.
    const removed = this._backend.deleteSession(sessionId);
    if (removed !== true) {
      return false;
    }
    if (scrubLinks) {
      const scrubbed = this.scrubLinkedSessionReferences(sessionId);
      if (!scrubbed.ok) {
        this._logger?.('WARN', 'session_store.link_scrub_degraded', {
          sessionId,
          failedCount: scrubbed.failedSessionIds.length,
        });
      }
    }
    if (
      this.shellConfigService
      && typeof this.shellConfigService.updateWorkspaceState === 'function'
      && typeof this.shellConfigService.getWorkspaceState === 'function'
    ) {
      const workspace = this.shellConfigService.getWorkspaceState();
      this.shellConfigService.updateWorkspaceState({
        activeSessionId: workspace.activeSessionId === sessionId ? null : workspace.activeSessionId,
        openSessionIds: workspace.openSessionIds.filter((openSessionId) => openSessionId !== sessionId),
      });
    }
    return true;
  }

  setSessionPreferences(sessionId, preferences = {}) {
    return this.updateSession(sessionId, this._preferencesPatch(preferences, this.getSession(sessionId) || {}));
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
    return this._updateSessionRecord(sessionId, {
      active_turn: normalizeActiveTurn(activeTurn),
    }, {
      bumpUpdatedAt: false,
    });
  }

  touchActiveTurn(sessionId, match = {}, patch = {}) {
    // Read the cached canonical record directly. Routing through
    // getSession() here re-normalized the entire message array on every ~1Hz
    // progress touch even though only active_turn changes.
    const sessionRecord = this._backend.getSession(sessionId);
    const current = normalizeActiveTurn(sessionRecord?.active_turn);
    if (!current) {
      return null;
    }
    const activeTurnMatch = normalizeActiveTurnMatch(match);
    if (!activeTurnMatchesRequest(current, activeTurnMatch)) {
      return null;
    }
    const next = buildTouchedActiveTurn(current, patch);
    // Cache-only fast path: only active_turn changes, so build a shallow session
    // copy that shares the unchanged messages/turn_events arrays and skip the
    // full message-array re-normalization entirely. normalizeActiveTurn
    // keeps the small active_turn object canonical, and alreadyNormalized tells
    // the backend the record is already in normalized shape.
    //
    // Progress touches happen ~1/sec during streaming; skipping disk here means
    // even the O(one session) write doesn't run on every notification. The next
    // persisting write (clearActiveTurn, appendMessage, setSessionPreferences,
    // etc.) flushes the touch state along with its own changes. Crash recovery
    // loses up to one write window of progress markers; setActiveTurn /
    // clearActiveTurn brackets are still persisted so resume detection works.
    const nextSession = {
      ...sessionRecord,
      active_turn: normalizeActiveTurn(next),
    };
    const ok = this._backend.upsertSession(sessionId, nextSession, {
      persist: false,
      alreadyNormalized: true,
    });
    if (!ok) {
      return null;
    }
    return this._toSummary(nextSession);
  }

  clearActiveTurn(sessionId, match = {}) {
    const session = this.getSession(sessionId);
    const current = normalizeActiveTurn(session?.active_turn);
    if (!current) {
      return null;
    }
    const activeTurnMatch = normalizeActiveTurnMatch(match);
    // F-06 containment: every production caller supplies turn identity, so a
    // bare empty match (both ids blank) is never a legitimate "clear
    // whoever's turn is current" wildcard — it is a bug that would otherwise
    // unconditionally clear a session's active_turn regardless of which turn
    // actually owns it. Refuse it as a validation error rather than silently
    // clearing.
    if (!activeTurnClearMatchIsExplicit(activeTurnMatch)) {
      if (this._logger) {
        this._logger('WARN', 'session_store.clear_active_turn_refused_empty_match', {
          sessionId,
        });
      }
      return null;
    }
    if (!activeTurnMatchesRequest(current, activeTurnMatch)) {
      return null;
    }
    return this._updateSessionRecord(sessionId, {
      active_turn: null,
    }, {
      bumpUpdatedAt: false,
    });
  }

  appendMessage(sessionId, message, { updatePreview = true } = {}) {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }
    const messageId = String(message?.id || '').trim();
    if (messageId) {
      const matches = session.messages.filter((entry) => String(entry?.id || '') === messageId);
      if (matches.length) {
        return matches.length === 1 && messageIntentMatches(matches[0], message)
          ? this._toSummary(session)
          : null;
      }
    }
    // Assign a monotonic event_seq so new messages carry an explicit ordering
    // anchor independent of their array position. The effective seq is at least
    // session.messages.length so that messages appended to a legacy session
    // (one loaded from disk without a stored counter) always sort after all
    // existing messages, whose projector message_index values are 0..N-1.
    const effectiveSeq = Math.max(
      Number(session.message_seq_counter) || 0,
      session.messages.length
    );
    const normalized = normalizeMessage(
      { ...message, event_seq: effectiveSeq },
      session.last_model_used || ''
    );
    if (!normalized) {
      return null;
    }
    const messages = [...session.messages, normalized];
    return this.updateSession(sessionId, {
      messages,
      message_count: messages.length,
      message_seq_counter: effectiveSeq + 1,
      last_message_preview: updatePreview
        ? summarizeMessage(normalized) || session.last_message_preview
        : session.last_message_preview,
      last_model_used: String(normalized.model_used || session.last_model_used || ''),
      composer_draft: '',
    });
  }

  updateMessage(sessionId, messageId, patch = {}) {
    // The cached canonical record avoids full-array normalization before the
    // target lookup. messages.map produces a new array, and
    // _withSessionMutation reuses tagged unchanged messages, so only the patched
    // message is normalized.
    const session = this._backend.getSession(sessionId);
    if (!session) {
      return null;
    }
    const targetId = String(messageId || '').trim();
    if (!targetId) {
      return null;
    }
    if (session.messages.filter((message) => String(message.id || '') === targetId).length !== 1) {
      return null;
    }
    let updatedMessage = null;
    const messages = session.messages.map((message) => {
      if (String(message.id || '') !== targetId) {
        return message;
      }
      updatedMessage = normalizeMessage(
        {
          ...message,
          ...patch,
          id: message.id,
          timestamp: message.timestamp,
        },
        session.last_model_used || ''
      );
      return updatedMessage;
    });
    if (!updatedMessage) {
      return null;
    }
    // JCA-003: an in-place edit INSIDE the snapshot's summarized prefix stales
    // the summary even though the (count, boundary-id) check still passes —
    // ids and length are unchanged. Reaction-marker-only patches don't alter
    // what was summarized, so they keep the snapshot.
    const compactionStaled = session.compaction_snapshot
      && session.messages.findIndex((message) => String(message.id || '') === targetId)
        < session.compaction_snapshot.boundary_message_count
      && Object.keys(patch).some((key) => key !== 'message_reactions');
    return this.updateSession(sessionId, {
      messages,
      message_count: messages.length,
      last_message_preview: session.last_message_preview,
      ...(compactionStaled ? { compaction_snapshot: null } : {}),
    });
  }

  replaceMessages(sessionId, messages) {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }
    const normalizedMessages = Array.isArray(messages)
      ? messages.map((message) => normalizeMessage(message, session.last_model_used || '')).filter(Boolean)
      : [];
    const lastMessage = normalizedMessages[normalizedMessages.length - 1] || null;
    return this.updateSession(sessionId, {
      messages: normalizedMessages,
      message_count: normalizedMessages.length,
      last_message_preview: summarizeMessage(lastMessage) || '',
      last_model_used: String(lastMessage && lastMessage.model_used || session.last_model_used || ''),
      compaction_snapshot: retainCompactionSnapshotForMessages(
        session.compaction_snapshot,
        normalizedMessages
      ),
      // The seed measured a history that no longer exists.
      context_usage: null,
    });
  }

  // Truncate session history after a target user message. Used by the F2 edit-and-resend
  // flow: rewrites the messages list to end at the edited prompt and drops every turn_event
  // belonging to turns whose messages no longer survive. Returns null on missing session,
  // missing message, or a target that isn't role: 'user'. Preserves the target message's
  // id, timestamp, event_seq, and client_message_id so DOM addressability + memory refs
  // survive. Seq counters are NOT reset; future appends keep monotonic order.
  truncateAfterMessage(sessionId, messageId, options = {}) {
    const session = this.getSession(sessionId);
    if (!session) {
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
    const replaceSkillInvocation = options.replaceMessageSkillInvocation;
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
      if (replaceSkillInvocation !== undefined) patch.skill_invocation = replaceSkillInvocation;
      const normalized = normalizeMessage(patch, session.last_model_used || '');
      survivingTarget = normalized || targetMessage;
    }
    // Both re-anchor modes live in session-turn-events, shared with the
    // shadow-store mirror so the two stores cannot drift.
    const { messages: nextMessages, turnEvents: nextTurnEvents, snapshotBasis } = resolveReanchoredHistory({
      messages: session.messages,
      targetIndex,
      targetId,
      survivingTarget,
      turnEvents: session.turn_events,
      preserveSupersededTurn: options.preserveSupersededTurn,
      targetUnchanged: survivingTarget === targetMessage,
    });
    const updated = this.updateSession(sessionId, {
      messages: nextMessages,
      message_count: nextMessages.length,
      last_message_preview: summarizeMessage(nextMessages[nextMessages.length - 1]) || '',
      turn_events: nextTurnEvents,
      active_turn: options.preserveActiveTurn === true ? session.active_turn : null,
      // Edit-and-resend rewrote history: a snapshot whose summarized prefix no
      // longer survives (including an edited boundary message) must not leak
      // into future sends (JCA-003 invalidation).
      // JCA-003: which list the snapshot must still cover is decided by the
      // re-anchor mode, so the helper answers it alongside the other two.
      compaction_snapshot: retainCompactionSnapshotForMessages(session.compaction_snapshot, snapshotBasis),
      // Truncate and edit-and-resend both shorten/rewrite the measured history,
      // so the persisted context reading would over-report on a cold reopen.
      context_usage: null,
    });
    if (!updated) return null;
    return {
      ...updated,
      survivingTurnIds: [...new Set(nextTurnEvents.map((event) => String(event.turn_id || '')).filter(Boolean))],
    };
  }

  // CTL-010: whole-turn boundary rule lives in session-turn-events (sibling
  // to the CTL-001 truncation helper) so the never-bisect-a-turn contract has
  // a single owner.
  _compactTurnEvents(sessionId, turnEvents) {
    const result = compactTurnEventsToWholeTurns({
      sessionId,
      turnEvents,
      maxEvents: this._maxTurnEventsPerSession,
      keepEvents: Number(this._turnEventCompactionKeep) || DEFAULT_TURN_EVENT_COMPACTION_KEEP,
    });
    if (result.compacted && this._logger) {
      this._logger('WARN', 'session_store.turn_events_compacted', {
        sessionId,
        compactedCount: result.compactedEventCount,
        compactedTurnCount: result.compactedTurnCount,
        retainedCount: result.turnEvents.length - 1,
      });
    }
    return result.turnEvents;
  }

  // Appends turn events and returns the STRUCTURED durability result
  // { ok, appended, duplicateCount, reason }. The full contract (ok:false
  // reasons, the durable-flush-before-ok semantics, and the journal-safety
  // rationale) lives with appendTurnEventsToSession in ./session-turn-events.
  appendTurnEvents(sessionId, events, options = {}) {
    return appendTurnEventsToSession(this, sessionId, events, options);
  }

  updateSession(sessionId, patch = {}) {
    return this._updateSessionRecord(sessionId, patch, {
      bumpUpdatedAt: true,
    });
  }

  // Pin/archive metadata is intentionally NOT routed through preferences:
  // setSessionPreferences bumps updated_at, and a pin that re-sorts the
  // session to the top of the recents list would defeat the point. The
  // title key serves the renderer's auto-title/backfill the same way —
  // renameSession stays the bumping path for deliberate user renames.
  setSessionMeta(sessionId, meta = {}) {
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(meta, 'pinned')) {
      patch.pinned = meta.pinned === true;
    }
    if (Object.prototype.hasOwnProperty.call(meta, 'archived_at')) {
      patch.archived_at = meta.archived_at ? String(meta.archived_at) : null;
    }
    if (String(meta.title || '').trim()) {
      patch.title = clipTitle(meta.title);
    }
    if (!Object.keys(patch).length) {
      const session = this._backend.getSession(sessionId);
      return session ? this._toSummary(session) : null;
    }
    return this._updateSessionRecord(sessionId, patch, { bumpUpdatedAt: false });
  }

  sweepEmptySessions({ dryRun = false, currentSessionId = null } = {}) {
    const indexSessions = this._backend.getIndexSnapshot().sessions || {};
    const candidateIds = [];
    for (const [sessionId, summary] of Object.entries(indexSessions)) {
      if (sessionId === currentSessionId) continue;
      if (summary.pinned === true) continue;
      if (Number(summary.message_count || 0) > 0) continue;
      const title = String(summary.title || '').trim();
      if (title && title !== 'New Chat') continue;
      candidateIds.push(sessionId);
    }
    if (dryRun) {
      return { candidateIds, deleted: 0 };
    }
    let deleted = 0;
    for (const sessionId of candidateIds) {
      if (this.deleteSession(sessionId)) deleted += 1;
    }
    return { candidateIds, deleted };
  }

  _updateSessionRecord(sessionId, patch = {}, { bumpUpdatedAt = true, persist = true } = {}) {
    return this._withSessionMutation(sessionId, patch, { bumpUpdatedAt, persist });
  }

  _preferencesPatch(preferences = {}, record = {}) {
    return buildSessionPreferencesPatch(preferences, record);
  }

  // Field allowlist lives in ./session-summary-projection.
  _toSummary(session) {
    const summary = buildSessionSummary(session);
    return session?.composer_draft ? { ...summary, composer_draft: session.composer_draft } : summary;
  }
}

module.exports = {
  ElectronSessionStore,
  STORE_SCHEMA_VERSION,
  clipTitle,
  createSessionId,
  deriveSessionsDirectory,
  getLocalISODate,
  localIsoDateFromTimestamp,
  normalizeBranchOrigin,
  normalizeLinkedSessionIds,
  normalizeActiveTurn,
  normalizeActiveTurnStatus,
  normalizeCompactionSnapshot,
  normalizeMessage,
  normalizeSessionStartDate,
  normalizeSession,
  // Session-type surface re-exported for chat admission.
  normalizeSessionType,
  sessionAllowsChatSend,
  TURN_EVENT_LOG_VERSION,
};
