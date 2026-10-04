'use strict';

const { redactSecretLikeText, redactSensitiveLikeText } = require('./tool-loop-input-sanitization');

const MAX_SUMMARY_CHARS = 1000;
const MAX_FIELD_CHARS = 300;
const MAX_ID_CHARS = 200;
const MAX_LABEL_CHARS = 80;
const MAX_EVIDENCE_ITEMS = 12;
const MAX_UNCERTAINTIES = 8;
const MAX_TOOLS = 20;
const MAX_BATCH_TASKS = 3;
const MAX_BATCH_TASK_CANDIDATES = 12;
const MAX_TOKEN_COUNT = 2147483647;
const MAX_ROUTES = 6;
const MAX_ANSWER_CHARS = 4000;
const MAX_STEPS = 40;
const MAX_STEP_NAME_CHARS = 64;
const MAX_STEP_TEXT_CHARS = 160;
const REPORT_STATUSES = new Set([
  'completed', 'partial', 'failed', 'cancelled', 'rejected', 'skipped_budget',
]);
const TERMINAL_REASONS = new Set([
  'deadline_exceeded', 'budget_exhausted', 'max_iterations_summary', 'capacity_unavailable',
  'cancelled', 'invalid_report', 'runtime_unavailable', 'rejected',
]);
const EXECUTION_MODES = new Set(['single', 'sequential', 'parallel']);
const EVIDENCE_PROVENANCE = new Set(['tool_observed']);
const EVIDENCE_SOURCE_TOOLS = new Set(['read_file', 'grep_search', 'git_status']);
const EVIDENCE_TRUST = new Set(['model_reported_unverified', 'tool_observed', 'none']);

function normalizeSubagentMetadata(metadata) {
  const source = isRecord(metadata) ? metadata : {};
  const result = {};
  const single = normalizeSubagentReport(source.subagent_report);
  const batch = normalizeSubagentBatchReport(source.subagent_batch_report);
  if (single) result.subagent_report = single;
  if (batch) result.subagent_batch_report = batch;
  return Object.keys(result).length ? result : null;
}

function normalizeSubagentReport(value) {
  if (!isRecord(value)) return null;
  const taskId = safeText(value.task_id, MAX_ID_CHARS);
  // The label, summary and answer are read in the app (the monitor, the
  // inline card): real paths, like the timeline (HB-012); secrets redacted.
  const summary = safeText(value.summary, MAX_SUMMARY_CHARS, KEEP_PATHS);
  const status = safeEnum(value.status, REPORT_STATUSES, null);
  if (!taskId || !summary || !status
    || !Array.isArray(value.evidence)
    || !Array.isArray(value.tools_used)
    || !Array.isArray(value.uncertainties)) return null;
  const report = {
    task_id: taskId,
    label: safeText(value.label, MAX_LABEL_CHARS, KEEP_PATHS) || 'Research subagent',
    summary,
    evidence: normalizeEvidence(value.evidence),
    tools_used: normalizeStringList(value.tools_used, MAX_TOOLS, 64),
    uncertainties: normalizeStringList(value.uncertainties, MAX_UNCERTAINTIES, MAX_FIELD_CHARS),
    budget: normalizeBudget(value.budget),
    status,
    agent_id: safeText(value.agent_id, MAX_ID_CHARS) || null,
    parent_agent_id: safeText(value.parent_agent_id, MAX_ID_CHARS) || null,
    usage: normalizeUsage(value.usage),
    terminal_reason: safeEnum(value.terminal_reason, TERMINAL_REASONS, null),
    error: normalizeError(value.error),
  };
  // UI-only monitor fields; absent on older reports and omitted when empty.
  const answer = safeMultilineText(value.answer, MAX_ANSWER_CHARS, KEEP_PATHS);
  if (answer) report.answer = answer;
  const steps = normalizeSteps(value.steps);
  if (steps.length) report.steps = steps;
  return report;
}

function normalizeSubagentBatchReport(value) {
  if (!isRecord(value) || !Array.isArray(value.tasks)) return null;
  const batchId = safeText(value.batch_id, MAX_ID_CHARS);
  const status = safeEnum(value.status, REPORT_STATUSES, null);
  if (!batchId || !status) return null;
  const tasks = value.tasks
    .slice(0, MAX_BATCH_TASK_CANDIDATES)
    .map(normalizeBatchTask)
    .filter(Boolean)
    .slice(0, MAX_BATCH_TASKS);
  if (!tasks.length) return null;
  return {
    result_kind: 'subagent_batch_report',
    batch_id: batchId,
    status,
    source_tool: safeText(value.source_tool, 64) || null,
    execution: safeEnum(value.execution, EXECUTION_MODES, null),
    tasks,
    budget: normalizeBudget(value.budget),
    usage: normalizeAggregateUsage(value.usage),
  };
}

function normalizeBatchTask(value, index) {
  if (!isRecord(value)) return null;
  const report = normalizeSubagentReport({
    ...value,
    label: value.label || `Research task ${index + 1}`,
  });
  if (!report) return null;
  return {
    ...report,
    ordinal: boundedInteger(value.ordinal, index + 1, 1, MAX_BATCH_TASKS),
    evidence_trust: safeEnum(
      value.evidence_trust,
      EVIDENCE_TRUST,
      'model_reported_unverified',
    ),
  };
}

function normalizeUsage(value) {
  if (!isRecord(value)) return null;
  const result = {};
  for (const key of [
    'input_tokens', 'output_tokens', 'total_tokens', 'last_request_input_tokens',
    'context_tokens_estimate', 'context_window', 'compact_threshold_tokens',
  ]) {
    const count = optionalInteger(value[key], 0, MAX_TOKEN_COUNT);
    if (count != null) result[key] = count;
  }
  const provider = safeRoute(value.provider);
  const model = safeRoute(value.model);
  if (provider) result.provider = provider;
  if (model) result.model = model;
  if (!Object.keys(result).length) return null;
  result.estimated = value.estimated === true;
  return result;
}

function normalizeAggregateUsage(value) {
  const usage = normalizeUsage(value) || {};
  const providers = normalizeRoutes(value && value.providers);
  const models = normalizeRoutes(value && value.models);
  if (providers.length) usage.providers = providers;
  if (models.length) usage.models = models;
  return Object.keys(usage).length ? usage : null;
}

function normalizeEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_EVIDENCE_ITEMS).map((entry) => {
    const source = typeof entry === 'string' ? { summary: entry } : entry;
    if (!isRecord(source)) return null;
    const record = {};
    for (const key of ['source', 'summary', 'quote', 'fact', 'value']) {
      const text = safeText(source[key], MAX_FIELD_CHARS);
      if (text) record[key] = text;
    }
    const sourceTool = safeEnum(source.source_tool, EVIDENCE_SOURCE_TOOLS, null);
    if (sourceTool) record.source_tool = sourceTool;
    const relativePath = normalizeRelativePath(
      source.relative_path || source.relativePath || source.path
    );
    if (relativePath) record.relative_path = relativePath;
    const lineStart = optionalInteger(source.line_start, 1, MAX_TOKEN_COUNT);
    const lineEnd = optionalInteger(source.line_end, 1, MAX_TOKEN_COUNT);
    if (lineStart != null) {
      record.line_start = lineStart;
      record.line_end = Math.max(lineStart, lineEnd == null ? lineStart : lineEnd);
    }
    const provenance = sourceTool
      ? safeEnum(source.provenance, EVIDENCE_PROVENANCE, null)
      : null;
    if (provenance) record.provenance = provenance;
    return Object.keys(record).length ? record : null;
  }).filter(Boolean);
}

function normalizeSteps(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_STEPS).map((entry) => {
    if (!isRecord(entry)) return null;
    const tool = safeText(entry.tool, MAX_STEP_NAME_CHARS);
    if (!tool) return null;
    const step = {
      tool,
      display: safeText(entry.display, MAX_STEP_NAME_CHARS) || tool,
      ok: entry.ok === true,
    };
    // Only an admitted (ok) call keeps a target: a refused one may name a path
    // outside the workspace, so its row carries the scrubbed error alone. Only
    // a refused call keeps an error line: a successful one has no output here.
    if (step.ok) {
      // Gate the raw value: the shared redactor keeps a basename, which could pass the check.
      const raw = typeof entry.target === 'string' ? entry.target.replace(INVISIBLE_RE, '') : '';
      const target = raw && !namesOutsidePath(raw) ? safeText(raw, MAX_STEP_TEXT_CHARS) : '';
      if (target) step.target = target;
      return step;
    }
    const errorCode = safeText(entry.error_code, MAX_STEP_NAME_CHARS);
    if (errorCode) step.error_code = errorCode;
    // Scrub before safeText: its path redaction keeps the basename, which can name an outside file.
    const detail = safeText(scrubStepPaths(entry.detail), MAX_STEP_TEXT_CHARS);
    if (detail) step.detail = detail;
    return step;
  }).filter(Boolean);
}

// A target is a relative path, or `"pattern" in <relative path>`; an absolute,
// UNC, home-relative or parent-relative run anywhere after a space (or at the
// start) names a location outside the workspace.
function namesOutsidePath(text) {
  return /[A-Za-z]:[\\/]/.test(text)
    || /(^|[\s"'(=:])(?:[\\/]|~[\\/])/.test(text)
    || /(^|[\s\\/])\.\.([\\/]|$)/.test(text);
}

// Defence in depth over the sidecar's own scrub: quoted paths, UNC shares,
// drive, home-relative and parent-relative paths in an error line become
// `<path>` before persistence. Invisible characters go first so they cannot
// split a path past the patterns; a path run keeps eating words that hold a
// separator so a spaced directory name does not survive the first match.
const SPACED_PATH_TAIL = String.raw`(?: [^\s"'\x60<>|()]*[\\/][^\s"'\x60<>|()]*)*`;
const QUOTED_PATH_RE = /(['"])(?=[^'"\n]*[\\/])[^'"\n]*\1/g;
const UNC_PATH_RE = new RegExp(String.raw`(?:\\\\|//)[^\s"'\x60<>|\\/()]+[\\/][^\s"'\x60<>|()]*` + SPACED_PATH_TAIL, 'g');
const DRIVE_PATH_RE = new RegExp(String.raw`[A-Za-z]:[\\/][^\s"'\x60<>|()]*` + SPACED_PATH_TAIL, 'g');
const PARENT_PATH_RE = /(?:\.\.[\\/])+[^\s"'`<>|()]*/g;
const HOME_PATH_RE = /(^|[^\w.])~[\\/][^\s"'`<>|()]*/g;
const POSIX_PATH_RE = new RegExp(String.raw`(^|[\s"'(=:])/[^\s"'\x60<>|()]+` + SPACED_PATH_TAIL, 'g');
// eslint-disable-next-line no-control-regex -- strips untrusted wire controls before the path scrub.
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

function scrubStepPaths(text) {
  return String(typeof text === 'string' ? text : '').slice(0, 2000)
    .replace(INVISIBLE_RE, '')
    .replace(QUOTED_PATH_RE, '<path>')
    .replace(UNC_PATH_RE, '<path>')
    .replace(DRIVE_PATH_RE, '<path>')
    .replace(PARENT_PATH_RE, '<path>')
    .replace(HOME_PATH_RE, '$1<path>')
    .replace(POSIX_PATH_RE, '$1<path>');
}

function normalizeBudget(value) {
  if (!isRecord(value)) return {};
  const result = {};
  for (const [key, maximum] of Object.entries({
    max_steps: 32,
    iterations_used: 32,
    tool_results_used: 10000,
    max_runtime_ms: 600000,
    elapsed_ms: 600000,
    max_tasks: 3,
    tasks_requested: 3,
    tasks_started: 3,
    tasks_completed: 3,
    tasks_partial: 3,
    max_total_steps: 32,
    effective_max_total_runtime_ms: 600000,
    max_total_runtime_ms: 600000,
    parent_synthesis_reserve_ms: 600000,
  })) {
    const count = optionalInteger(value[key], 0, maximum);
    if (count != null) result[key] = count;
  }
  return result;
}

function normalizeError(value) {
  if (!isRecord(value)) return null;
  const code = safeText(value.code, 64);
  const message = safeText(value.message, MAX_FIELD_CHARS);
  if (!code && !message) return null;
  return { code, message, retryable: value.retryable === true };
}

function normalizeStringList(value, limit, chars) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).map((entry) => safeText(entry, chars)).filter(Boolean);
}

function normalizeRoutes(value) {
  return normalizeStringList(value, MAX_ROUTES, 96).map(safeRoute).filter(Boolean);
}

function normalizeRelativePath(value) {
  const raw = safeText(value, MAX_FIELD_CHARS);
  if (!raw || raw.includes('\0') || /^[A-Za-z]:[\\/]/.test(raw) || /^[/\\]{1,2}/.test(raw)) return '';
  const parts = raw.replace(/\\/g, '/').split('/');
  if (parts.some((part) => part === '..') || raw.includes(':')) return '';
  return parts.filter((part) => part && part !== '.').join('/');
}

function safeRoute(value) {
  if (typeof value !== 'string' || /[\\/]/.test(value)) return '';
  const text = safeText(value, 96);
  return text && !/[\\/]/.test(text) ? text : '';
}

// Bidi overrides, zero-width and C1 controls: never wire-meaningful, only spoof what a row says.
const FORMAT_CONTROL_RE = /[\u0080-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

// The app shows real paths (HB-012): the fields a person reads keep them and
// redact secrets only; identifiers, routes and step text keep the full redactor.
const KEEP_PATHS = { keepPaths: true };

function redactFor(options) {
  return options?.keepPaths === true ? redactSecretLikeText : redactSensitiveLikeText;
}

function safeText(value, maxChars, options = null) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- strip untrusted wire controls before persistence.
  return Array.from(redactFor(options)(value).replace(FORMAT_CONTROL_RE, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
    .slice(0, maxChars)
    .join('');
}

// Like safeText but keeps line breaks and tabs so a markdown answer stays readable.
function safeMultilineText(value, maxChars, options = null) {
  if (typeof value !== 'string') return '';
  const cleaned = redactFor(options)(value)
    .replace(FORMAT_CONTROL_RE, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- strip untrusted wire controls, keep \n and \t.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, maxChars).join('');
}

function safeEnum(value, allowed, fallback) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return allowed.has(normalized) ? normalized : fallback;
}

function optionalInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum ? Math.min(value, maximum) : null;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const normalized = optionalInteger(value, minimum, maximum);
  return normalized == null ? fallback : normalized;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  MAX_BATCH_TASKS,
  normalizeSubagentBatchReport,
  normalizeSubagentMetadata,
  normalizeSubagentReport,
  normalizeUsage,
};
