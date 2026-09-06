'use strict';

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { normalizeText: normalizeString } = require('../../shared/normalize');

const MAX_RECENT_LOG_LIMIT = 50;

function normalizePositiveInteger(value, max) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return null;
  }
  return Math.min(numeric, max);
}

function normalizeBooleanOption(source, snakeName, camelName) {
  if (source[snakeName] === true || source[camelName] === true) {
    return true;
  }
  if (source[snakeName] === false || source[camelName] === false) {
    return false;
  }
  return undefined;
}

function normalizeStatusOptions(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const options = {};
  const sessionId = normalizeString(source.session_id || source.sessionId);
  if (sessionId) {
    options.session_id = sessionId;
  }
  const recentLogLimit = normalizePositiveInteger(
    source.recent_log_limit ?? source.recentLogLimit,
    MAX_RECENT_LOG_LIMIT
  );
  if (recentLogLimit != null) {
    options.recent_log_limit = recentLogLimit;
  }
  const includeHarness = normalizeBooleanOption(source, 'include_harness', 'includeHarness');
  if (includeHarness != null) {
    options.include_harness = includeHarness;
  }
  return options;
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
  description: 'Returns a read-only Jenny status snapshot across backend, runtime, harness, logs, cost, schemas, and budget posture.',
  category: 'diagnostics',
  readOnly: true,
  workspaceRequired: false,
  parameters: {
    type: 'object',
    properties: {
      session_id: {
        type: 'string',
        description: 'Optional session id for session-scoped cost details.',
      },
      recent_log_limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_RECENT_LOG_LIMIT,
        description: 'Maximum number of recent log entries and warning/error samples to include.',
      },
      include_harness: {
        type: 'boolean',
        description: 'Whether to include the harness inspection facet. Defaults to true.',
      },
    },
    additionalProperties: false,
  },

  summarize() {
    return 'Jenny status';
  },

  async execute(input, context) {
    const backendService = context?.backendService;
    if (!backendService || typeof backendService.getJennyStatus !== 'function') {
      return unavailableResult('Jenny status is unavailable: backend service is not attached.');
    }

    try {
      const options = normalizeStatusOptions(input);
      const status = await backendService.getJennyStatus(options);
      return {
        content: JSON.stringify(status, null, 2),
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
