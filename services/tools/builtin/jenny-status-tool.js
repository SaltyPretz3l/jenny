'use strict';

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { normalizeText: normalizeString } = require('../../shared/normalize');
const { invalidArguments, manifestSchema } = require('./tool-result');

const MAX_RECENT_LOG_LIMIT = 50;
const MAX_SECTION_CHARS = 64;
// Not parts of the status: the identity and timing fields every result carries.
const ENVELOPE_KEYS = new Set(['facade', 'schema_version', 'generated_at']);

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
  // The harness part is skipped unless it is composed, so asking for it by name composes it.
  const options = { include_harness: source.include_harness === true || source.section === 'harness' };
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

// Row 129 C9: the status is large (about 16,000 characters), so the default result is an overview that
// names its parts, and `section` returns one part whole.
function sectionNames(status) {
  return Object.keys(status || {}).filter((key) => !ENVELOPE_KEYS.has(key));
}

function overviewOf(status) {
  const names = sectionNames(status);
  return {
    facade: 'jenny_status',
    schema_version: status?.schema_version ?? null,
    generated_at: status?.generated_at ?? null,
    backend: { phase: status?.backend?.phase ?? null, app_version: status?.backend?.app_version ?? null },
    runtime: { engine: status?.runtime?.engine ?? null, model: status?.runtime?.model ?? null, model_loaded: status?.runtime?.model_loaded ?? null },
    sections: names,
    // A part that was only skipped (the harness, unless asked for) is still readable by name.
    unavailable: names.filter((name) => status[name]?.available === false && status[name]?.skipped !== true),
    how: 'This is an overview. Call jenny_status again with section set to one of the names in sections to get that part in full.',
  };
}

function requestedSection(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input.section : undefined;
  if (raw === undefined || raw === null) return { value: '' };
  if (typeof raw !== 'string' || raw.length > MAX_SECTION_CHARS) return { error: true };
  return { value: raw.trim() };
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
      const section = requestedSection(input);
      if (section.error) {
        return invalidArguments('jenny_status', { label: 'Jenny status', content: 'section must be one of the part names listed by calling jenny_status without arguments.' });
      }
      const options = normalizeStatusOptions({ ...input, section: section.value }, context);
      const status = scopeUsageToSession(await backendService.getJennyStatus(options), options.session_id || '');
      if (section.value && !sectionNames(status).includes(section.value)) {
        return invalidArguments('jenny_status', { label: 'Jenny status',
          content: `section "${section.value.slice(0, MAX_SECTION_CHARS)}" is not a part of the status. Use one of: ${sectionNames(status).join(', ')}.` });
      }
      const shown = !section.value ? overviewOf(status) : {
        facade: 'jenny_status', schema_version: status.schema_version ?? null, generated_at: status.generated_at ?? null,
        section: section.value, [section.value]: status[section.value],
      };
      return {
        // Compact: the model reads JSON fine and indentation only spends tokens.
        content: JSON.stringify(shown),
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
