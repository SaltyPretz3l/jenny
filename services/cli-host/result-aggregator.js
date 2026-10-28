'use strict';

// Folds one run's cli.v1 events into the single final `result` payload (Jenny CLI plan,
// decisions 6 and 8). The host decides WHY the run stopped (it owns signals, budgets and
// non-TTY decision handling); this module turns that reason plus what it observed into the
// frozen subtype and exit code. Pure: no I/O, no timers.

const { AI_ERROR_CODES, RUNTIME_ERROR_CODES, SIDECAR_ERROR_CODES } = require('../backend/error-codes');
const { CLI_PROFILE_ERROR_CODES } = require('./profile-lock');
const { CLI_LIMITS, EXIT_CODES } = require('./event-projection');

// Errors that mean "nothing ran because the engine or profile is not there", which an agent
// should retry later rather than treat as a model failure (exit 6). Kept explicit and small.
const ENGINE_UNAVAILABLE_CODES = Object.freeze([
  AI_ERROR_CODES.ENGINE_CONNECTION,
  SIDECAR_ERROR_CODES.PROCESS_EXIT,
  RUNTIME_ERROR_CODES.UNAVAILABLE,
  CLI_PROFILE_ERROR_CODES.LOCK_UNAVAILABLE,
  CLI_PROFILE_ERROR_CODES.LOCK_LOST,
]);

const REASONS = Object.freeze({
  complete: { subtype: 'success', exitCode: EXIT_CODES.OK },
  denied: { subtype: 'denied', exitCode: EXIT_CODES.POLICY_DENIED },
  input_required: { subtype: 'input_required', exitCode: EXIT_CODES.DECISION_REQUIRED },
  budget: { subtype: 'budget', exitCode: EXIT_CODES.BUDGET },
  timeout: { subtype: 'budget', exitCode: EXIT_CODES.BUDGET },
  cancelled: { subtype: 'cancelled', exitCode: null },
  error: { subtype: 'error', exitCode: null },
});
const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: EXIT_CODES.SIGINT, SIGTERM: EXIT_CODES.SIGTERM });
const RESUMABLE_REASONS = new Set(['tool_cap', 'max_iterations', 'diminishing_returns', 'context_budget',
  'runtime_budget', 'timeout', 'paused']);
const MAX_DENIALS = 64;
const RESULT_LIMIT = CLI_LIMITS.result_text;
const SEGMENT_SEPARATOR = '\n\n';

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function errorExitCode(code) {
  if (code === CLI_PROFILE_ERROR_CODES.BUSY) return EXIT_CODES.PROFILE_BUSY;
  return ENGINE_UNAVAILABLE_CODES.includes(code) ? EXIT_CODES.ENGINE_UNAVAILABLE : EXIT_CODES.RUNTIME_ERROR;
}

function normalizeUsage(value) {
  const usage = { input_tokens: count(value.input_tokens), output_tokens: count(value.output_tokens),
    total_tokens: count(value.total_tokens) };
  if (typeof value.estimated === 'boolean') usage.estimated = value.estimated;
  return usage;
}

function createResultAggregator({ run_id: runId, session_id: sessionId, started_at_ms: startedAtMs } = {}) {
  if (typeof runId !== 'string' || !runId || typeof sessionId !== 'string' || !sessionId) {
    throw new TypeError('result aggregator needs run_id and session_id');
  }
  if (!Number.isFinite(startedAtMs)) throw new TypeError('result aggregator needs a finite started_at_ms');
  // Text mirrors the desktop's segment model: a tool boundary closes the live slice into a
  // persisted segment; a reset erases everything (all), only the live slice (live_slice), or
  // nothing (none, and the slice it ended is kept as genuine commentary). Retained text is capped
  // at the result bound so a long run never grows memory without limit.
  const text = { segments: [], live: '', retained: 0, segmentsOverflow: false, liveOverflow: false };
  const state = { turns: 0, denials: [], deniedCalls: new Set(), plan: null, firstError: null, usage: null,
    resumableStop: null, workId: null, finished: false };

  function closeLive() {
    if (text.live) text.segments.push(text.live);
    text.segmentsOverflow ||= text.liveOverflow;
    text.live = '';
    text.liveOverflow = false;
  }

  function appendLive(chunk) {
    const room = RESULT_LIMIT - text.retained;
    if (chunk.length > room) text.liveOverflow = true;
    const kept = chunk.slice(0, Math.max(0, room));
    text.live += kept;
    text.retained += kept.length;
  }

  function reset(scope) {
    if (scope === 'all') {
      text.segments = [];
      text.live = '';
      text.retained = 0;
      text.segmentsOverflow = false;
      text.liveOverflow = false;
    } else if (scope === 'live_slice') {
      text.retained -= text.live.length;
      text.live = '';
      text.liveOverflow = false;
    } else {
      closeLive();
    }
  }

  function addUsage(usage) {
    const current = state.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    const sum = { input_tokens: current.input_tokens + usage.input_tokens,
      output_tokens: current.output_tokens + usage.output_tokens,
      total_tokens: current.total_tokens + usage.total_tokens };
    if (current.estimated === true || usage.estimated === true) sum.estimated = true;
    else if (typeof usage.estimated === 'boolean' || typeof current.estimated === 'boolean') sum.estimated = false;
    state.usage = sum;
  }

  function recordDenial(payload) {
    if (payload.outcome !== 'deny') return;
    if (typeof payload.call_id === 'string') state.deniedCalls.add(payload.call_id);
    if (state.denials.length >= MAX_DENIALS) return;
    const denial = { ref: payload.ref, request: payload.request, by: payload.by };
    for (const key of ['rule', 'call_id', 'tool_name']) {
      if (typeof payload[key] === 'string' && payload[key]) denial[key] = payload[key];
    }
    state.denials.push(denial);
  }

  // A tool the stored policy denied outright never raised an approval, so
  // its denied result is the only trace; it is a denial of this run too.
  function recordToolDenial(payload) {
    if (payload.status !== 'denied' || typeof payload.call_id !== 'string' || state.deniedCalls.has(payload.call_id)) return;
    recordDenial({ ref: payload.call_id, request: 'tool_approval', outcome: 'deny', by: 'policy', rule: 'policy_denied',
      call_id: payload.call_id, tool_name: payload.tool_name });
  }

  function planText(plan) {
    const lines = [plan.title];
    if (plan.summary) lines.push('', plan.summary);
    if (plan.steps.length) lines.push('', ...plan.steps.map((step, index) => `${index + 1}. ${step}`));
    return lines.join('\n');
  }

  function observe(event) {
    if (state.finished || !isRecord(event) || event.run_id !== runId || event.session_id !== sessionId) return;
    const payload = isRecord(event.payload) ? event.payload : {};
    if (typeof event.work_id === 'string') state.workId = event.work_id;
    switch (event.kind) {
      case 'started': state.turns += 1; closeLive(); break;
      case 'delta': appendLive(typeof payload.text === 'string' ? payload.text : ''); break;
      case 'tool_use': closeLive(); break;
      case 'tool_result': recordToolDenial(payload); break;
      case 'plan_proposed':
        state.plan = { title: String(payload.title || ''), summary: typeof payload.summary === 'string' ? payload.summary : '',
          steps: Array.isArray(payload.steps) ? payload.steps.map(String) : [] };
        break;
      case 'reset': reset(payload.discard_scope); break;
      case 'decision': recordDenial(payload); break;
      case 'error': state.firstError ||= { code: payload.code }; break;
      case 'complete':
        if (isRecord(payload.usage)) addUsage(normalizeUsage(payload.usage));
        if (typeof payload.resumable_stop === 'string') state.resumableStop = payload.resumable_stop;
        break;
      default: break;
    }
  }

  // The run's text; when the turn produced none and ended on a plan that
  // waited for a person, the plan is what the caller needs to read.
  function resultText() {
    const spoken = [...text.segments, text.live].filter((segment) => segment.trim()).join(SEGMENT_SEPARATOR);
    const joined = !spoken && state.plan?.title ? planText(state.plan) : spoken;
    if (joined.length <= RESULT_LIMIT) return { result: joined, truncated: text.segmentsOverflow || text.liveOverflow };
    let end = RESULT_LIMIT;
    const last = joined.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return { result: joined.slice(0, end), truncated: true };
  }

  function resumableStopOf(explicit) {
    if (explicit !== undefined && explicit !== null) {
      if (!isRecord(explicit) || !RESUMABLE_REASONS.has(explicit.reason)) {
        throw new TypeError('resumable_stop needs a known reason');
      }
      return typeof explicit.work_id === 'string' && explicit.work_id
        ? { reason: explicit.reason, work_id: explicit.work_id } : { reason: explicit.reason };
    }
    if (!state.resumableStop) return null;
    return state.workId ? { reason: state.resumableStop, work_id: state.workId } : { reason: state.resumableStop };
  }

  function finish({ reason, now_ms: nowMs, usage, signal, resumable_stop: resumableStop } = {}) {
    if (state.finished) throw new Error('finish may be called once per run');
    const mapping = Object.hasOwn(REASONS, reason) ? REASONS[reason] : null;
    if (!mapping) throw new TypeError(`unknown finish reason: ${String(reason)}`);
    if (!Number.isFinite(nowMs)) throw new TypeError('finish needs a finite now_ms');
    let exitCode = mapping.exitCode;
    if (reason === 'cancelled') {
      exitCode = Object.hasOwn(SIGNAL_EXIT_CODES, signal) ? SIGNAL_EXIT_CODES[signal] : null;
      if (exitCode === null) throw new TypeError('a cancelled finish needs signal SIGINT or SIGTERM');
    } else if (reason === 'error') {
      exitCode = errorExitCode(state.firstError?.code);
    }
    const stop = resumableStopOf(resumableStop);
    const { result, truncated } = resultText();
    const payload = {
      subtype: mapping.subtype,
      is_error: exitCode !== EXIT_CODES.OK,
      exit_code: exitCode,
      session_id: sessionId,
      result,
      ...(truncated ? { truncated: true } : {}),
      usage: isRecord(usage) ? normalizeUsage(usage) : (state.usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
      num_turns: state.turns,
      duration_ms: Math.max(0, Math.round(nowMs - startedAtMs)),
      permission_denials: state.denials.map((denial) => ({ ...denial })),
      ...(stop ? { resumable_stop: stop } : {}),
      ...(state.firstError ? { error_code: state.firstError.code } : {}),
    };
    state.finished = true;
    return payload;
  }

  return Object.freeze({ observe, finish });
}

module.exports = { ENGINE_UNAVAILABLE_CODES, createResultAggregator };
