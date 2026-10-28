'use strict';

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { normalizeText: normalizeString } = require('../../shared/normalize');
const { manifestSchema } = require('./tool-result');

const MAX_RECENT_LOG_LIMIT = 50;

function normalizePositiveInteger(value, max) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  return Math.min(numeric, max);
}

// The session is the calling chat's, from the trusted context; a model-supplied
// session_id is ignored so one chat cannot read another's cost details. The
// harness facet (the whole tools/memories/skills inspection) is opt-in: most
// status questions never need it and composing it costs a sidecar round-trip.
function normalizeStatusOptions(input, context) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const options = { include_harness: source.include_harness === true };
  const sessionId = normalizeString(context.sessionId);
  if (sessionId) {
    options.session_id = sessionId;
  }
  const recentLogLimit = normalizePositiveInteger(source.recent_log_limit, MAX_RECENT_LOG_LIMIT);
  if (recentLogLimit != null) {
    options.recent_log_limit = recentLogLimit;
  }
  if (context.executionAuthority) {
    options.executionAuthority = context.executionAuthority;
  }
  return options;
}

// Usage history is global; its per-turn rows are narrowed to the calling chat.
function scopeUsageToSession(status, sessionId) {
  const usage = status?.usage;
  if (!usage || !Array.isArray(usage.recent_turns)) return status;
  return {
    ...status,
    usage: {
      ...usage,
      recent_turns: sessionId ? usage.recent_turns.filter((row) => row?.session_id === sessionId) : [],
    },
  };
}

function summarizeStatusPayload(status) {
  const backendPhase = normalizeString(status?.backend?.phase || 'unknown') || 'unknown';
  const model = normalizeString(status?.runtime?.model);
  return model
    ? `Jenny status: ${backendPhase} (${model})`
    : `Jenny status: ${backendPhase}`;
}

function unavailableResult(message) {
  return {
    content: message,
    summary: 'Jenny status unavailable',
    isError: true,
    errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
    metadata: {
      result_kind: 'jenny_status',
      unavailable: true,
    },
  };
}

module.exports = {
  name: 'jenny_status',
  ...manifestSchema('jenny_status'),
  category: 'diagnostics',
  readOnly: true,
  workspaceRequired: false,

  summarize() {
    return 'Jenny status';
  },

  async execute(input, context = {}) {
    const backendService = context?.backendService;
    if (!backendService || typeof backendService.getJennyStatus !== 'function') {
      return unavailableResult('Jenny status is unavailable: backend service is not attached.');
    }

    try {
      const options = normalizeStatusOptions(input, context);
      const status = scopeUsageToSession(await backendService.getJennyStatus(options), options.session_id || '');
      return {
        // Compact: the model reads JSON fine and indentation only spends tokens.
        content: JSON.stringify(status),
        summary: summarizeStatusPayload(status),
        isError: false,
        metadata: {
          result_kind: 'jenny_status',
          schema_version: status?.schema_version ?? null,
          generated_at: normalizeString(status?.generated_at),
        },
      };
    } catch (_error) {
      return unavailableResult('Jenny status is unavailable because status composition failed.');
    }
  },
};
