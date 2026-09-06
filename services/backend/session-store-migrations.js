// v1..v19 migration chain for the Electron session store payload.
//
// Each repair function takes a single session record and returns the upgraded
// version. `migrateStorePayload` runs the chain over every session in a
// monolithic payload, bumps `schema_version`, and returns the migrated payload
// untouched on disk (the caller decides whether to persist).
//
// `normalizeStorePayload` is the entry point used by the storage backend:
// runs the migrations and returns a clean payload with the current
// `STORE_SCHEMA_VERSION` shape. The shape is layout-agnostic: the caller
// places the result on disk in whatever layout (monolithic or per-session)
// it owns.

const {
  normalizeActiveTurn,
  normalizeToolCategoryOverrides,
} = require('./session-normalizers');
const {
  normalizeMessageReactions,
} = require('./message-normalization');
const {
  normalizeCompactionSnapshot,
} = require('./session-compaction-snapshot');
const {
  normalizeContextPreferences,
} = require('./context-preferences');
const {
  createOfficialImagePluginSession,
  enforcePluginOperationMetadataBudget,
  normalizePluginOperationMetadata,
  normalizePluginSession,
  normalizeSessionImageConfig,
  normalizeSessionType,
} = require('./session-type');

const STALE_PENDING_APPROVAL_TERMINAL_STATE = 'cancelled';

// v10 recorded the split sessions/<id>.json layout. v11 adds explicit branch
// lineage metadata on session records. v12 adds message reaction markers.
// v13 adds first-class diagnostic-session metadata used by frontier diagnostics.
// v14 compacts reasoning_phase turn-event bloat from sessions persisted before
// 2026-06-11 (pre-0a54288 capture emitted one event per delta instead of one
// per phase). v15 adds durable session-incarnation and turn-generation fences.
// v16 adds the Electron-owned manual-compaction snapshot (JCA-003): a
// versioned compacted-history prefix substitute consumed by chat.send.
// v17 added core image sessions. v18 replaces those with generic plugin
// sessions and a bounded provider binding while retaining readable history.
// v19 retires research context and upgrades compaction snapshots to the
// bounded origin-aware v2 contract. v20 adds bounded per-session tool
// category overrides.
const STORE_SCHEMA_VERSION = 20;
// The highest schema version that lived in the legacy monolithic sessions.json
// file. Anything <= this number triggers a monolithic -> split migration on
// first read.
const LEGACY_MONOLITHIC_MAX_SCHEMA_VERSION = 9;
const DIAGNOSTIC_METADATA_MAX_CHARS = 120;

function normalizeLinkedSessionIds(value, sessionId = '') {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalizedSessionId = String(sessionId || '').trim();
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const linkedSessionId = String(entry || '').trim();
    if (!linkedSessionId || linkedSessionId === normalizedSessionId || seen.has(linkedSessionId)) {
      continue;
    }
    seen.add(linkedSessionId);
    result.push(linkedSessionId);
  }
  return result;
}

function normalizeLinkedTaskId(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/u.test(normalized) ? normalized : '';
}

function normalizeIsoTimestamp(value) {
  const timestamp = String(value || '').trim();
  if (!timestamp) {
    return '';
  }
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function normalizeBranchOrigin(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!source) {
    return null;
  }
  const sourceSessionId = String(source.source_session_id || source.sourceSessionId || '').trim();
  const sourceMessageId = String(source.source_message_id || source.sourceMessageId || '').trim();
  const createdAt = normalizeIsoTimestamp(source.created_at || source.createdAt);
  if (!sourceSessionId || !sourceMessageId || !createdAt) {
    return null;
  }
  return {
    source_session_id: sourceSessionId,
    source_message_id: sourceMessageId,
    source_title: String(source.source_title || source.sourceTitle || '').trim(),
    created_at: createdAt,
  };
}

function normalizeDiagnosticMetadataValue(value) {
  const normalized = String(value ?? '')
    // eslint-disable-next-line no-control-regex -- session metadata sanitizer intentionally strips C0 controls.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > DIAGNOSTIC_METADATA_MAX_CHARS
    ? normalized.slice(0, DIAGNOSTIC_METADATA_MAX_CHARS).trim()
    : normalized;
}

function normalizeDiagnosticMetadata(source = {}) {
  const session = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  return {
    diagnostic_mode: normalizeDiagnosticMetadataValue(session.diagnostic_mode),
    diagnostic_run_id: normalizeDiagnosticMetadataValue(session.diagnostic_run_id),
    diagnostic_provider: normalizeDiagnosticMetadataValue(session.diagnostic_provider),
    diagnostic_model: normalizeDiagnosticMetadataValue(session.diagnostic_model),
  };
}

function summarizeMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return '';
  }
  const content = String(message.content || '').trim();
  if (content) {
    return content.slice(0, 160);
  }
  if (message.kind === 'tool_use' && message.tool_call) {
    return String(message.tool_call.summary || message.tool_call.tool_name || '').slice(0, 160);
  }
  if (message.kind === 'tool_result' && message.tool_result) {
    return String(message.tool_result.summary || message.tool_result.tool_name || '').slice(0, 160);
  }
  return '';
}

function migrateAssistantTerminalStatus(message) {
  const source = message && typeof message === 'object' && !Array.isArray(message) ? message : null;
  if (!source) {
    return message;
  }
  if (String(source.role || '').trim() !== 'assistant') {
    return message;
  }
  if (String(source.kind || '').trim() === 'question_batch') {
    return message;
  }
  const status = String(source.status || '').trim().toLowerCase();
  if (!status || status !== 'error') {
    return message;
  }
  const streamError = String(source.stream_error || '').trim().toLowerCase();
  const errorCode = String(source.error_code || '').trim().toLowerCase();
  const category = String(source.category || '').trim().toLowerCase();
  let nextStatus = 'runtime_error';
  let terminalSubcode = 'unhandled_exception';
  if (
    category === 'denied'
    || streamError.includes('denied')
    || errorCode.includes('denied')
  ) {
    nextStatus = 'denied';
    terminalSubcode = '';
  } else if (
    category === 'cancelled'
    || streamError.includes('cancelled')
    || streamError.includes('approval cancelled')
    || streamError.includes('stale pending approval')
    || streamError.includes('pending approval repair')
    || errorCode.includes('cancelled')
    || errorCode.includes('stale_pending_approval')
  ) {
    nextStatus = 'cancelled';
    terminalSubcode = '';
  }
  return {
    ...source,
    status: nextStatus,
    ...(terminalSubcode ? { terminal_subcode: terminalSubcode } : {}),
  };
}

function dedupeMessagesByIdKeepLatest(messages) {
  const source = Array.isArray(messages) ? messages : [];
  if (!source.length) {
    return [];
  }
  const latestIndexById = new Map();
  source.forEach((message, index) => {
    const id = String(message && message.id || '').trim();
    if (id) {
      latestIndexById.set(id, index);
    }
  });
  return source.filter((message, index) => {
    const id = String(message && message.id || '').trim();
    if (!id) {
      return true;
    }
    return latestIndexById.get(id) === index;
  });
}

function repairStalePendingApprovalToolUse(messages) {
  const source = Array.isArray(messages) ? messages : [];
  if (!source.length) {
    return [];
  }
  const completedCallIds = new Set(
    source
      .filter((message) => String(message?.kind || '').trim() === 'tool_result')
      .map((message) => String(message?.tool_result?.call_id || '').trim())
      .filter(Boolean)
  );
  return source.map((message) => {
    if (String(message?.kind || '').trim() !== 'tool_use') {
      return message;
    }
    const toolCall = message?.tool_call;
    if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) {
      return message;
    }
    const status = String(toolCall.status || '').trim();
    const approvalState = String(toolCall.approval_state || '').trim();
    const isPendingApproval = status === 'pending_approval' || approvalState === 'pending';
    if (!isPendingApproval) {
      return message;
    }
    const callId = String(toolCall.call_id || '').trim();
    if (callId && completedCallIds.has(callId)) {
      return message;
    }
    return {
      ...message,
      tool_call: {
        ...toolCall,
        status: STALE_PENDING_APPROVAL_TERMINAL_STATE,
        approval_state: STALE_PENDING_APPROVAL_TERMINAL_STATE,
      },
    };
  });
}

// v4 collapses duplicate message ids and settles orphaned pending approvals
// so old transcripts cannot reload with impossible tool-call state.
function repairSessionForV4(session = {}) {
  const source = session && typeof session === 'object' && !Array.isArray(session) ? session : {};
  const dedupedMessages = dedupeMessagesByIdKeepLatest(source.messages);
  const repairedMessages = repairStalePendingApprovalToolUse(dedupedMessages);
  const lastMessage = repairedMessages[repairedMessages.length - 1] || null;
  return {
    ...source,
    messages: repairedMessages,
    message_count: repairedMessages.length,
    last_message_preview:
      summarizeMessage(lastMessage)
      || String(source.last_message_preview || ''),
  };
}

// v5 normalizes the reconnect active-turn snapshot that older stores either
// omitted or persisted with partial runtime fields.
function repairSessionForV5(session = {}) {
  const source = session && typeof session === 'object' && !Array.isArray(session) ? session : {};
  return {
    ...source,
    active_turn: normalizeActiveTurn(source.active_turn),
  };
}

// v6 converts legacy assistant status="error" rows into the canonical terminal
// statuses used by renderer recovery surfaces.
function repairSessionForV6(session = {}) {
  const source = session && typeof session === 'object' && !Array.isArray(session) ? session : {};
  const messages = Array.isArray(source.messages)
    ? source.messages.map((message) => migrateAssistantTerminalStatus(message))
    : [];
  return {
    ...source,
    messages,
  };
}

// v7 re-runs message normalization with the session's last_model_used fallback
// so historical rows carry stable model/status/message metadata. The actual
// normalize call is injected by the caller so this module stays free of the
// (much larger) message-normalization dependency graph; the caller normally
// passes `normalizeMessage` from `electron-session-store`.
function repairSessionForV7(session = {}, normalizeMessageFn) {
  const source = session && typeof session === 'object' && !Array.isArray(session) ? session : {};
  if (typeof normalizeMessageFn !== 'function') {
    return source;
  }
  const messages = Array.isArray(source.messages)
    ? source.messages.map((message) => normalizeMessageFn(message, source.last_model_used || '')).filter(Boolean)
    : [];
  return {
    ...source,
    messages,
  };
}

// v9 preserves legacy action_target_message_id while projecting the canonical
// target_message_id field expected by current turn-event readers.
function repairSessionForV9(session = {}) {
  const source = session && typeof session === 'object' && !Array.isArray(session) ? session : {};
  const turnEvents = Array.isArray(source.turn_events)
    ? source.turn_events.map((event) => {
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        return event;
      }
      const legacy = String(event.action_target_message_id || event.actionTargetMessageId || '').trim();
      const current = String(event.target_message_id || event.targetMessageId || '').trim();
      const resolved = current || legacy;
      if (!resolved && !legacy) {
        return event;
      }
      return {
        ...event,
        target_message_id: resolved,
        action_target_message_id: legacy || resolved,
      };
    })
    : source.turn_events;
  return {
    ...source,
    turn_events: turnEvents,
  };
}

// v11 adds explicit branch lineage. Malformed rows normalize to null so old or
// hand-authored state cannot crash sidebar/session rendering.
function repairSessionForV11(session = {}) {
  const source = session && typeof session === 'object' && !Array.isArray(session) ? session : {};
  return {
    ...source,
    branch_origin: normalizeBranchOrigin(source.branch_origin || source.branchOrigin),
  };
}

// v12 adds marker-only reactions on message records. Unknown or malformed
// reaction entries normalize away so user-authored/corrupt stores cannot break
// transcript rendering.
function repairSessionForV12(session = {}) {
  const source = session && typeof session === 'object' && !Array.isArray(session) ? session : {};
  const messages = Array.isArray(source.messages)
    ? source.messages.map((message) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          return message;
        }
        const hasCanonical = Object.prototype.hasOwnProperty.call(message, 'message_reactions');
        const hasLegacy = Object.prototype.hasOwnProperty.call(message, 'messageReactions');
        if (!hasCanonical && !hasLegacy) {
          return message;
        }
        const { messageReactions: _legacyMessageReactions, ...messageFields } = message;
        return {
          ...messageFields,
          message_reactions: normalizeMessageReactions(
            message.message_reactions || message.messageReactions
          ),
        };
      })
    : [];
  return {
    ...source,
    messages,
  };
}

function repairSessionForV13(session = {}) {
  const source = session && typeof session === 'object' && !Array.isArray(session) ? session : {};
  return {
    ...source,
    ...normalizeDiagnosticMetadata(source),
  };
}

// Mirrors mergeReasoningEntriesById from canonical-turn-event-collector.js:
// the latest snapshot of an entry id replaces the prior one; unseen ids append.
function mergeReasoningEntriesForCompaction(existingEntries, incomingEntries) {
  const merged = (Array.isArray(existingEntries) ? existingEntries : []).slice();
  const indexById = new Map();
  for (let i = 0; i < merged.length; i += 1) {
    const id = String(merged[i]?.id || '').trim();
    if (id && !indexById.has(id)) {
      indexById.set(id, i);
    }
  }
  for (const entry of (Array.isArray(incomingEntries) ? incomingEntries : [])) {
    const id = String(entry?.id || '').trim();
    if (id && indexById.has(id)) {
      merged[indexById.get(id)] = entry;
      continue;
    }
    if (id) {
      indexById.set(id, merged.length);
    }
    merged.push(entry);
  }
  return merged;
}

function reasoningPhaseCompactionKey(event) {
  const turnId = String(event?.turn_id || '').trim();
  if (!turnId) {
    return '';
  }
  const payload = event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {};
  const phaseId = String(event?.phase_id || payload.phase_id || '').trim();
  const thinkingId = String(payload.thinking_id || '').trim();
  const identity = phaseId || thinkingId;
  if (!identity) {
    return '';
  }
  return `${turnId}:${identity}`;
}

// v14 compacts bloated reasoning_phase turn events persisted before 2026-06-11
// (commit 0a54288). Prior live capture emitted one event per streamed delta
// instead of coalescing per phase, inflating some sessions by 1,000+ events
// per turn. Groups reasoning_phase events by (turn_id, phase_id||thinking_id),
// merges entries by id (latest snapshot wins), sums chunk_count, takes the
// latest status/completed_at. Event position is the first occurrence; all
// other event kinds are left untouched.
function repairSessionForV14(session = {}) {
  const source = session && typeof session === 'object' && !Array.isArray(session) ? session : {};
  if (!Array.isArray(source.turn_events) || !source.turn_events.length) {
    return source;
  }
  if (!source.turn_events.some((event) => event && event.kind === 'reasoning_phase')) {
    return source;
  }

  const phasePositionByKey = new Map();
  const phaseAccumulatedByKey = new Map();
  const outputEvents = [];

  for (const event of source.turn_events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      outputEvents.push(event);
      continue;
    }
    if (event.kind !== 'reasoning_phase') {
      outputEvents.push(event);
      continue;
    }

    const phaseKey = reasoningPhaseCompactionKey(event);
    if (!phaseKey) {
      outputEvents.push(event);
      continue;
    }

    if (!phasePositionByKey.has(phaseKey)) {
      phasePositionByKey.set(phaseKey, outputEvents.length);
      outputEvents.push(null);
      const eventPayload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload
        : {};
      phaseAccumulatedByKey.set(phaseKey, {
        ...event,
        payload: {
          ...eventPayload,
          ...(Array.isArray(eventPayload.entries) ? { entries: eventPayload.entries.slice() } : {}),
        },
      });
    } else {
      const accumulated = phaseAccumulatedByKey.get(phaseKey);
      const incoming = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload
        : {};

      if (Array.isArray(incoming.entries) && incoming.entries.length) {
        accumulated.payload.entries = mergeReasoningEntriesForCompaction(
          accumulated.payload.entries,
          incoming.entries
        );
      }

      const incomingChunkCount = Number(incoming.chunk_count);
      if (Number.isFinite(incomingChunkCount) && incomingChunkCount > 0) {
        accumulated.payload.chunk_count =
          (Number(accumulated.payload.chunk_count) || 0) + incomingChunkCount;
      }

      for (const scalarKey of ['phase_id', 'phase_kind', 'thinking_id', 'summary']) {
        if (typeof incoming[scalarKey] === 'string' && incoming[scalarKey]) {
          accumulated.payload[scalarKey] = incoming[scalarKey];
        }
      }

      if (String(event.status || '').trim()) {
        accumulated.status = event.status;
      }
      if (String(event.completed_at || '').trim()) {
        accumulated.completed_at = event.completed_at;
      }
    }
  }

  for (const [phaseKey, position] of phasePositionByKey.entries()) {
    outputEvents[position] = phaseAccumulatedByKey.get(phaseKey);
  }

  return {
    ...source,
    turn_events: outputEvents,
  };
}

function repairSessionForV15(session = {}) {
  const source = session && typeof session === 'object' && !Array.isArray(session)
    ? session
    : {};
  const parsedGeneration = Number(source.turn_generation);
  return {
    ...source,
    session_incarnation: String(source.session_incarnation || '').trim(),
    turn_generation: Number.isSafeInteger(parsedGeneration) && parsedGeneration >= 0
      ? parsedGeneration
      : 0,
  };
}

const SESSION_MIGRATION_STEPS = [
  [3, (session) => (session && typeof session === 'object' && !Array.isArray(session) ? session : {})],
  [4, repairSessionForV4],
  [5, repairSessionForV5],
  [6, repairSessionForV6],
  [7, (session, normalizeMessage) => repairSessionForV7(session, normalizeMessage)],
  [9, repairSessionForV9],
  [11, repairSessionForV11],
  [12, repairSessionForV12],
  [13, repairSessionForV13],
  [14, repairSessionForV14],
  [15, repairSessionForV15],
  // v16/v17 are declared below (function declarations hoist, so the array
  // literal already sees them); they ran as bespoke loops before v17 folded
  // them back into the single migration cascade.
  [16, repairSessionForV16],
  [17, repairSessionForV17],
  [18, repairSessionForV18],
  [19, repairSessionForV19],
  [20, repairSessionForV20],
];

// v16 introduces `compaction_snapshot` (JCA-003 manual-compaction ownership).
// Pre-v16 records have no such field; anything present anyway (hand-authored
// or corrupt state) must survive only if it parses as a valid snapshot —
// normalizeCompactionSnapshot fails closed to null.
function repairSessionForV16(session = {}) {
  const source = session && typeof session === 'object' && !Array.isArray(session)
    ? session
    : {};
  return {
    ...source,
    compaction_snapshot: normalizeCompactionSnapshot(source.compaction_snapshot),
  };
}

// v17 introduces the session type (image-gen contract C2). Every pre-v17
// record predates image sessions, so it migrates to `session_type: 'chat'` with
// no image_config; a hand-authored or corrupt type normalizes to 'chat' too,
// and image_config survives only on a record that is actually an image session
// and only when it parses (normalizeSessionImageConfig fails closed to null).
// Nothing else on the record is touched, so message history, turn events, and
// the v16 compaction snapshot pass through untouched.
function repairSessionForV17(session = {}) {
  const source = session && typeof session === 'object' && !Array.isArray(session)
    ? session
    : {};
  const rawType = String(source.session_type || '').trim().toLowerCase();
  const sessionType = rawType === 'image' ? 'image' : 'chat';
  return {
    ...source,
    session_type: sessionType,
    image_config: normalizeSessionImageConfig(sessionType, source.image_config),
  };
}

function legacyImageOperationStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['done', 'success', 'succeeded', 'complete', 'completed'].includes(status)) {
    return 'succeeded';
  }
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (['pending', 'accepted', 'running', 'cancelling', 'in_flight'].includes(status)) {
    return 'interrupted';
  }
  return 'failed';
}

function legacyImageOperationContent(operation, attachments, status) {
  if (status === 'cancelled') return 'Image generation was cancelled.';
  if (status === 'interrupted') {
    return 'Image generation was interrupted before it finished.';
  }
  const attachment = (Array.isArray(attachments) ? attachments : [])[0] || {};
  const provenance = attachment.provenance && typeof attachment.provenance === 'object'
    ? attachment.provenance : {};
  const width = Math.max(0, Number(operation.width || attachment.width || provenance.width) || 0);
  const height = Math.max(0, Number(operation.height || attachment.height || provenance.height) || 0);
  const seed = Number(operation.seed ?? provenance.seed);
  if (status === 'succeeded') {
    const details = [];
    if (width > 0 && height > 0) details.push(`${Math.trunc(width)} × ${Math.trunc(height)}`);
    if (Number.isSafeInteger(seed)) details.push(`seed ${seed}`);
    return details.length ? `Generated image (${details.join(', ')}).` : 'Generated image.';
  }
  const reasonCode = String(operation.error_code || operation.reason_code || 'generation_failed')
    .trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64) || 'generation_failed';
  return `Image generation failed (${reasonCode}).`;
}

function migrateLegacyImageOperationMessage(message, index = 0) {
  const source = message && typeof message === 'object' && !Array.isArray(message) ? message : {};
  const operation = source.image_operation && typeof source.image_operation === 'object'
    && !Array.isArray(source.image_operation) ? source.image_operation : null;
  if (!operation && String(source.kind || '').trim() !== 'image_operation') return source;
  const status = legacyImageOperationStatus(operation?.status);
  const messageId = String(source.id || '').trim();
  const rawOperationId = String(operation?.operation_id || operation?.operationId
    || messageId.replace(/^imgop_/, '') || `legacy_image_${index}`).trim();
  const pluginOperation = normalizePluginOperationMetadata({
    operation_id: /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(rawOperationId)
      ? rawOperationId : `legacy_image_${index}`,
    attempt: 1,
    action_id: 'generate',
    status,
    reason_code: status === 'interrupted'
      ? 'interrupted' : operation?.error_code,
  });
  const { image_operation: _legacyOperation, kind: _legacyKind, ...retained } = source;
  return {
    ...retained,
    content: legacyImageOperationContent(operation || {}, source.attachments, status),
    status: status === 'succeeded' ? 'complete'
      : (status === 'cancelled' ? 'cancelled' : 'runtime_error'),
    ...(pluginOperation ? { plugin_operation: pluginOperation } : {}),
  };
}

// v18 extracts core image generation into the official session provider. The
// operation record moves into the session row, not a side file, and legacy
// card-only assistant messages become ordinary readable transcript messages.
function repairSessionForV18(session = {}) {
  const source = session && typeof session === 'object' && !Array.isArray(session)
    ? session : {};
  const rawType = String(source.session_type || '').trim().toLowerCase();
  const { image_config: _legacyImageConfig, ...retained } = source;
  if (rawType === 'image') {
    return {
      ...retained,
      session_type: 'plugin',
      plugin_session: createOfficialImagePluginSession(source.image_config),
      messages: enforcePluginOperationMetadataBudget(
        (Array.isArray(source.messages) ? source.messages : [])
          .map((message, index) => migrateLegacyImageOperationMessage(message, index))
      ),
    };
  }
  if (rawType === 'plugin') {
    return {
      ...retained,
      session_type: 'plugin',
      plugin_session: normalizePluginSession(source.plugin_session),
    };
  }
  return { ...retained, session_type: normalizeSessionType(rawType), plugin_session: null };
}

function repairSessionForV19(session = {}) {
  const source = session && typeof session === 'object' && !Array.isArray(session)
    ? session : {};
  return {
    ...source,
    context_preferences: normalizeContextPreferences(source.context_preferences),
    compaction_snapshot: normalizeCompactionSnapshot(source.compaction_snapshot),
  };
}

function repairSessionForV20(session = {}) {
  const source = session && typeof session === 'object' && !Array.isArray(session)
    ? session : {};
  return {
    ...source,
    tool_category_overrides: normalizeToolCategoryOverrides(source.tool_category_overrides),
  };
}

function migrateStorePayload(payload, { normalizeMessage } = {}) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const observedVersion = Number(source.schema_version);
  const version = Number.isSafeInteger(observedVersion)
    && observedVersion >= 1
    && observedVersion <= STORE_SCHEMA_VERSION
    ? observedVersion : 1;
  const migrated = {
    ...source,
    sessions:
      source.sessions && typeof source.sessions === 'object' && !Array.isArray(source.sessions)
        ? { ...source.sessions }
        : {},
  };
  for (const [threshold, repairSession] of SESSION_MIGRATION_STEPS) {
    if (version < threshold) {
      for (const [sessionId, session] of Object.entries(migrated.sessions)) {
        const repaired = repairSession(session, normalizeMessage);
        migrated.sessions[sessionId] = {
          ...repaired,
          linked_session_ids: normalizeLinkedSessionIds(repaired?.linked_session_ids, sessionId),
        };
      }
    }
  }
  for (const [sessionId, session] of Object.entries(migrated.sessions)) {
    if (session?.session_type === 'plugin' && !String(session.session_incarnation || '').trim()) {
      migrated.sessions[sessionId] = {
        ...session,
        session_incarnation: `inc_plugin_${sessionId}`,
      };
    }
  }
  migrated.schema_version = STORE_SCHEMA_VERSION;
  return migrated;
}

function normalizeStorePayload(payload, { normalizeMessage } = {}) {
  const source = migrateStorePayload(payload, { normalizeMessage });
  return {
    schema_version: STORE_SCHEMA_VERSION,
    sessions:
      source.sessions && typeof source.sessions === 'object' && !Array.isArray(source.sessions)
        ? source.sessions
        : {},
  };
}

module.exports = {
  LEGACY_MONOLITHIC_MAX_SCHEMA_VERSION,
  STALE_PENDING_APPROVAL_TERMINAL_STATE,
  STORE_SCHEMA_VERSION,
  dedupeMessagesByIdKeepLatest,
  mergeReasoningEntriesForCompaction,
  migrateAssistantTerminalStatus,
  migrateStorePayload,
  normalizeBranchOrigin,
  normalizeDiagnosticMetadata,
  normalizeDiagnosticMetadataValue,
  normalizeLinkedSessionIds,
  normalizeLinkedTaskId,
  normalizeStorePayload,
  repairSessionForV4,
  repairSessionForV5,
  repairSessionForV6,
  repairSessionForV7,
  repairSessionForV9,
  repairSessionForV11,
  repairSessionForV12,
  repairSessionForV13,
  repairSessionForV14,
  repairSessionForV15,
  repairSessionForV16,
  repairSessionForV17,
  repairSessionForV18,
  repairSessionForV19,
  repairSessionForV20,
  migrateLegacyImageOperationMessage,
  repairStalePendingApprovalToolUse,
  summarizeMessage,
};
