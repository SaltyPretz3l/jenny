'use strict';

const { redactLogValue } = require('../log-entry-normalizer');
const { LOG_RETENTION } = require('../../renderer/shared/log-contract-utils');
const { buildResourceBudgetFacet } = require('./resource-budget-facade');
const { buildTurnDiagnosticIndex } = require('./turn-diagnostic-index');
const { buildToolPolicyStatusFacet } = require('../tools/tool-policy-status');
const { normalizeText: normalizeString } = require('../shared/normalize');

const JENNY_STATUS_SCHEMA_VERSION = 4;
const DEFAULT_RECENT_LOG_LIMIT = 10;
const MAX_RECENT_LOG_LIMIT = LOG_RETENTION.observabilityRecentLogLimit;
const DEFAULT_RECENT_USAGE_LIMIT = 10;
const MAX_RECENT_USAGE_LIMIT = 50;
const MAX_STATUS_ERROR_LENGTH = 240;
const MAX_AUTOMATION_STATUS_COUNT = 1_000_000;
const MAX_AUTOMATION_RECENT_FAILURES = 10;
const MAX_AUTOMATION_FAILURE_TEXT_LENGTH = 400;

function collectRedactionPrefixes(service) {
  const options = service?.options && typeof service.options === 'object'
    ? service.options
    : {};
  return [
    options.userDataPath,
    options.repoRoot,
    options.sandboxRoot,
  ].map((value) => normalizeString(value)).filter(Boolean);
}

function trimStatusText(value) {
  const text = normalizeString(value);
  if (text.length <= MAX_STATUS_ERROR_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_STATUS_ERROR_LENGTH - 1)}...`;
}

function cloneJsonSafe(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value ?? fallback));
  } catch (_error) {
    return fallback;
  }
}

function clonePlainObject(value, fallback = {}) {
  const cloned = cloneJsonSafe(value, fallback);
  return cloned && typeof cloned === 'object' && !Array.isArray(cloned)
    ? cloned
    : fallback;
}

function createStatusRedactor(service) {
  const redactionOptions = {
    prefixes: collectRedactionPrefixes(service),
  };

  function value(input, fallback = null) {
    return cloneJsonSafe(redactLogValue(input, redactionOptions), fallback);
  }

  function text(input) {
    return trimStatusText(value(input, ''));
  }

  function error(error) {
    const rawMessage = error && typeof error === 'object' ? error.message : error;
    return text(rawMessage) || 'Jenny status facet is unavailable.';
  }

  return { error, text, value };
}

function normalizeBoundedPositiveInt(value, fallback, max) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.min(numeric, max);
}

function normalizeRecentLogLimit(value) {
  return normalizeBoundedPositiveInt(value, DEFAULT_RECENT_LOG_LIMIT, MAX_RECENT_LOG_LIMIT);
}

function normalizeRecentUsageLimit(value) {
  return normalizeBoundedPositiveInt(value, DEFAULT_RECENT_USAGE_LIMIT, MAX_RECENT_USAGE_LIMIT);
}

function emptyUsageTotals() {
  return {
    turn_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    duration_ms: 0,
    provider_cost_usd: 0,
    cost_coverage: {
      local_zero_turns: 0,
      provider_reported_turns: 0,
      unavailable_turns: 0,
    },
    models: {},
  };
}

function emptyUsageFacet(sessionId = '') {
  return {
    available: false,
    persistence: { available: false, durable: false, read_only_reason: null },
    retention: { max_age_days: 30, max_turns: 500, retained_turns: 0, oldest_at: '' },
    session_id: sessionId,
    today: emptyUsageTotals(),
    session: emptyUsageTotals(),
    cumulative: emptyUsageTotals(),
    recent_turns: [],
    last_record_error: null,
  };
}

function buildUnavailableFacet(error, redactor) {
  return {
    available: false,
    error: redactor.error(error),
  };
}

function firstNormalizedString(...values) {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function diagnosticRefsByStream(traceTimingFacet) {
  const refs = {};
  const recent = Array.isArray(traceTimingFacet?.recent) ? traceTimingFacet.recent : [];
  for (const entry of recent) {
    const streamId = normalizeString(entry?.stream_id || entry?.streamId);
    if (!streamId || !entry?.diagnostic_ref) {
      continue;
    }
    refs[streamId] = cloneJsonSafe(entry.diagnostic_ref, null);
  }
  return refs;
}

function normalizeCorrelationSource(entry, details = {}, refsByStream = {}) {
  const source = {};
  const sessionId = firstNormalizedString(details.session_id, details.sessionId, entry.session_id, entry.sessionId);
  const streamId = firstNormalizedString(details.stream_id, details.streamId, entry.stream_id, entry.streamId);
  const requestId = firstNormalizedString(details.request_id, details.requestId, entry.request_id, entry.requestId);
  const traceId = firstNormalizedString(details.trace_id, details.traceId, entry.trace_id, entry.traceId);
  const errorCode = firstNormalizedString(
    details.error_code,
    details.errorCode,
    details.code,
    entry.error_code,
    entry.errorCode
  );
  const category = firstNormalizedString(details.category, entry.category);
  if (sessionId) source.session_id = sessionId;
  if (streamId) source.stream_id = streamId;
  if (requestId) source.request_id = requestId;
  if (traceId) source.trace_id = traceId;
  if (errorCode) source.error_code = errorCode;
  if (category) source.category = category;
  if (streamId && refsByStream[streamId]) {
    source.diagnostic_ref = cloneJsonSafe(refsByStream[streamId], null);
  }
  return source;
}

function normalizeLogEntry(entry = {}, redactor, refsByStream = {}) {
  const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  const details = redactor.value(source.details, {}) || {};
  return {
    entry_id: normalizeString(source.entry_id || source.entryId),
    run_id: normalizeString(source.run_id || source.runId),
    sequence: Number.isFinite(Number(source.sequence)) ? Number(source.sequence) : null,
    ts: normalizeString(source.ts),
    level: normalizeString(source.level || 'INFO').toUpperCase() || 'INFO',
    layer: normalizeString(source.layer || source.source || 'electron') || 'electron',
    component: normalizeString(source.component),
    event: normalizeString(source.event || 'shell.event') || 'shell.event',
    message: redactor.text(source.message || details.message || source.event),
    source: normalizeCorrelationSource(source, details, refsByStream),
    details,
  };
}

function incrementCounter(target, key) {
  const normalized = normalizeString(key);
  if (!normalized) {
    return;
  }
  const current = Object.prototype.hasOwnProperty.call(target, normalized)
    ? target[normalized]
    : 0;
  target[normalized] = current + 1;
}

function emptyErrorDistribution() {
  return {
    by_event: Object.create(null),
    by_error_code: Object.create(null),
    by_category: Object.create(null),
  };
}

function appendBoundedTail(items, entry, limit) {
  items.push(entry);
  if (items.length > limit) {
    items.shift();
  }
}

function buildLogsFacet(logStore, options = {}, redactor, traceTimingFacet = null) {
  if (!logStore || typeof logStore.list !== 'function') {
    return {
      available: false,
      error: 'Shell log store is unavailable.',
      total: 0,
      counts_by_level: {},
      error_distribution: emptyErrorDistribution(),
      recent: [],
      recent_issues: [],
      active_run: null,
      sources: {},
      integrity: { complete: false, partial_reasons: ['log_store_unavailable'] },
    };
  }
  const refsByStream = diagnosticRefsByStream(traceTimingFacet);
  const counts = {};
  const recent = [];
  const recentIssues = [];
  const errorDistribution = emptyErrorDistribution();
  const limit = normalizeRecentLogLimit(options.recentLogLimit ?? options.recent_log_limit);
  let total = 0;
  for (const rawEntry of logStore.list()) {
    const entry = normalizeLogEntry(rawEntry, redactor, refsByStream);
    total += 1;
    counts[entry.level] = (counts[entry.level] || 0) + 1;
    appendBoundedTail(recent, entry, limit);
    if (entry.level !== 'WARN' && entry.level !== 'ERROR') {
      continue;
    }
    incrementCounter(errorDistribution.by_event, entry.event);
    incrementCounter(errorDistribution.by_error_code, entry.source?.error_code);
    incrementCounter(errorDistribution.by_category, entry.source?.category);
    appendBoundedTail(recentIssues, entry, limit);
  }
  const metadata = logStore.getCurrentDiagnosticsMetadata();
  return {
    available: true,
    total,
    counts_by_level: counts,
    error_distribution: errorDistribution,
    recent,
    recent_issues: recentIssues,
    active_run: typeof logStore.getActiveRunMetadata === 'function'
      ? cloneJsonSafe(logStore.getActiveRunMetadata(), null)
      : null,
    sources: clonePlainObject(metadata.sources, {}),
    integrity: clonePlainObject(metadata.integrity, {
      complete: false,
      partial_reasons: ['metadata_unavailable'],
    }),
  };
}

function buildBackendFacet(service, backendStatus, redactor) {
  const source = backendStatus && typeof backendStatus === 'object' ? backendStatus : {};
  return {
    available: true,
    phase: normalizeString(source.phase || 'unknown') || 'unknown',
    detail: normalizeString(source.detail),
    error: redactor.text(source.error),
    app_version: normalizeString(source.appVersion || service?.appVersion),
    launch_source: normalizeString(source.launchSource),
    credential_store: cloneJsonSafe(source.credentialStore, null),
  };
}

function normalizeBoolean(value) {
  return value === true;
}

function resolveLifecycleState({
  stopping = false,
  reconnectPending = false,
  phase = '',
  transportConnected = false,
} = {}) {
  if (stopping) {
    return 'stopping';
  }
  if (reconnectPending) {
    return 'retrying';
  }
  if (phase) {
    return phase;
  }
  return transportConnected ? 'ready' : 'unknown';
}

function buildRuntimeLifecycleFacet(service, backendStatus = {}, runtimeStatus = {}, redactor = null) {
  const sidecarStatus = backendStatus && typeof backendStatus === 'object' ? backendStatus : {};
  const phase = normalizeString(sidecarStatus.phase);
  const transportConnected = service?.sidecarClient?.connected === true
    || sidecarStatus.transport_connected === true
    || sidecarStatus.transportConnected === true;
  const stopping = service?._stopping === true || phase === 'stopping';
  const reconnectPending = service?._autoReconnectPending === true;
  const state = resolveLifecycleState({
    stopping,
    reconnectPending,
    phase,
    transportConnected,
  });
  const valueRedactor = redactor && typeof redactor.value === 'function'
    ? redactor.value
    : (value, fallback = null) => cloneJsonSafe(value, fallback);
  const textRedactor = redactor && typeof redactor.text === 'function'
    ? redactor.text
    : (value) => trimStatusText(value);
  const pid = Number(sidecarStatus.pid || 0);
  const startupMs = Number(sidecarStatus.startupMs ?? sidecarStatus.startup_ms);
  const progressLogCount = Number(sidecarStatus.progressLogCount ?? sidecarStatus.progress_log_count);
  const modelLifecycle = sidecarStatus.model_lifecycle && typeof sidecarStatus.model_lifecycle === 'object'
    ? sidecarStatus.model_lifecycle
    : service?._modelLifecycle || {};
  const modelAcquisition = sidecarStatus.model_acquisition
    && typeof sidecarStatus.model_acquisition === 'object'
    ? sidecarStatus.model_acquisition
    : {};
  return {
    available: true,
    state,
    phase: phase || 'unknown',
    detail: textRedactor(sidecarStatus.detail),
    managed_initialized: normalizeBoolean(service?._managedReadyOnce),
    auto_reconnect_pending: reconnectPending,
    stopping,
    transport_connected: transportConnected,
    process_attached: Number.isFinite(pid) && pid > 0,
    pid: Number.isFinite(pid) && pid > 0 ? pid : null,
    startup_stage: normalizeString(sidecarStatus.startupStage || sidecarStatus.startup_stage),
    startup_ms: Number.isFinite(startupMs) && startupMs >= 0 ? startupMs : null,
    launch_source: normalizeString(sidecarStatus.launchSource || sidecarStatus.launch_source),
    packaged_launch_detail: valueRedactor(
      sidecarStatus.packagedLaunchDetail || sidecarStatus.packaged_launch_detail || null,
      null
    ),
    progress_log_count: Number.isFinite(progressLogCount) && progressLogCount >= 0
      ? progressLogCount
      : null,
    sidecar_state: normalizeString(sidecarStatus.sidecar_state || phase || 'unknown'),
    model_state: normalizeString(sidecarStatus.model_state || modelLifecycle.state || 'unloaded'),
    model_acquisition: valueRedactor(modelAcquisition, {}),
    engine: normalizeString(runtimeStatus.engine),
    model: normalizeString(runtimeStatus.model),
  };
}

function buildRuntimeFacet(service, backendStatus = {}, redactor = null) {
  const currentStatus = service?.currentStatus && typeof service.currentStatus === 'object'
    ? service.currentStatus
    : null;
  const source = currentStatus || (
    typeof service?._buildManagedStatusSnapshot === 'function'
      ? service._buildManagedStatusSnapshot()
      : {}
  );
  return {
    available: true,
    engine: normalizeString(source.engine),
    model: normalizeString(source.model),
    model_loaded: source.model_loaded === true,
    reasoning_effort_support: normalizeString(source.reasoning_effort_support || 'unknown') || 'unknown',
    local_runtime: cloneJsonSafe(source.local_runtime, null),
    llama_server: buildLlamaServerFacet(service, redactor),
    tools_status: cloneJsonSafe(source.tools_status, {}),
    lifecycle: buildRuntimeLifecycleFacet(service, backendStatus, source, redactor),
  };
}

function buildLlamaServerFacet(service, redactor) {
  const manager = service?.options?.getLlamaServerManager?.();
  if (!manager || typeof manager.getStatus !== 'function') return null;
  try {
    const status = manager.getStatus() || {};
    const state = normalizeString(status.state).toLowerCase();
    const integer = (value) => (Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
    // model_path / last_error can carry the user's home directory.
    const text = (value) => (redactor?.text ? redactor.text(value) : normalizeString(value));
    // Wire-shaped like local_runtime; an allowlist so the api key (or any
    // future field on the manager status) can never leak through diagnostics.
    return {
      state: ['stopped', 'starting', 'ready', 'stopping', 'crashed'].includes(state) ? state : 'unknown',
      pid: integer(status.pid),
      port: integer(status.port),
      alias: normalizeString(status.alias),
      model_path: text(status.modelPath),
      profile_id: normalizeString(status.profileId),
      acceleration_mode: normalizeString(status.accelerationMode),
      acceleration_reason: normalizeString(status.accelerationReason),
      reused: normalizeBoolean(status.reused),
      last_error: text(status.lastError),
      changed_at: integer(status.changedAt),
    };
  } catch (_error) {
    return null;
  }
}

function buildBackendUnavailableFacet(service, error, redactor) {
  return {
    ...buildUnavailableFacet(error, redactor),
    phase: 'unknown',
    detail: '',
    app_version: normalizeString(service?.appVersion),
    launch_source: '',
    credential_store: null,
  };
}

function buildRuntimeUnavailableFacet(error, redactor) {
  return {
    ...buildUnavailableFacet(error, redactor),
    engine: '',
    model: '',
    model_loaded: false,
    reasoning_effort_support: 'unknown',
    local_runtime: null,
    llama_server: null,
    tools_status: {},
    lifecycle: {
      available: false,
      state: 'unknown',
      phase: 'unknown',
      detail: '',
      managed_initialized: false,
      auto_reconnect_pending: false,
      stopping: false,
      transport_connected: false,
      process_attached: false,
      pid: null,
      startup_stage: '',
      startup_ms: null,
      launch_source: '',
      packaged_launch_detail: null,
      progress_log_count: null,
      sidecar_state: 'unknown',
      model_state: 'unloaded',
      model_acquisition: {},
      engine: '',
      model: '',
    },
  };
}

async function buildHarnessFacet(service, options = {}) {
  if (options.includeHarness === false || options.include_harness === false) {
    return {
      available: false,
      skipped: true,
      reason: 'disabled_by_request',
      snapshot: null,
    };
  }
  if (!service || typeof service.inspectHarness !== 'function') {
    return {
      available: false,
      error: 'Harness inspection is unavailable.',
      snapshot: null,
    };
  }
  const snapshot = await service.inspectHarness({
    include_recent_history: false,
    recent_history_limit: 0,
    include_disabled: true,
  });
  return {
    available: true,
    snapshot: cloneJsonSafe(snapshot, {}),
  };
}

async function buildTraceTimingFacet(service, options = {}) {
  const userDataPath = normalizeString(service?.options?.userDataPath);
  const snapshot = await buildTurnDiagnosticIndex({
    userDataPath,
    sessionId: options.sessionId || options.session_id,
    limit: options.recentTraceLimit || options.recent_trace_limit,
  });
  if (
    !snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || !Array.isArray(snapshot.recent)
  ) {
    throw new Error('Turn diagnostic index snapshot is malformed.');
  }
  return cloneJsonSafe(snapshot, {
    available: false,
    count: 0,
    skipped_count: 0,
    diagnostics_root_available: false,
    retention: {},
    recent: [],
  });
}

function buildUsageFacet(service, options = {}) {
  const sessionId = normalizeString(options.sessionId || options.session_id);
  const recentLimit = normalizeRecentUsageLimit(
    options.recentUsageLimit || options.recent_usage_limit
  );
  const usageHistory = service?.usageHistory;
  if (!usageHistory || typeof usageHistory.getSnapshot !== 'function') {
    return {
      ...emptyUsageFacet(sessionId),
      error: 'Usage history is unavailable.',
    };
  }
  return cloneJsonSafe(
    usageHistory.getSnapshot({ sessionId, limit: recentLimit }),
    emptyUsageFacet(sessionId)
  );
}

async function buildPhasePercentilesFacet(service) {
  if (!service || typeof service.getPhasePercentilesSnapshot !== 'function') {
    return {
      available: false,
      error: 'Phase percentile diagnostics are unavailable.',
      phases: {},
      targets: {},
    };
  }
  const snapshot = await service.getPhasePercentilesSnapshot();
  return {
    available: true,
    ...cloneJsonSafe(snapshot, { phases: {}, targets: {} }),
  };
}

function buildToolObservabilityFacet(service) {
  if (!service || typeof service.getToolObservabilitySnapshot !== 'function') {
    return {
      available: false,
      error: 'Tool observability diagnostics are unavailable.',
      retention: {},
      open_call_count: 0,
      tools: {},
    };
  }
  const snapshot = clonePlainObject(service.getToolObservabilitySnapshot(), null);
  if (!snapshot) {
    throw new Error('Tool observability snapshot is malformed.');
  }
  return { available: true, ...snapshot };
}

function buildResourcesFacet(service, harnessFacet, redactor) {
  const errors = [];
  let system = null;
  if (typeof service?.systemStatsProvider === 'function') {
    try {
      system = redactor.value(service.systemStatsProvider(), null);
    } catch (error) {
      errors.push(redactor.error(error));
    }
  } else {
    errors.push('System stats provider is unavailable.');
  }
  const systemPressure = harnessFacet?.available === true
    ? cloneJsonSafe(harnessFacet.snapshot?.runtime?.system_pressure, null)
    : null;
  const systemAvailable = system && typeof system === 'object' && !Array.isArray(system);
  const sidecarAvailable = systemPressure && typeof systemPressure === 'object' && !Array.isArray(systemPressure);
  return {
    available: Boolean(systemAvailable || sidecarAvailable),
    system_available: Boolean(systemAvailable),
    system: systemAvailable ? system : null,
    sidecar: {
      available: Boolean(sidecarAvailable),
      system_pressure: sidecarAvailable ? systemPressure : null,
    },
    ...(errors.length ? { error: errors.join(' | ') } : {}),
  };
}

function emptyAutomationsFacetFields() {
  return {
    kind: 'automation',
    total: 0,
    enabled: 0,
    disabled: 0,
    running: 0,
    completed_runs: 0,
    failed_runs: 0,
    skipped_runs: 0,
    last_failure_at: '',
    last_failure: null,
    recent_failures: [],
    recent_failure_count: 0,
    omitted_failure_count: 0,
    max_recent_failures: 0,
  };
}

function normalizeAutomationStatusCount(value, fallback = 0, max = MAX_AUTOMATION_STATUS_COUNT) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.min(Math.trunc(numeric), max);
}

function sanitizeAutomationFacetText(value, redactor, maxLength = MAX_AUTOMATION_FAILURE_TEXT_LENGTH) {
  return normalizeString(redactor.value(value, ''))
    .replace(/\[redacted:path\](?:[\\/][^\s"'`<>|]+)*/g, '[redacted]')
    .slice(0, maxLength);
}

function normalizeAutomationFailureFacet(entry, redactor) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const runId = sanitizeAutomationFacetText(entry.run_id, redactor, 128);
  if (!runId) {
    return null;
  }
  return {
    automation_id: sanitizeAutomationFacetText(entry.automation_id, redactor, 128),
    task: sanitizeAutomationFacetText(entry.task, redactor, 128),
    run_id: runId,
    status: sanitizeAutomationFacetText(entry.status, redactor, 128),
    reason: sanitizeAutomationFacetText(entry.reason, redactor, 128),
    started_at: sanitizeAutomationFacetText(entry.started_at, redactor, 128),
    completed_at: sanitizeAutomationFacetText(entry.completed_at, redactor, 128),
    summary: sanitizeAutomationFacetText(entry.summary, redactor),
  };
}

function normalizeAutomationFailureFacets(value, redactor) {
  const source = Array.isArray(value) ? value : [];
  const out = [];
  for (const entry of source) {
    const normalized = normalizeAutomationFailureFacet(entry, redactor);
    if (!normalized) {
      continue;
    }
    out.push(normalized);
    if (out.length >= MAX_AUTOMATION_RECENT_FAILURES) {
      break;
    }
  }
  return out;
}

async function buildAutomationsFacet(service, redactor) {
  const automationService = service?.automationService;
  if (!automationService || typeof automationService.getStatusSummary !== 'function') {
    return {
      available: false,
      error: 'Automation service is unavailable.',
      ...emptyAutomationsFacetFields(),
    };
  }
  const summary = clonePlainObject(await automationService.getStatusSummary(), null);
  if (!summary || summary.success !== true) {
    throw new Error('Automation status summary is malformed.');
  }
  const recentFailures = normalizeAutomationFailureFacets(summary.recent_failures, redactor);
  const lastFailure = normalizeAutomationFailureFacet(summary.last_failure, redactor)
    || recentFailures[0]
    || null;
  const sourceRecentFailureCount = Array.isArray(summary.recent_failures)
    ? summary.recent_failures.length
    : 0;
  const omittedFailureCount = normalizeAutomationStatusCount(
    normalizeAutomationStatusCount(summary.omitted_failure_count)
      + Math.max(sourceRecentFailureCount - recentFailures.length, 0)
  );
  return {
    available: true,
    kind: 'automation',
    total: normalizeAutomationStatusCount(summary.total),
    enabled: normalizeAutomationStatusCount(summary.enabled),
    disabled: normalizeAutomationStatusCount(summary.disabled),
    running: normalizeAutomationStatusCount(summary.running),
    completed_runs: normalizeAutomationStatusCount(summary.completed_runs),
    failed_runs: normalizeAutomationStatusCount(summary.failed_runs),
    skipped_runs: normalizeAutomationStatusCount(summary.skipped_runs),
    last_failure_at: sanitizeAutomationFacetText(summary.last_failure_at, redactor, 128),
    last_failure: lastFailure,
    recent_failures: recentFailures,
    recent_failure_count: recentFailures.length,
    omitted_failure_count: omittedFailureCount,
    max_recent_failures: normalizeAutomationStatusCount(
      summary.max_recent_failures,
      MAX_AUTOMATION_RECENT_FAILURES,
      MAX_AUTOMATION_RECENT_FAILURES
    ),
  };
}

function normalizeObservedMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function buildSlowOperationsFacet(phasePercentilesFacet, toolObservabilityFacet) {
  const items = [];
  const phases = phasePercentilesFacet?.available === true
    && phasePercentilesFacet.phases
    && typeof phasePercentilesFacet.phases === 'object'
    ? phasePercentilesFacet.phases
    : {};
  const targets = phasePercentilesFacet?.targets
    && typeof phasePercentilesFacet.targets === 'object'
    ? phasePercentilesFacet.targets
    : {};
  for (const [phaseName, phase] of Object.entries(phases)) {
    const target = targets[phaseName] && typeof targets[phaseName] === 'object'
      ? targets[phaseName]
      : {};
    const threshold = normalizeObservedMs(target.p95);
    const observed = normalizeObservedMs(phase?.p95 ?? phase?.max);
    if (threshold == null || observed == null || observed <= threshold) {
      continue;
    }
    items.push({
      kind: 'phase',
      id: phaseName,
      metric: 'p95',
      observed_ms: observed,
      threshold_ms: threshold,
      count: Number(phase.count || 0),
    });
  }

  const toolThreshold = normalizeObservedMs(toolObservabilityFacet?.retention?.slow_threshold_ms);
  const tools = toolObservabilityFacet?.available === true
    && toolObservabilityFacet.tools
    && typeof toolObservabilityFacet.tools === 'object'
    ? toolObservabilityFacet.tools
    : {};
  for (const [toolName, stats] of Object.entries(tools)) {
    const latency = stats?.latency_ms && typeof stats.latency_ms === 'object'
      ? stats.latency_ms
      : {};
    const observed = normalizeObservedMs(latency.p95 ?? latency.max);
    if (toolThreshold == null || observed == null || observed < toolThreshold) {
      continue;
    }
    items.push({
      kind: 'tool',
      id: toolName,
      metric: 'p95',
      observed_ms: observed,
      threshold_ms: toolThreshold,
      count: Number(stats.count || 0),
      error_count: Number(stats.error_count || 0),
    });
  }

  items.sort((left, right) => (
    (right.observed_ms - right.threshold_ms) - (left.observed_ms - left.threshold_ms)
  ));
  return {
    available: true,
    count: items.length,
    items,
  };
}

function buildSchemasFacet(backendStatus) {
  const items = Array.isArray(backendStatus?.schemaVersions)
    ? backendStatus.schemaVersions.map((entry) => cloneJsonSafe(entry, null)).filter(Boolean)
    : [];
  return {
    available: true,
    count: items.length,
    items,
  };
}

async function getJennyStatus(service, options = {}) {
  const redactor = createStatusRedactor(service);
  const generatedAt = new Date().toISOString();
  let backendStatus = {};
  let backendFacet;
  let schemasFacet;
  try {
    backendStatus = service.getBackendStatus();
    backendFacet = buildBackendFacet(service, backendStatus, redactor);
    schemasFacet = buildSchemasFacet(backendStatus);
  } catch (error) {
    backendFacet = buildBackendUnavailableFacet(service, error, redactor);
    schemasFacet = { available: false, count: 0, items: [], error: redactor.error(error) };
  }
  let runtimeFacet;
  try {
    runtimeFacet = buildRuntimeFacet(service, backendStatus, redactor);
  } catch (error) {
    runtimeFacet = buildRuntimeUnavailableFacet(error, redactor);
  }
  const payload = {
    facade: 'jenny_status',
    schema_version: JENNY_STATUS_SCHEMA_VERSION,
    generated_at: generatedAt,
    backend: backendFacet,
    runtime: runtimeFacet,
    harness: null,
    resources: null,
    automations: null,
    tool_policy: null,
    trace_timing: null,
    logs: null,
    phase_percentiles: null,
    tool_observability: null,
    slow_operations: null,
    usage: null,
    schemas: schemasFacet,
    budgets: null,
  };
  try {
    payload.harness = await buildHarnessFacet(service, options);
  } catch (error) {
    payload.harness = { ...buildUnavailableFacet(error, redactor), snapshot: null };
  }
  try {
    payload.resources = buildResourcesFacet(service, payload.harness, redactor);
  } catch (error) {
    payload.resources = {
      ...buildUnavailableFacet(error, redactor),
      system_available: false,
      system: null,
      sidecar: {
        available: false,
        system_pressure: null,
      },
    };
  }
  try {
    payload.automations = await buildAutomationsFacet(service, redactor);
  } catch (error) {
    payload.automations = {
      ...buildUnavailableFacet(error, redactor),
      ...emptyAutomationsFacetFields(),
    };
  }
  payload.tool_policy = buildToolPolicyStatusFacet(
    service?.toolPermissionStore || service?.toolExecutor?._permissionStore || null,
    redactor
  );
  try {
    payload.trace_timing = await buildTraceTimingFacet(service, options);
  } catch (error) {
    payload.trace_timing = {
      ...buildUnavailableFacet(error, redactor),
      count: 0,
      skipped_count: 0,
      diagnostics_root_available: false,
      retention: {},
      recent: [],
    };
  }
  try {
    payload.logs = buildLogsFacet(service.shellLogStore, options, redactor, payload.trace_timing);
  } catch (error) {
    payload.logs = {
      ...buildUnavailableFacet(error, redactor),
      total: 0,
      counts_by_level: {},
      error_distribution: emptyErrorDistribution(),
      recent: [],
      recent_issues: [],
      active_run: null,
      sources: {},
      integrity: { complete: false, partial_reasons: ['log_facet_failed'] },
    };
  }
  try {
    payload.phase_percentiles = await buildPhasePercentilesFacet(service);
  } catch (error) {
    payload.phase_percentiles = { ...buildUnavailableFacet(error, redactor), phases: {}, targets: {} };
  }
  try {
    payload.tool_observability = buildToolObservabilityFacet(service);
  } catch (error) {
    payload.tool_observability = {
      ...buildUnavailableFacet(error, redactor),
      retention: {},
      open_call_count: 0,
      tools: {},
    };
  }
  try {
    payload.slow_operations = buildSlowOperationsFacet(
      payload.phase_percentiles,
      payload.tool_observability
    );
  } catch (error) {
    payload.slow_operations = { ...buildUnavailableFacet(error, redactor), count: 0, items: [] };
  }
  try {
    payload.usage = buildUsageFacet(service, options);
  } catch (error) {
    payload.usage = {
      ...emptyUsageFacet(normalizeString(options.sessionId || options.session_id)),
      ...buildUnavailableFacet(error, redactor),
    };
  }
  payload.budgets = buildResourceBudgetFacet(payload);
  return payload;
}

module.exports = {
  JENNY_STATUS_SCHEMA_VERSION,
  getJennyStatus,
};
