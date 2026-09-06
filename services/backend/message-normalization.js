/**
 * message-normalization.js
 *
 * Shared message and metadata normalization functions used by both
 * SessionShadowStore and ElectronSessionStore.
 */
const {
  normalizeAttachmentMetadataList,
} = require('../attachment-service');
const {
  normalizeGeneratedArtifactMetadataList,
} = require('../artifact-metadata-utils');
const { normalizeString, normalizeId } = require('../../renderer/shared/string-utils');
const { normalizePluginOperationMetadata } = require('./session-type');
const { normalizeSubagentMetadata } = require('./subagent-report-metadata');

const VALID_MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'tool']);
const VALID_EXTERNAL_PAYLOAD_ROOT_KINDS = new Set([
  'artifact',
  'attachment',
  'diagnostic',
  'tool_result',
]);
const VALID_MESSAGE_REACTIONS = new Set(['thumbs_up', 'saved', 'note']);
const MAX_EXTERNAL_PAYLOAD_PATH_LENGTH = 512;
const MAX_INTERACTIVE_BATCH_ID_CHARS = 128;
const MAX_INTERACTIVE_INTRO_CHARS = 1000;
const MAX_INTERACTIVE_QUESTION_PROMPT_CHARS = 1000;
const MAX_INTERACTIVE_OPTION_LABEL_CHARS = 160;
const MAX_INTERACTIVE_OPTIONS_PER_QUESTION = 6;
const MAX_CONTINUATION_TOKEN_TIMESTAMP_CHARS = 40;
const MAX_PLAN_PROPOSAL_TITLE_CHARS = 200;
const MAX_PLAN_PROPOSAL_STEP_LABEL_CHARS = 200;
const MAX_PLAN_PROPOSAL_STEP_DETAIL_CHARS = 400;
const MAX_PLAN_PROPOSAL_STEPS = 8;

function nowIso() {
  return new Date().toISOString();
}

function cloneJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry));
  }
  if (value && typeof value === 'object') {
    const cloned = {};
    for (const [key, entry] of Object.entries(value)) {
      cloned[key] = cloneJsonValue(entry);
    }
    return cloned;
  }
  return value;
}

function normalizeConversationMode(value) {
  const token = normalizeString(value).toLowerCase();
  return token === 'interactive' ? 'interactive' : 'chat';
}

function normalizeInteractiveSequenceState(value) {
  const token = normalizeString(value).toLowerCase();
  if (token === 'structured_active' || token === 'fallback_requested') {
    return token;
  }
  return 'idle';
}

function normalizeInteractiveRoundCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.max(0, Math.floor(parsed));
}

function normalizePlanMode(value) {
  return value === true;
}

function clipNormalizedString(value, limit) {
  const text = normalizeString(value);
  return text.length > limit ? text.slice(0, limit) : text;
}

function normalizeBoundedInteractiveId(value) {
  const id = normalizeId(value);
  return id.length > MAX_INTERACTIVE_BATCH_ID_CHARS
    ? id.slice(0, MAX_INTERACTIVE_BATCH_ID_CHARS)
    : id;
}

function normalizeStrictContinuationId(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const id = value.trim();
  return id && id.length <= MAX_INTERACTIVE_BATCH_ID_CHARS ? id : '';
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

function normalizePendingQuestionBatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const batchId = normalizeBoundedInteractiveId(value.batch_id);
  const introText = clipNormalizedString(value.intro_text, MAX_INTERACTIVE_INTRO_CHARS);
  const roundIndex = Math.max(1, normalizeInteractiveRoundCount(value.round_index) || 1);
  const questions = Array.isArray(value.questions)
    ? value.questions
        .map((question) => {
          if (!question || typeof question !== 'object' || Array.isArray(question)) {
            return null;
          }
          const questionId = normalizeBoundedInteractiveId(question.id);
          const prompt = clipNormalizedString(question.prompt, MAX_INTERACTIVE_QUESTION_PROMPT_CHARS);
          if (!questionId || !prompt) {
            return null;
          }

          const options = [];
          if (Array.isArray(question.options)) {
            for (const option of question.options) {
              if (!option || typeof option !== 'object' || Array.isArray(option)) {
                continue;
              }
              const optionId = normalizeBoundedInteractiveId(option.id);
              const label = clipNormalizedString(option.label, MAX_INTERACTIVE_OPTION_LABEL_CHARS);
              if (optionId && label) {
                options.push({ id: optionId, label });
              }
              if (options.length >= MAX_INTERACTIVE_OPTIONS_PER_QUESTION) {
                break;
              }
            }
          }

          if (!options.length) {
            return null;
          }

          return {
            id: questionId,
            prompt,
            options,
          };
        })
        .filter(Boolean)
    : [];

  if (!batchId || !questions.length) {
    return null;
  }

  const continuationToken = normalizeQuestionBatchContinuationToken(value.continuation_token);

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

// Wire-trust boundary for the sidecar's chat.plan_proposal payload
// (terminal sibling of the question batch). Bounded ids/labels, 1..8 labeled
// steps required; optional intro_text and per-step detail are clipped.
function normalizePendingPlanProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const proposalId = normalizeBoundedInteractiveId(value.proposal_id);
  const title = clipNormalizedString(value.title, MAX_PLAN_PROPOSAL_TITLE_CHARS);
  const introText = clipNormalizedString(value.intro_text, MAX_INTERACTIVE_INTRO_CHARS);
  const steps = Array.isArray(value.steps)
    ? value.steps
        .map((step, index) => {
          if (!step || typeof step !== 'object' || Array.isArray(step)) {
            return null;
          }
          const stepId = normalizeBoundedInteractiveId(step.id) || `s${index + 1}`;
          const label = clipNormalizedString(step.label, MAX_PLAN_PROPOSAL_STEP_LABEL_CHARS);
          if (!label) {
            return null;
          }
          const normalized = { id: stepId, label };
          const detail = clipNormalizedString(step.detail, MAX_PLAN_PROPOSAL_STEP_DETAIL_CHARS);
          if (detail) {
            normalized.detail = detail;
          }
          return normalized;
        })
        .filter(Boolean)
        .slice(0, MAX_PLAN_PROPOSAL_STEPS)
    : [];

  if (!proposalId || !title || !steps.length) {
    return null;
  }

  return {
    proposal_id: proposalId,
    title,
    intro_text: introText,
    steps,
  };
}

function normalizeInteractiveRoundRecap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const roundIndex = Math.max(1, normalizeInteractiveRoundCount(value.round_index) || 1);
  const items = Array.isArray(value.items)
    ? value.items
        .map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return null;
          }
          const questionId = normalizeId(item.question_id);
          const prompt = normalizeString(item.prompt);
          const answerLabel = normalizeString(item.answer_label);
          if (!questionId || !prompt || !answerLabel) {
            return null;
          }
          return {
            question_id: questionId,
            prompt,
            answer_label: answerLabel,
          };
        })
        .filter(Boolean)
    : [];

  if (!items.length) {
    return null;
  }

  return {
    round_index: roundIndex,
    answer_count: Math.max(1, Number(value.answer_count) || items.length),
    items,
    collapsed: value.collapsed !== false,
  };
}

function normalizeToolCallMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const callId = normalizeId(value.call_id);
  const toolName = normalizeString(value.tool_name);
  if (!callId || !toolName) {
    return null;
  }
  const externalPayloads = normalizeExternalPayloadReferences(value.external_payloads);
  return {
    call_id: callId,
    tool_name: toolName,
    input_json: String(value.input_json || ''),
    input: value.input && typeof value.input === 'object' && !Array.isArray(value.input)
      ? value.input
      : {},
    summary: normalizeString(value.summary),
    status: normalizeString(value.status || 'completed'),
    approval_state: normalizeString(value.approval_state || 'auto'),
    duration_ms: Math.max(0, Number(value.duration_ms) || 0),
    parent_stream_id: normalizeId(value.parent_stream_id),
    ...(Object.keys(externalPayloads).length ? { external_payloads: externalPayloads } : {}),
  };
}

function normalizeToolResultMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const callId = normalizeId(value.call_id);
  const toolName = normalizeString(value.tool_name);
  if (!callId || !toolName) {
    return null;
  }
  const externalPayloads = normalizeExternalPayloadReferences(value.external_payloads);
  const metadata =
    value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
      ? { ...value.metadata }
      : {};
  const subagentMetadata = normalizeSubagentMetadata(metadata);
  delete metadata.subagent_report;
  delete metadata.subagent_batch_report;
  if (subagentMetadata) Object.assign(metadata, subagentMetadata);
  if (!Array.isArray(metadata.late_events)) {
    metadata.late_events = [];
  }
  return {
    call_id: callId,
    tool_name: toolName,
    output_text: normalizeString(value.output_text),
    summary: normalizeString(value.summary),
    is_error: Boolean(value.is_error),
    error_code: normalizeString(value.error_code),
    approval_state: normalizeString(value.approval_state || value.approvalState),
    exit_code: value.exit_code != null ? Number(value.exit_code) : null,
    duration_ms: Math.max(0, Number(value.duration_ms) || 0),
    parent_stream_id: normalizeId(value.parent_stream_id),
    generated_artifacts: normalizeGeneratedArtifactMetadataList(value.generated_artifacts),
    metadata,
    ...(Object.keys(externalPayloads).length ? { external_payloads: externalPayloads } : {}),
  };
}

function normalizeMessageRole(value) {
  const role = normalizeString(value || 'assistant').toLowerCase();
  return VALID_MESSAGE_ROLES.has(role) ? role : 'assistant';
}

function normalizeIsoTimestamp(value) {
  const token = normalizeString(value);
  if (!token) {
    return '';
  }
  const parsed = new Date(token);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function normalizeMessageReactions(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const [reactionId, entry] of Object.entries(source)) {
    const normalizedId = normalizeString(reactionId);
    if (!VALID_MESSAGE_REACTIONS.has(normalizedId)) {
      continue;
    }
    const reaction = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
    if (!reaction || reaction.selected !== true) {
      continue;
    }
    normalized[normalizedId] = {
      selected: true,
      updated_at: normalizeIsoTimestamp(reaction.updated_at || reaction.updatedAt),
    };
  }
  return normalized;
}

function normalizeExternalPayloadPath(value) {
  const token = normalizeString(value);
  if (!token || token.length > MAX_EXTERNAL_PAYLOAD_PATH_LENGTH) {
    return '';
  }
  const normalized = token.replace(/\\/g, '/');
  if (
    normalized.startsWith('/')
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.split('/').some((part) => part === '..')
  ) {
    return '';
  }
  return normalized;
}

function normalizeExternalPayloadReferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const normalized = {};
  for (const [field, entry] of Object.entries(value)) {
    const normalizedField = normalizeString(field);
    if (!normalizedField || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const resolvedPath = normalizeExternalPayloadPath(entry.path);
    const rootKind = normalizeString(entry.root_kind || entry.rootKind).toLowerCase();
    if (!resolvedPath) {
      continue;
    }
    normalized[normalizedField] = {
      path: resolvedPath,
      ...(VALID_EXTERNAL_PAYLOAD_ROOT_KINDS.has(rootKind) ? { root_kind: rootKind } : {}),
      bytes: Math.max(0, Number(entry.bytes) || 0),
      encoding: normalizeString(entry.encoding) || 'utf-8',
      format: normalizeString(entry.format) || 'json',
    };
  }
  return normalized;
}

function normalizeStoredReasoningEntry(value, fallbackIndex = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const text = normalizeString(value.text || value.summary || value.content);
  if (!text) {
    return null;
  }
  const normalized = {
    id: normalizeId(value.id) || `reasoning_${fallbackIndex}`,
    text,
    timestamp: normalizeString(value.timestamp),
  };
  const thinkingId = normalizeString(value.thinkingId || value.thinking_id);
  if (thinkingId) {
    normalized.thinkingId = thinkingId;
  }
  return normalized;
}

function mergeStoredReasoningEntries(existingEntries, incomingEntries) {
  const merged = [];
  const indexById = new Map();
  const combined = []
    .concat(Array.isArray(existingEntries) ? existingEntries : [])
    .concat(Array.isArray(incomingEntries) ? incomingEntries : []);
  for (let index = 0; index < combined.length; index += 1) {
    const entry = normalizeStoredReasoningEntry(combined[index], index);
    if (!entry) {
      continue;
    }
    const existingIndex = indexById.get(entry.id);
    if (Number.isInteger(existingIndex)) {
      merged[existingIndex] = entry;
      continue;
    }
    const duplicateIndex = merged.findIndex(
      (candidate) =>
        candidate.text === entry.text
        && candidate.timestamp === entry.timestamp
        && String(candidate.thinkingId || '') === String(entry.thinkingId || '')
    );
    if (duplicateIndex !== -1) {
      continue;
    }
    indexById.set(entry.id, merged.length);
    merged.push(entry);
  }
  return merged;
}

function normalizeTranscriptPhase(value, fallbackIndex = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const phaseId = normalizeId(value.phase_id || value.phaseId) || `phase_${fallbackIndex}`;
  const phaseKind = normalizeString(value.phase_kind || value.phaseKind);
  if (!phaseId || !phaseKind) {
    return null;
  }
  return {
    phase_id: phaseId,
    phase_kind: phaseKind,
    iteration: Math.max(0, Math.floor(Number(value.iteration || 0) || 0)),
    thinking_id: normalizeString(value.thinking_id || value.thinkingId),
    tool_call_id: normalizeString(value.tool_call_id || value.toolCallId),
    tool_name: normalizeString(value.tool_name || value.toolName),
    render_collapsed: value.render_collapsed === true || value.renderCollapsed === true,
    started_at: normalizeString(value.started_at || value.startedAt),
    completed_at: normalizeString(value.completed_at || value.completedAt),
    entries: mergeStoredReasoningEntries([], value.entries),
  };
}

function normalizeVisibleSegment(value, fallbackIndex = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const text = String(value.text || '');
  const segmentId = normalizeId(value.segment_id || value.segmentId) || `segment_${fallbackIndex}`;
  if (!segmentId) {
    return null;
  }
  return {
    segment_id: segmentId,
    phase_id: normalizeString(value.phase_id || value.phaseId),
    text,
  };
}

function buildVisibleSegmentContent(visibleSegments, fallbackContent = '') {
  const segments = Array.isArray(visibleSegments) ? visibleSegments : [];
  if (!segments.length) {
    return String(fallbackContent || '');
  }
  return segments.map((segment) => String(segment?.text || '')).join('');
}

function normalizeToolStep(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const callId = normalizeId(value.call_id || value.callId);
  const toolName = normalizeString(value.tool_name || value.toolName);
  if (!callId || !toolName) {
    return null;
  }
  return {
    call_id: callId,
    tool_name: toolName,
    tool_use_message_id: normalizeString(value.tool_use_message_id || value.toolUseMessageId),
    tool_result_message_id: normalizeString(value.tool_result_message_id || value.toolResultMessageId),
    status: normalizeString(value.status || 'completed') || 'completed',
  };
}

function flattenReasoningEntriesFromPhases(phases, fallbackEntries) {
  const flattened = [];
  const phaseList = Array.isArray(phases) ? phases : [];
  for (const phase of phaseList) {
    if (String(phase?.phase_kind || '').trim() !== 'reasoning') {
      continue;
    }
    flattened.push(...(Array.isArray(phase.entries) ? phase.entries : []));
  }
  const merged = mergeStoredReasoningEntries([], flattened);
  if (merged.length) {
    return merged;
  }
  return mergeStoredReasoningEntries([], fallbackEntries);
}

function normalizeReasoningPayload(value, phases) {
  const sourceValue = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fallbackEntries = mergeStoredReasoningEntries([], sourceValue.entries);
  const entries = flattenReasoningEntriesFromPhases(phases, fallbackEntries);
  return {
    source: entries.length ? 'provider' : normalizeString(sourceValue.source || 'none') || 'none',
    entries,
  };
}

function normalizeProactiveSuggestionMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const kind = normalizeString(value.kind);
  const title = normalizeString(value.title);
  const body = normalizeString(value.body);
  if (!kind || !title || !body) {
    return null;
  }
  return {
    id: normalizeId(value.id),
    kind,
    title,
    body,
    promptSuggestion: normalizeString(value.promptSuggestion),
    createdAt: normalizeString(value.createdAt),
    dedupeKey: normalizeString(value.dedupeKey),
    sourceMeta:
      value.sourceMeta && typeof value.sourceMeta === 'object' && !Array.isArray(value.sourceMeta)
        ? value.sourceMeta
        : {},
  };
}

function normalizeSkillInvocationMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fields = ['id', 'name', 'scope', 'command'];
  if (fields.some((field) => typeof value[field] !== 'string')) return null;
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function normalizeTurnEventPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const payload = cloneJsonValue(value);
  if (Array.isArray(payload.generated_artifacts)) {
    payload.generated_artifacts = payload.generated_artifacts
      .map((artifact) => {
        const normalizedArtifact = normalizeGeneratedArtifactMetadataList([artifact])[0] || null;
        if (!normalizedArtifact) {
          return null;
        }
        const toolCallId = normalizeId(
          artifact?.tool_call_id || artifact?.toolCallId || payload.tool_call_id
        );
        return toolCallId
          ? { ...normalizedArtifact, tool_call_id: toolCallId }
          : normalizedArtifact;
      })
      .filter(Boolean);
  }
  return payload;
}

function normalizeTurnEvent(input, fallbackIndex = 0) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const turnId = normalizeId(input.turn_id || input.turnId);
  const kind = normalizeString(input.kind).toLowerCase();
  if (!turnId || !kind) {
    return null;
  }
  const sourceMessageIds = Array.isArray(input.source_message_ids || input.sourceMessageIds)
    ? Array.from(new Set(
        (input.source_message_ids || input.sourceMessageIds)
          .map((value) => normalizeId(value))
          .filter(Boolean)
      ))
    : [];
  const primaryMessageId = normalizeId(input.primary_message_id || input.primaryMessageId);
  const eventId = normalizeId(input.event_id || input.eventId)
    || `${turnId}:${kind}:${fallbackIndex}`;
  const normalizedEventSeq = Number(input.event_seq);
  return {
    event_id: eventId,
    event_seq: Number.isInteger(normalizedEventSeq) && normalizedEventSeq >= 0
      ? normalizedEventSeq
      : null,
    turn_id: turnId,
    kind,
    status: normalizeString(input.status).toLowerCase(),
    primary_message_id: primaryMessageId,
    source_message_ids: sourceMessageIds,
    target_message_id: normalizeId(input.target_message_id || input.targetMessageId),
    tool_call_id: normalizeId(input.tool_call_id || input.toolCallId),
    segment_group_index: Number.isInteger(Number(input.segment_group_index))
      ? Math.max(0, Math.floor(Number(input.segment_group_index)))
      : null,
    phase_id: normalizeId(input.phase_id || input.phaseId),
    started_at: normalizeString(input.started_at || input.startedAt),
    completed_at: normalizeString(input.completed_at || input.completedAt),
    payload: normalizeTurnEventPayload(input.payload),
  };
}

/**
 * Shared message field normalization used by both stores.
 * Returns a normalized message object or null if input is invalid.
 */
function normalizeMessageFields(input, fallbackModel = '') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const { messageReactions: _legacyMessageReactions, ...sourceFields } = input;
  const toolCall = normalizeToolCallMetadata(input.tool_call);
  const toolResult = normalizeToolResultMetadata(input.tool_result);
  const proactiveSuggestion = normalizeProactiveSuggestionMetadata(input.proactive_suggestion);
  const phases = Array.isArray(input.phases)
    ? input.phases.map((phase, index) => normalizeTranscriptPhase(phase, index)).filter(Boolean)
    : [];
  const visibleSegments = Array.isArray(input.visible_segments)
    ? input.visible_segments.map((segment, index) => normalizeVisibleSegment(segment, index)).filter(Boolean)
    : [];
  const toolSteps = Array.isArray(input.tool_steps)
    ? input.tool_steps.map((toolStep) => normalizeToolStep(toolStep)).filter(Boolean)
    : [];
  const content = buildVisibleSegmentContent(visibleSegments, input.content);
  return {
    ...sourceFields,
    id: String(input.id || `msg_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`),
    role: normalizeMessageRole(input.role),
    kind: normalizeString(input.kind),
    content,
    status: normalizeString(input.status),
    terminal_subcode: normalizeString(input.terminal_subcode),
    timestamp: String(input.timestamp || nowIso()),
    model_used: String(input.model_used || fallbackModel || ''),
    client_message_id: String(input.client_message_id || ''),
    parent_stream_id: normalizeString(input.parent_stream_id || input.parentStreamId),
    event_seq: Number.isInteger(input.event_seq) && input.event_seq >= 0 ? input.event_seq : null,
    phases,
    visible_segments: visibleSegments,
    tool_steps: toolSteps,
    reasoning: normalizeReasoningPayload(input.reasoning, phases),
    attachments: normalizeAttachmentMetadataList(input.attachments),
    interactive_batch: normalizePendingQuestionBatch(input.interactive_batch),
    tool_call: toolCall,
    tool_result: toolResult,
    proactive_suggestion: proactiveSuggestion,
    skill_invocation: normalizeSkillInvocationMetadata(input.skill_invocation),
    plugin_operation: normalizePluginOperationMetadata(input.plugin_operation),
    message_reactions: normalizeMessageReactions(
      input.message_reactions || input.messageReactions
    ),
  };
}

module.exports = {
  nowIso,
  cloneJsonValue,
  normalizeConversationMode,
  normalizeInteractiveSequenceState,
  normalizeInteractiveRoundCount,
  normalizePlanMode,
  normalizeQuestionBatchContinuationToken,
  normalizePendingQuestionBatch,
  normalizePendingPlanProposal,
  normalizeInteractiveRoundRecap,
  normalizeToolCallMetadata,
  normalizeToolResultMetadata,
  normalizeMessageRole,
  normalizeMessageReactions,
  normalizeTranscriptPhase,
  normalizeVisibleSegment,
  buildVisibleSegmentContent,
  normalizeToolStep,
  normalizeTurnEvent,
  flattenReasoningEntriesFromPhases,
  normalizeProactiveSuggestionMetadata,
  normalizeSkillInvocationMetadata,
  normalizeMessageFields,
};
