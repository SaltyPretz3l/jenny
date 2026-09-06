'use strict';

const POSITIVE_TELEMETRY_FIELDS = Object.freeze([
  'generation_tokens',
  'generation_duration_ms',
  'prompt_eval_duration_ms',
  'load_duration_ms',
  'time_to_first_token_ms',
]);

function positiveTelemetry(usage) {
  const telemetry = {};
  for (const field of POSITIVE_TELEMETRY_FIELDS) {
    const numeric = Number(usage?.[field]);
    if (Number.isFinite(numeric) && numeric > 0) telemetry[field] = numeric;
  }
  return telemetry;
}

function resolveCost(usage) {
  let source = ['local_zero', 'provider', 'unavailable'].includes(usage?.cost_source)
    ? usage.cost_source
    : 'unavailable';
  const amount = usage?.cost_usd;
  if (source === 'local_zero') return { source, amount: 0 };
  if (source === 'provider' && typeof amount === 'number'
    && Number.isFinite(amount) && amount >= 0) {
    return { source, amount };
  }
  source = 'unavailable';
  return { source, amount: null };
}

function rebuildChatDoneUsage(usage, fallbackModel = '') {
  const cost = resolveCost(usage);
  return {
    input_tokens: Number(usage?.input_tokens || 0) || 0,
    output_tokens: Number(usage?.output_tokens || 0) || 0,
    total_tokens: Number(usage?.total_tokens || 0) || 0,
    ...positiveTelemetry(usage),
    estimated: usage?.estimated === true,
    context_tokens_estimate: Number(usage?.context_tokens_estimate || 0) || 0,
    context_used_tokens: Number(usage?.context_used_tokens || 0) || 0,
    context_used_source: usage?.context_used_source === 'provider' ? 'provider'
      : usage?.context_used_source === 'estimate' ? 'estimate' : '',
    context_window: Number(usage?.context_window || 0) || 0,
    last_request_input_tokens: Number(usage?.last_request_input_tokens || 0) || 0,
    compact_threshold_tokens: Number(usage?.compact_threshold_tokens || 0) || 0,
    cost_usd: cost.amount,
    cost_source: cost.source,
    model: String(usage?.model || fallbackModel),
    provider: String(usage?.provider || ''),
  };
}

// Mid-turn `context.usage` -> renderer `context_usage` control event.
//
// The snapshot is EPHEMERAL: it moves the composer context ring during a long
// agentic turn and is never persisted. `params` is the raw snake_case
// notification payload, which is deliberately shaped like a `chat.done` usage
// block so the SAME normalizer (`rebuildChatDoneUsage`) produces both the
// mid-turn and the terminal `usage` object — the renderer store cannot then
// disagree with itself about which fields exist or how they are named.
//
// Built key-by-key: the notification params are never spread into the event.
function buildContextUsageStreamEvent(params, fallbackModel = '') {
  const source = params && typeof params === 'object' ? params : {};
  const phase = source.phase === 'preflight' ? 'preflight' : 'iteration';
  return {
    type: 'context_usage',
    iteration: Math.max(0, Number(source.iteration || 0) || 0),
    phase,
    usage: rebuildChatDoneUsage(source, fallbackModel),
  };
}

module.exports = { buildContextUsageStreamEvent, rebuildChatDoneUsage };
