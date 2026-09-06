const { clipText, normalizeString } = require('./backend/path-utils');

const SETUP_STEP_STATUSES = Object.freeze(['pending', 'done', 'skipped', 'error']);
const DEFAULT_SETUP_STEPS = Object.freeze({
  workspaceRoot: 'pending',
  localModel: 'pending',
  endpoint: 'pending',
  personality: 'pending',
  skills: 'pending',
  capabilities: 'pending',
});
const DEFAULT_SETUP = Object.freeze({
  seen: false,
  dismissed: false,
  setupComplete: false,
  firstRunCompleted: false,
  completedAt: '',
  updatedAt: '',
  steps: DEFAULT_SETUP_STEPS,
});
// Personality v3 (schema 47): the assistant identity is the NAME only. The
// retired `profile` / `customText` pair moved into the user-owned
// PERSONALITY.md note; the v3 personality-workspace migration reads the old
// values once before this schema bump drops them.
const DEFAULT_ASSISTANT_IDENTITY = Object.freeze({
  agentName: 'Jenny',
  updatedAt: '',
});
const ASSISTANT_AGENT_NAME_MAX_CHARS = 80;

function normalizeIsoString(value) {
  const token = normalizeString(value);
  if (!token) {
    return '';
  }
  const date = new Date(token);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function normalizeSetupStepStatus(value) {
  const token = normalizeString(value).toLowerCase();
  return SETUP_STEP_STATUSES.includes(token) ? token : 'pending';
}

function normalizeSetupSteps(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    workspaceRoot: normalizeSetupStepStatus(
      source.workspaceRoot ?? source.workspace_root ?? DEFAULT_SETUP_STEPS.workspaceRoot
    ),
    localModel: normalizeSetupStepStatus(
      source.localModel ?? source.local_model ?? DEFAULT_SETUP_STEPS.localModel
    ),
    endpoint: normalizeSetupStepStatus(source.endpoint ?? DEFAULT_SETUP_STEPS.endpoint),
    personality: normalizeSetupStepStatus(
      source.personality ?? DEFAULT_SETUP_STEPS.personality
    ),
    skills: normalizeSetupStepStatus(source.skills ?? DEFAULT_SETUP_STEPS.skills),
    capabilities: normalizeSetupStepStatus(
      source.capabilities ?? DEFAULT_SETUP_STEPS.capabilities
    ),
  };
}

function normalizeSetupState(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    seen: source.seen === true,
    dismissed: source.dismissed === true,
    setupComplete: source.setupComplete === true || source.setup_complete === true,
    firstRunCompleted: source.firstRunCompleted === true || source.first_run_completed === true,
    completedAt: normalizeIsoString(source.completedAt ?? source.completed_at),
    updatedAt: normalizeIsoString(source.updatedAt ?? source.updated_at),
    steps: normalizeSetupSteps(source.steps),
  };
}

// UIUX-005: "required" for setup HEALTH (as opposed to the wizard's optional
// steps) is workspaceRoot plus model access via EITHER localModel or endpoint
// (the linear flow only ever drives localModel; endpoint is a Settings-only
// alternate path to the same "can Jenny reach a model" requirement). A
// required step that is merely 'skipped' still leaves health short of
// 'complete' -- that distinction is the whole point of this helper: it is
// what stops a skip-through wizard run from lying about being finished.
function requiredModelStepStatus(steps) {
  const localModel = normalizeSetupStepStatus(steps.localModel);
  const endpoint = normalizeSetupStepStatus(steps.endpoint);
  if (localModel === 'done' || endpoint === 'done') {
    return 'done';
  }
  const localTerminal = localModel === 'done' || localModel === 'skipped';
  const endpointTerminal = endpoint === 'done' || endpoint === 'skipped';
  if (localTerminal && endpointTerminal) {
    return 'skipped';
  }
  return 'pending';
}

function computeSetupHealth(setup) {
  const source = setup && typeof setup === 'object' && !Array.isArray(setup) ? setup : {};
  const steps = normalizeSetupSteps(source.steps);
  const required = {
    workspaceRoot: normalizeSetupStepStatus(steps.workspaceRoot),
    model: requiredModelStepStatus(steps),
  };
  const pendingSteps = [];
  const skippedSteps = [];
  Object.keys(required).forEach((key) => {
    const status = required[key];
    if (status === 'done') {
      return;
    }
    if (status === 'skipped') {
      skippedSteps.push(key);
      return;
    }
    pendingSteps.push(key);
  });
  let state = 'complete';
  if (pendingSteps.length > 0) {
    state = 'pending';
  } else if (skippedSteps.length > 0) {
    state = 'degraded';
  }
  return { state, pendingSteps, skippedSteps };
}

// Legacy `profile` / `customText` keys on an inbound patch are tolerated and
// dropped here rather than rejected: a v46 shell-config, an older renderer
// build, or a replayed setup payload must not fail the write.
function normalizeAssistantIdentity(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    agentName: clipText(
      normalizeString(source.agentName ?? source.agent_name),
      ASSISTANT_AGENT_NAME_MAX_CHARS
    ) || 'Jenny',
    updatedAt: normalizeIsoString(source.updatedAt ?? source.updated_at),
  };
}

module.exports = {
  ASSISTANT_AGENT_NAME_MAX_CHARS,
  DEFAULT_ASSISTANT_IDENTITY,
  DEFAULT_SETUP,
  DEFAULT_SETUP_STEPS,
  SETUP_STEP_STATUSES,
  computeSetupHealth,
  normalizeAssistantIdentity,
  normalizeSetupState,
  normalizeSetupStepStatus,
  normalizeSetupSteps,
};
