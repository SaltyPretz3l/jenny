// Pure module-level helper functions extracted from setup-service.js to keep
// that file under the repo's file-size ceiling. Behavior-preserving relocation
// only — see setup-service.js for the SetupService class that consumes these.

const { normalizeString } = require('./backend/path-utils');
const { DEFAULT_SETUP_STEPS, normalizeSetupSteps } = require('./shell-config-setup-state');

const TERMINAL_STEP_STATUSES = Object.freeze(['done', 'skipped']);

function toSnakeSetupSteps(steps = {}) {
  const normalized = normalizeSetupSteps(steps);
  return {
    workspace_root: normalized.workspaceRoot || DEFAULT_SETUP_STEPS.workspaceRoot,
    local_model: normalized.localModel || DEFAULT_SETUP_STEPS.localModel,
    endpoint: normalized.endpoint || DEFAULT_SETUP_STEPS.endpoint,
    personality: normalized.personality || DEFAULT_SETUP_STEPS.personality,
    skills: normalized.skills || DEFAULT_SETUP_STEPS.skills,
    capabilities: normalized.capabilities || DEFAULT_SETUP_STEPS.capabilities,
  };
}

function toSnakeSetupState(setup = {}) {
  const steps = toSnakeSetupSteps(setup.steps || {});
  return {
    seen: setup.seen === true,
    dismissed: setup.dismissed === true,
    setup_complete: setup.setupComplete === true || setup.setup_complete === true,
    first_run_completed: setup.firstRunCompleted === true || setup.first_run_completed === true,
    completed_at: normalizeString(setup.completedAt || setup.completed_at),
    updated_at: normalizeString(setup.updatedAt || setup.updated_at),
    steps,
  };
}

function setupStepsComplete(steps = {}) {
  return Object.values(toSnakeSetupSteps(steps)).every((status) =>
    TERMINAL_STEP_STATUSES.includes(status)
  );
}

function normalizeBoolean(value) {
  return value === true;
}

function normalizeModelCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeWorkspaceRootStatus(value, hasWorkspaceRoot) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const state = normalizeString(source.state).toLowerCase();
  if (['ready', 'missing', 'invalid'].includes(state)) {
    return {
      state,
      message: normalizeString(source.message),
    };
  }
  return {
    state: hasWorkspaceRoot ? 'invalid' : 'missing',
    message: hasWorkspaceRoot
      ? 'The configured workspace root could not be verified.'
      : 'No workspace root is configured.',
  };
}

function toCamelSetupSteps(steps = {}) {
  const normalized = toSnakeSetupSteps(steps);
  return {
    workspaceRoot: normalized.workspace_root,
    localModel: normalized.local_model,
    endpoint: normalized.endpoint,
    personality: normalized.personality,
    skills: normalized.skills,
    capabilities: normalized.capabilities,
  };
}

function normalizeReadinessProbe(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const runtimeEngine = normalizeString(source.runtime_engine ?? source.engine_type ?? source.engine).toLowerCase();
  return {
    local_model_available: normalizeBoolean(source.local_model_available),
    local_model_count: normalizeModelCount(source.local_model_count ?? source.model_count),
    local_endpoint_available: normalizeBoolean(source.local_endpoint_available),
    // Cloud (ChatGPT / Codex CLI) route reachability. Anything not normalized
    // here is silently dropped before SetupService._buildReadiness sees it.
    remote_endpoint_available: normalizeBoolean(source.remote_endpoint_available),
    runtime_ready: normalizeBoolean(source.runtime_ready),
    runtime_model_loaded: normalizeBoolean(source.runtime_model_loaded ?? source.model_loaded),
    runtime_engine: runtimeEngine,
    catalog_available: normalizeBoolean(source.catalog_available ?? source.local_model_available),
    catalog_pending: normalizeBoolean(source.catalog_pending),
    catalog_source: normalizeString(source.catalog_source),
    catalog_cached: normalizeBoolean(source.catalog_cached),
    catalog_stale: normalizeBoolean(source.catalog_stale),
    reason: normalizeString(source.reason),
  };
}

function withTimeout(promise, timeoutMs) {
  let handle = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      handle = setTimeout(() => reject(new Error(`Setup readiness probe timed out after ${timeoutMs}ms.`)), timeoutMs);
    }),
  ]).finally(() => {
    if (handle) {
      clearTimeout(handle);
    }
  });
}

function stepsEqual(left, right) {
  const a = toSnakeSetupSteps(left);
  const b = toSnakeSetupSteps(right);
  return a.workspace_root === b.workspace_root
    && a.local_model === b.local_model
    && a.endpoint === b.endpoint
    && a.personality === b.personality
    && a.skills === b.skills
    && a.capabilities === b.capabilities;
}

function createRequestId() {
  return `setup_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeRequestId(value) {
  const token = normalizeString(value);
  if (!token || /[\r\n\0]/.test(token)) {
    return '';
  }
  return token.slice(0, 120);
}

function publicPullState(entry) {
  return {
    requestId: entry.requestId,
    model: entry.model,
    status: entry.status,
    summary: entry.summary,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    exitCode: entry.exitCode,
    error: entry.error,
    percent: Number.isFinite(entry.percent) ? entry.percent : 0,
    bytes: Number.isFinite(entry.bytes) ? entry.bytes : 0,
    totalBytes: Number.isFinite(entry.totalBytes) ? entry.totalBytes : 0,
    label: entry.label || '',
    code: entry.code || '',
    terminationConfirmed: entry.terminationConfirmed === true,
  };
}

function createUnavailableSetupState() {
  return { setup_complete: false, setup_state: null };
}

module.exports = {
  toSnakeSetupSteps,
  toSnakeSetupState,
  setupStepsComplete,
  normalizeBoolean,
  normalizeModelCount,
  normalizeWorkspaceRootStatus,
  toCamelSetupSteps,
  normalizeReadinessProbe,
  withTimeout,
  stepsEqual,
  createRequestId,
  normalizeRequestId,
  publicPullState,
  createUnavailableSetupState,
};
