const { EventEmitter } = require('events');

class FakeConfigService extends EventEmitter {
  constructor(workspaceRoot = '') {
    super();
    this._state = {
      toolsWorkspaceRoot: workspaceRoot,
    };
  }

  getState() {
    return { ...this._state };
  }

  setWorkspaceRoot(workspaceRoot) {
    this._state.toolsWorkspaceRoot = workspaceRoot;
    this.emit('changed', this.getState(), {
      reason: workspaceRoot ? 'workspace_root_updated' : 'workspace_root_cleared',
    });
  }
}

function createSessionSummaries(now) {
  return Array.from({ length: 5 }, (_entry, index) => ({
    id: `sess_${index + 1}`,
    title: `Session ${index + 1}`,
    updated_at: new Date(now.getTime() - ((25 * 60) + index) * 60 * 1000).toISOString(),
    created_at: new Date(now.getTime() - ((26 * 60) + index) * 60 * 1000).toISOString(),
  }));
}

function createAutomationTask(overrides = {}) {
  return {
    id: 'automation:project_health',
    task: 'project_health',
    kind: 'automation',
    enabled: true,
    trigger: { type: 'interval', interval_seconds: 86_400 },
    policy: {
      requires_feature_flags: ['tools_automations_enabled'],
      defer_when_chat_active: true,
    },
    input: {
      task_spec: 'Run the read-only project health check.',
      tool_grants: ['filesystem', 'git'],
      isolation: { mode: 'read_only' },
    },
    retention: { max_runs: 2, max_log_bytes: 8_000 },
    automation_runs: [],
    ...overrides,
  };
}

function createBackendStub({
  phase = 'ready',
  featureFlags = {},
  sessionSummaries = [],
  onRun = async () => ({ status: 'started', task: 'automation_run' }),
  onBackgroundRun = null,
  activeStreams = new Map(),
  modelLoaded = true,
  model = 'jenny-default',
} = {}) {
  return {
    featureFlags: { ...featureFlags },
    activeStreams,
    getBackendStatus() {
      return { phase, model_loaded: modelLoaded, model: modelLoaded ? model : '' };
    },
    getSessionSummariesForScheduler() {
      return sessionSummaries;
    },
    async runBackgroundTask(task, params) {
      if (typeof onBackgroundRun === 'function') {
        return onBackgroundRun(task, params);
      }
      return onRun(task, params);
    },
  };
}

module.exports = {
  FakeConfigService,
  createSessionSummaries,
  createAutomationTask,
  createBackendStub,
};
