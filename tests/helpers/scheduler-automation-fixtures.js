'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const {
  SCHEDULED_TASKS_SCHEMA_VERSION,
} = require('../../services/scheduler-schema-version');

class FakeConfigService extends EventEmitter {
  constructor(workspaceRoot = '') {
    super();
    this._state = { toolsWorkspaceRoot: workspaceRoot };
  }

  getState() {
    return { ...this._state };
  }
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

function createBackendStub({ onBackgroundRun }) {
  return {
    featureFlags: {
      tools_automations_enabled: true,
    },
    activeStreams: new Map(),
    getBackendStatus() {
      return { phase: 'ready' };
    },
    getSessionSummariesForScheduler() {
      return [];
    },
    async runBackgroundTask(task, params) {
      return onBackgroundRun(task, params);
    },
  };
}

function writeTasks(tasksPath, tasks) {
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify({
    version: SCHEDULED_TASKS_SCHEMA_VERSION,
    tasks,
  }, null, 2));
}

module.exports = {
  FakeConfigService,
  createAutomationTask,
  createBackendStub,
  writeTasks,
};
