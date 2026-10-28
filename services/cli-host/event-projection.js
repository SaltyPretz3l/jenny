'use strict';

// Desktop chat-stream events -> the public `cli.v1` event stream (Jenny CLI plan, decision 6).
// The desktop vocabulary is internal and churns; cli.v1 is the frozen agent contract, so every
// frame is built from an explicit per-kind allowlist (never a spread of the source event), every
// string is clipped to the schema bound, and identities are copied only when they validate.
// Pure: no I/O, no timers, no Electron. The host feeds events in and writes the frames out.

const Ajv = require('ajv');
const SCHEMA = require('./schemas/cli-v1.json');
const { RUNTIME_ERROR_CODES, SIDECAR_ERROR_CODES } = require('../backend/error-codes');

const EXIT_CODES = Object.freeze({
  OK: 0,
  RUNTIME_ERROR: 1,
  USAGE: 2,
  POLICY_DENIED: 3,
  DECISION_REQUIRED: 4,
  BUDGET: 5,
  ENGINE_UNAVAILABLE: 6,
  PROFILE_BUSY: 75,
  SIGINT: 130,
  SIGTERM: 143,
});

const CLI_EVENT_KINDS = Object.freeze(SCHEMA.oneOf.map((branch) => branch.properties.kind.const));

// Limits are read from the schema so the clipper and the validator can never disagree.
const CLI_LIMITS = Object.freeze(Object.fromEntries(Object.entries(SCHEMA.definitions)
  .filter(([, definition]) => Number.isInteger(definition.maxLength))
  .map(([name, definition]) => [name, definition.maxLength])));
const LINES_PER_CHUNK = SCHEMA.definitions.payload_tool_output.properties.lines.maxItems;
const QUESTION_LIMIT = SCHEMA.definitions.payload_user_questions_requested.properties.questions.maxItems;
const OPTION_LIMIT = SCHEMA.definitions.payload_user_questions_requested.properties.questions.items
  .properties.options.maxItems;
const STEP_LIMIT = SCHEMA.definitions.payload_plan_proposed.properties.steps.maxItems;

const ID_RE = new RegExp(SCHEMA.definitions.id.pattern, 'u');
const TOKEN_RE = new RegExp(SCHEMA.definitions.token.pattern, 'u');
const TOOL_NAME_RE = new RegExp(SCHEMA.definitions.tool_name.pattern, 'u');
const NO_CONTROL_RE = new RegExp(SCHEMA.definitions.ref.pattern, 'u');
const CMP_RE = new RegExp(SCHEMA.definitions.cmp_code.pattern, 'u');
const DISCARD_SCOPES = new Set(SCHEMA.definitions.discard_scope.enum);
const STOP_REASONS = new Set(SCHEMA.definitions.stop_reason.enum);
const COMPLETION_REASONS = new Set(SCHEMA.definitions.payload_complete.properties.completion_reason.enum);
const IDENTITY_KEYS = Object.freeze(['stream_id', 'turn_id', 'request_id', 'work_id']);
// Mirrors the renderer's legacy fallback: before main published discard_scope these
// two reasons erased nothing, every other reason erased the whole answer.
const LEGACY_PRESERVE_REASONS = new Set(['tool_continuation', 'model_winddown']);
const PLAN_TOOL = 'exit_plan_mode';

// Desktop error payloads sometimes carry a bare category instead of a CMP code;
// cli.v1 always names a CMP code, so each known category maps to its registry class.
const CATEGORY_ERROR_CODES = Object.freeze({
  timeout: SIDECAR_ERROR_CODES.TIMEOUT,
  cancelled: SIDECAR_ERROR_CODES.ABORTED,
  process_exit: SIDECAR_ERROR_CODES.PROCESS_EXIT,
  transport: SIDECAR_ERROR_CODES.TRANSPORT,
  session_busy: RUNTIME_ERROR_CODES.RESOURCE_EXCEEDED,
});
const FALLBACK_ERROR_CODE = SIDECAR_ERROR_CODES.RPC;

const ajv = new Ajv({ allErrors: true, discriminator: true, coerceTypes: false, removeAdditional: false });
const validateSchema = ajv.compile(SCHEMA);

function validateCliEvent(event) {
  if (validateSchema(event)) return { ok: true };
  return { ok: false, errors: validateSchema.errors.map((error) => `${error.instancePath || '/'} ${error.message}`) };
}

// Clips by UTF-16 unit and never leaves a lone high surrogate, so the clipped string
// is at most `limit` code points (what JSON Schema maxLength counts).
function clip(value, limit) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= limit) return { text, truncated: false };
  let end = limit;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

function clipped(value, limit) {
  return clip(value, limit).text;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function matchOrNull(value, pattern, limit) {
  return typeof value === 'string' && value.length <= limit && pattern.test(value) ? value : null;
}

const idOf = (value) => matchOrNull(value, ID_RE, CLI_LIMITS.id);
const refOf = (value) => matchOrNull(value, NO_CONTROL_RE, CLI_LIMITS.ref);
const callIdOf = (value) => matchOrNull(value, NO_CONTROL_RE, CLI_LIMITS.call_id);
const tokenOf = (value) => matchOrNull(value, TOKEN_RE, CLI_LIMITS.token);
const toolNameOf = (value) => matchOrNull(value, TOOL_NAME_RE, CLI_LIMITS.tool_name);
const countOf = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

// Adds optional fields only when present, so the closed schema never sees a null.
function withOptional(target, fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined && value !== '') target[key] = value;
  }
  return target;
}

function textPayload(value, limitName) {
  const { text, truncated } = clip(value, CLI_LIMITS[limitName]);
  return truncated ? { text, truncated: true } : { text };
}

function usageOf(value) {
  if (!isRecord(value)) return null;
  const usage = {
    input_tokens: countOf(value.input_tokens) ?? 0,
    output_tokens: countOf(value.output_tokens) ?? 0,
    total_tokens: countOf(value.total_tokens) ?? 0,
  };
  if (typeof value.estimated === 'boolean') usage.estimated = value.estimated;
  return usage;
}

function errorCodeOf(event) {
  for (const candidate of [event.error_code, event.code, event.errorCode]) {
    const code = typeof candidate === 'string' ? candidate.trim() : '';
    if (code.length <= CLI_LIMITS.cmp_code && CMP_RE.test(code)) return code;
  }
  const category = typeof event.category === 'string' ? event.category.trim() : '';
  return CATEGORY_ERROR_CODES[category] || FALLBACK_ERROR_CODE;
}

function resolveDiscardScope(event) {
  if (DISCARD_SCOPES.has(event.discard_scope)) return event.discard_scope;
  if (typeof event.preserve_prior_segments === 'boolean') {
    if (!event.preserve_prior_segments) return 'all';
    return event.reason === 'model_winddown' ? 'live_slice' : 'none';
  }
  return LEGACY_PRESERVE_REASONS.has(event.reason) ? 'none' : 'all';
}

function reasoningText(event) {
  const entries = Array.isArray(event.reasoning?.entriesDelta) ? event.reasoning.entriesDelta.filter(isRecord) : [];
  const parts = entries.map((entry) => (typeof entry.append === 'string' ? entry.append : entry.text))
    .filter((part) => typeof part === 'string' && part);
  if (!parts.length) return null;
  return withOptional(textPayload(parts.join(''), 'thinking_text'), { thinking_id: idOf(entries[0].id) });
}

// ask_user options are strings; terminal question batches carry {id, label} objects.
function questionsOf(list) {
  if (!Array.isArray(list)) return [];
  const questions = [];
  for (const question of list) {
    if (questions.length >= QUESTION_LIMIT) break;
    const id = isRecord(question) ? idOf(question.id) : null;
    const prompt = isRecord(question) ? clipped(question.prompt, CLI_LIMITS.question_prompt_text) : '';
    if (!id || !prompt) continue;
    const options = (Array.isArray(question.options) ? question.options : [])
      .map((option) => clipped(isRecord(option) ? option.label : option, CLI_LIMITS.option_text))
      .filter(Boolean).slice(0, OPTION_LIMIT);
    questions.push({ id, prompt, options, multi_select: question.multi_select === true,
      allow_other: question.allow_other === true });
  }
  return questions;
}

function planProposed(event, ref, callId) {
  const plan = event.planDocument;
  const title = clipped(plan.title, CLI_LIMITS.plan_title_text);
  if (!title) return null;
  const steps = (Array.isArray(plan.steps) ? plan.steps : [])
    .map((step) => clipped(step, CLI_LIMITS.plan_step_text)).filter(Boolean).slice(0, STEP_LIMIT);
  return { kind: 'plan_proposed', payload: withOptional({ ref, call_id: callId, title, steps }, {
    plan_id: idOf(plan.plan_id), summary: clipped(plan.summary, CLI_LIMITS.plan_summary_text) }) };
}

function withdrawal(kind, event, refField) {
  const ref = refOf(event[refField]);
  if (!ref) return null;
  return { kind, payload: withOptional({ ref }, { call_id: callIdOf(event.callId), reason: tokenOf(event.reason) }) };
}

// One builder per desktop event type; anything absent here is outside the contract.
const BUILDERS = {
  started: (event) => ({ kind: 'started',
    payload: withOptional({}, { model: clipped(event.model, CLI_LIMITS.model_text) }) }),
  delta: (event, options) => {
    if (typeof event.content === 'string' && event.content) {
      return { kind: 'delta', payload: textPayload(event.content, 'delta_text') };
    }
    const thinking = options.thinking ? reasoningText(event) : null;
    return thinking ? { kind: 'thinking', payload: thinking } : null;
  },
  stream_reset: (event) => {
    const discardScope = resolveDiscardScope(event);
    return { kind: 'reset', payload: withOptional({
      discard_scope: discardScope,
      preserve_prior_segments: typeof event.preserve_prior_segments === 'boolean'
        ? event.preserve_prior_segments : discardScope !== 'all',
    }, { next_assistant_message_id: idOf(event.next_assistant_message_id), reason: tokenOf(event.reason) }) };
  },
  thinking_status: (event) => {
    const text = clipped(event.text, CLI_LIMITS.message_text);
    return text ? { kind: 'status', payload: { phase: 'progress', text } } : null;
  },
  context_compacted: () => ({ kind: 'status', payload: { phase: 'context_compacted' } }),
  tool_use: (event) => {
    const callId = callIdOf(event.callId);
    const toolName = toolNameOf(event.toolName);
    if (!callId || !toolName) return null;
    return { kind: 'tool_use', payload: withOptional({ call_id: callId, tool_name: toolName }, {
      summary: clipped(event.summary, CLI_LIMITS.summary_text), status: tokenOf(event.status) }) };
  },
  tool_output_chunk: (event, options) => {
    const callId = callIdOf(event.callId);
    if (!options.tool_output || !callId) return null;
    const lines = (Array.isArray(event.lines) ? event.lines : []).slice(0, LINES_PER_CHUNK)
      .filter((line) => isRecord(line) && typeof line.text === 'string')
      .map((line) => ({ stream: line.stream === 'stderr' ? 'stderr' : 'stdout',
        text: clipped(line.text, CLI_LIMITS.output_line_text) }));
    const payload = withOptional({ call_id: callId }, { tool_name: toolNameOf(event.toolName) });
    payload.lines = lines;
    payload.partial = clipped(event.partial, CLI_LIMITS.output_line_text);
    return { kind: 'tool_output', payload: withOptional(payload, {
      sequence: countOf(event.sequence), dropped_lines: countOf(event.droppedLines) || null }) };
  },
  tool_result: (event) => {
    const callId = callIdOf(event.callId);
    const toolName = toolNameOf(event.toolName);
    if (!callId || !toolName) return null;
    const status = event.isError !== true ? 'ok' : (event.approvalState === 'denied' ? 'denied' : 'error');
    return { kind: 'tool_result', payload: withOptional({ call_id: callId, tool_name: toolName, status,
      ...textPayload(event.content, 'tool_result_text') }, {
      error_code: tokenOf(event.errorCode), duration_ms: countOf(event.durationMs) || null }) };
  },
  tool_approval_needed: (event) => {
    const ref = refOf(event.approvalId);
    const callId = callIdOf(event.callId);
    const toolName = toolNameOf(event.toolName);
    if (!ref || !callId || !toolName) return null;
    if (toolName === PLAN_TOOL && isRecord(event.planDocument)) return planProposed(event, ref, callId);
    return { kind: 'tool_approval_needed', payload: withOptional({ ref, call_id: callId, tool_name: toolName }, {
      summary: clipped(event.summary, CLI_LIMITS.summary_text),
      reason: clipped(event.reason, CLI_LIMITS.summary_text),
      one_off_only: event.oneOffOnly === true ? true : null }) };
  },
  tool_approval_withdrawn: (event) => withdrawal(
    event.toolName === PLAN_TOOL ? 'plan_proposal_withdrawn' : 'tool_approval_withdrawn', event, 'approvalId'),
  user_questions_requested: (event) => {
    const ref = refOf(event.questionRef);
    const questions = questionsOf(event.questions);
    if (!ref || !questions.length) return null;
    const payload = withOptional({ ref }, { call_id: callIdOf(event.callId) });
    return { kind: 'user_questions_requested', payload: { ...payload, terminal: false, questions } };
  },
  question_batch: (event) => {
    const batch = isRecord(event.batch) ? event.batch : {};
    const ref = refOf(batch.batch_id);
    const questions = questionsOf(batch.questions);
    if (!ref || !questions.length) return null;
    return { kind: 'user_questions_requested', payload: { ref, terminal: true, questions } };
  },
  user_questions_withdrawn: (event) => withdrawal('user_questions_withdrawn', event, 'questionRef'),
  complete: (event) => ({ kind: 'complete', payload: withOptional({}, {
    usage: usageOf(event.usage),
    resumable_stop: STOP_REASONS.has(event.resumableStop) ? event.resumableStop : null,
    completion_reason: COMPLETION_REASONS.has(event.completionReason) ? event.completionReason : null,
  }) }),
  error: (event) => ({ kind: 'error', payload: withOptional({ code: errorCodeOf(event), retryable: event.retryable === true }, {
    message: clipped(event.message, CLI_LIMITS.message_text), category: tokenOf(event.category) }) }),
};

function createEventProjector({ run_id: runId, session_id: sessionId, request_id: requestId = null,
  work_id: workId = null, options = {} } = {}) {
  if (!idOf(runId) || !idOf(sessionId)) throw new TypeError('cli.v1 projector needs a valid run_id and session_id');
  if (requestId !== null && !idOf(requestId)) throw new TypeError('cli.v1 projector request_id is invalid');
  if (workId !== null && !idOf(workId)) throw new TypeError('cli.v1 projector work_id is invalid');
  const flags = { thinking: options.thinking === true, tool_output: options.tool_output === true };
  const state = { seq: 0, workId, activeStream: null, closedStreams: new Set(), finished: false };

  function stamp(kind, identities, payload) {
    const event = { v: 1, kind, event_seq: state.seq, run_id: runId, session_id: sessionId };
    withOptional(event, { stream_id: identities.stream_id, turn_id: identities.turn_id,
      request_id: identities.request_id || requestId, work_id: identities.work_id || state.workId });
    event.payload = payload;
    return event;
  }

  // Binds the projector to its own turn: another session, another live stream, a stream
  // that already settled, or another work item on this session never reaches the caller.
  function admits(event, streamId) {
    if (event.sessionId !== sessionId || !streamId || state.closedStreams.has(streamId)) return false;
    const admission = event.runtimeAdmission;
    if (isRecord(admission) && ((admission.session_id && admission.session_id !== sessionId)
      || (admission.stream_id && admission.stream_id !== streamId)
      || (state.workId && admission.work_id !== state.workId))) return false;
    if (event.type === 'started') return true;
    if (state.activeStream === null) return event.type === 'error';
    return state.activeStream === streamId;
  }

  function project(event) {
    if (state.finished || !isRecord(event) || typeof event.type !== 'string' || !Object.hasOwn(BUILDERS, event.type)) {
      return null;
    }
    const streamId = idOf(event.streamId);
    if (!admits(event, streamId)) return null;
    const built = BUILDERS[event.type](event, flags);
    if (!built) return null;
    if (event.type === 'started') state.activeStream = streamId;
    if (built.kind === 'complete' || built.kind === 'error') {
      state.closedStreams.add(streamId);
      state.activeStream = null;
    }
    const admission = isRecord(event.runtimeAdmission) ? event.runtimeAdmission : {};
    const cliEvent = stamp(built.kind, {
      stream_id: streamId,
      turn_id: idOf(event.turnId) || idOf(admission.turn_id),
      work_id: idOf(admission.work_id),
    }, built.payload);
    state.seq += 1;
    return cliEvent;
  }

  // Host-originated frames (init, accepted, decision, status, result, ...) have no desktop
  // event. They are validated here so a host bug fails loudly instead of reaching the wire.
  function next(kind, payload, identities = {}) {
    if (state.finished) throw new Error('cli.v1 run already produced its result');
    if (!isRecord(identities) || Object.keys(identities).some((key) => !IDENTITY_KEYS.includes(key))) {
      throw new TypeError('cli.v1 identity keys are stream_id, turn_id, request_id, work_id');
    }
    const event = stamp(kind, identities, payload);
    const verdict = validateCliEvent(event);
    if (!verdict.ok) throw new TypeError(`invalid cli.v1 ${kind} frame: ${verdict.errors.join('; ')}`);
    if (kind === 'accepted') state.workId = event.work_id;
    if (kind === 'result') state.finished = true;
    state.seq += 1;
    return event;
  }

  return Object.freeze({ project, next, seq: () => state.seq });
}

module.exports = {
  CLI_EVENT_KINDS,
  CLI_LIMITS,
  EXIT_CODES,
  createEventProjector,
  validateCliEvent,
};
