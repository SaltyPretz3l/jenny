'use strict';

const { normalizeString } = require('../renderer/shared/string-utils');
const {
  SCHEDULED_TASKS_SCHEMA_VERSION,
} = require('./scheduler-schema-version');

const AUTOMATION_ID_PREFIX = 'automation:';
const AUTOMATION_DEFAULT_INTERVAL_SECONDS = 24 * 60 * 60;
const AUTOMATION_DEFAULT_MAX_RUNS = 20;
const AUTOMATION_MAX_RUNS_PER_TASK = 50;
const AUTOMATION_DEFAULT_MAX_LOG_BYTES = 20_000;
const AUTOMATION_MAX_LOG_BYTES = 100_000;
const AUTOMATION_MAX_SUMMARY_LENGTH = 2_000;
const AUTOMATION_MAX_TEXT_LENGTH = 4_000;
const AUTOMATION_MAX_TOKEN_LENGTH = 128;
const AUTOMATION_MAX_TIMESTAMP_LENGTH = 128;
const AUTOMATION_MAX_TOOL_GRANTS = 20;
const AUTOMATION_MAX_POLICY_FLAGS = 20;
const AUTOMATION_MAX_ARTIFACTS_PER_RUN = 20;
const AUTOMATION_MIN_RUNTIME_BUDGET_MS = 30_000;
const AUTOMATION_MAX_RUNTIME_BUDGET_MS = 1_800_000;

function truncateText(value, maxLength) {
  const text = normalizeString(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  const integerValue = Math.trunc(parsed);
  return Math.max(1, integerValue);
}

function normalizeTrigger(source, fallback) {
  const sourceTrigger = source && typeof source === 'object' && !Array.isArray(source)
    ? source
    : {};
  const fallbackTrigger = fallback && typeof fallback === 'object' && !Array.isArray(fallback)
    ? fallback
    : { type: 'interval', interval_seconds: 1 };
  const type = normalizeString(sourceTrigger.type).toLowerCase() || fallbackTrigger.type || 'interval';
  return {
    type: type === 'interval' ? 'interval' : fallbackTrigger.type || 'interval',
    interval_seconds: normalizePositiveInteger(
      sourceTrigger.interval_seconds,
      normalizePositiveInteger(fallbackTrigger.interval_seconds, 1)
    ),
  };
}

function normalizeIdentifier(value, maxLength = AUTOMATION_MAX_TOKEN_LENGTH) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLength);
}

function normalizeUniqueTokens(value, {
  maxItems = AUTOMATION_MAX_TOOL_GRANTS,
  maxLength = AUTOMATION_MAX_TOKEN_LENGTH,
} = {}) {
  const source = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const token = normalizeIdentifier(item, maxLength);
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    out.push(token);
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

const VALID_AUTOMATION_RUN_STATUSES = new Set([
  'pending',
  'started',
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);

function normalizeNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
}

function normalizeBoundedPositiveInteger(value, fallback, maxValue) {
  const parsed = normalizePositiveInteger(value, fallback);
  return Math.min(parsed, maxValue);
}

function normalizeAutomationBudget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return {
    runtime_ms: normalizeNonNegativeInteger(value.runtime_ms),
    tool_calls: normalizeNonNegativeInteger(value.tool_calls),
  };
}

function normalizeAutomationBoundedText(value) {
  return normalizeString(value).slice(0, AUTOMATION_MAX_TOKEN_LENGTH);
}

function normalizeAutomationTimestamp(value) {
  return normalizeString(value).slice(0, AUTOMATION_MAX_TIMESTAMP_LENGTH);
}

function normalizeAutomationArtifacts(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const artifactId = normalizeString(entry.artifact_id || entry.id).slice(0, AUTOMATION_MAX_TOKEN_LENGTH);
    if (!artifactId) continue;
    out.push({
      artifact_id: artifactId,
      kind: normalizeIdentifier(entry.kind || 'artifact', AUTOMATION_MAX_TOKEN_LENGTH) || 'artifact',
      title: truncateText(entry.title, 200),
    });
    if (out.length >= AUTOMATION_MAX_ARTIFACTS_PER_RUN) break;
  }
  return out;
}

function normalizeAutomationRun(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const runId = normalizeString(entry.run_id).slice(0, AUTOMATION_MAX_TOKEN_LENGTH);
  if (!runId) {
    return null;
  }
  const requestedStatus = normalizeString(entry.status).toLowerCase();
  const status = VALID_AUTOMATION_RUN_STATUSES.has(requestedStatus)
    ? requestedStatus
    : 'pending';
  return {
    run_id: runId,
    status,
    reason: normalizeAutomationBoundedText(entry.reason),
    started_at: normalizeAutomationTimestamp(entry.started_at),
    completed_at: normalizeAutomationTimestamp(entry.completed_at),
    summary: truncateText(entry.summary, AUTOMATION_MAX_SUMMARY_LENGTH),
    budget: normalizeAutomationBudget(entry.budget),
    artifacts: normalizeAutomationArtifacts(entry.artifacts),
    result_ref: normalizeString(entry.result_ref).slice(0, AUTOMATION_MAX_TOKEN_LENGTH * 2),
  };
}

function normalizeAutomationRuns(value, maxRuns = AUTOMATION_DEFAULT_MAX_RUNS) {
  if (!Array.isArray(value)) {
    return [];
  }
  const boundedMaxRuns = normalizeBoundedPositiveInteger(
    maxRuns,
    AUTOMATION_DEFAULT_MAX_RUNS,
    AUTOMATION_MAX_RUNS_PER_TASK
  );
  const out = [];
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const entry = value[index];
    const normalized = normalizeAutomationRun(entry);
    if (!normalized) continue;
    out.push(normalized);
    if (out.length >= boundedMaxRuns) break;
  }
  return out.reverse();
}

function normalizeAutomationRetention(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    max_runs: normalizeBoundedPositiveInteger(
      source.max_runs,
      AUTOMATION_DEFAULT_MAX_RUNS,
      AUTOMATION_MAX_RUNS_PER_TASK
    ),
    max_log_bytes: normalizeBoundedPositiveInteger(
      source.max_log_bytes,
      AUTOMATION_DEFAULT_MAX_LOG_BYTES,
      AUTOMATION_MAX_LOG_BYTES
    ),
  };
}

function normalizeAutomationRuntimeBudgetMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(
    Math.max(Math.trunc(parsed), AUTOMATION_MIN_RUNTIME_BUDGET_MS),
    AUTOMATION_MAX_RUNTIME_BUDGET_MS
  );
}

function normalizeAutomationPolicy(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const requiresFeatureFlags = normalizeUniqueTokens(source.requires_feature_flags, {
    maxItems: AUTOMATION_MAX_POLICY_FLAGS,
  });
  if (!requiresFeatureFlags.includes('tools_automations_enabled')) {
    requiresFeatureFlags.unshift('tools_automations_enabled');
  }
  const policy = {
    requires_feature_flags: requiresFeatureFlags.slice(0, AUTOMATION_MAX_POLICY_FLAGS),
    defer_when_chat_active: source.defer_when_chat_active !== false,
  };
  const runtimeBudgetMs = normalizeAutomationRuntimeBudgetMs(source.runtime_budget_ms);
  if (runtimeBudgetMs !== null) {
    policy.runtime_budget_ms = runtimeBudgetMs;
  }
  return policy;
}

function normalizeAutomationInput(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const isolation = source.isolation && typeof source.isolation === 'object' && !Array.isArray(source.isolation)
    ? source.isolation
    : {};
  const mode = normalizeIdentifier(isolation.mode || source.isolation_mode);
  return {
    task_spec: truncateText(source.task_spec || source.prompt, AUTOMATION_MAX_TEXT_LENGTH),
    tool_grants: normalizeUniqueTokens(source.tool_grants, {
      maxItems: AUTOMATION_MAX_TOOL_GRANTS,
    }),
    isolation: {
      mode: mode === 'worktree' ? 'worktree' : 'read_only',
    },
  };
}

function normalizeAutomationId(value) {
  const id = normalizeIdentifier(value);
  if (!id.startsWith(AUTOMATION_ID_PREFIX) || id.length <= AUTOMATION_ID_PREFIX.length) {
    return '';
  }
  return id;
}

function normalizeAutomationTask(source, nowIso) {
  const id = normalizeAutomationId(source.id);
  if (!id) {
    return null;
  }
  const retention = normalizeAutomationRetention(source.retention);
  const task = normalizeIdentifier(source.task) || id.slice(AUTOMATION_ID_PREFIX.length) || 'automation';
  return {
    id,
    task,
    kind: 'automation',
    enabled: source.enabled === true,
    trigger: normalizeTrigger(
      source.trigger,
      { type: 'interval', interval_seconds: AUTOMATION_DEFAULT_INTERVAL_SECONDS }
    ),
    policy: normalizeAutomationPolicy(source.policy),
    input: normalizeAutomationInput(source.input),
    retention,
    automation_runs: normalizeAutomationRuns(source.automation_runs, retention.max_runs),
    last_status: normalizeAutomationBoundedText(source.last_status),
    last_reason: normalizeAutomationBoundedText(source.last_reason),
    last_started_at: normalizeAutomationTimestamp(source.last_started_at),
    last_result_at: normalizeAutomationTimestamp(source.last_result_at),
    last_completed_at: normalizeAutomationTimestamp(source.last_completed_at),
    updated_at: normalizeAutomationTimestamp(source.updated_at) || nowIso,
  };
}

function normalizeTask(entry, nowIso) {
  const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  if (normalizeString(source.kind).toLowerCase() === 'automation') {
    return normalizeAutomationTask(source, nowIso);
  }
  return null;
}

function normalizeScheduledTasks(payload, now = new Date()) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const nowIso = now.toISOString();
  const tasks = [];
  const seen = new Set();
  for (const entry of Array.isArray(source.tasks) ? source.tasks : []) {
    const normalized = normalizeTask(entry, nowIso);
    if (!normalized || seen.has(normalized.id)) {
      continue;
    }
    seen.add(normalized.id);
    tasks.push(normalized);
  }
  return {
    version: SCHEDULED_TASKS_SCHEMA_VERSION,
    tasks,
  };
}

module.exports = {
  AUTOMATION_MAX_RUNS_PER_TASK,
  normalizeAutomationRun,
  normalizeAutomationRuns,
  normalizeAutomationRetention,
  normalizeScheduledTasks,
};
