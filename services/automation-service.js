'use strict';

const { normalizeString } = require('../renderer/shared/string-utils');
const { redactLogValue } = require('./log-entry-normalizer');
const {
  readScheduledTasksFileAsync,
  resolveBackgroundRuntimeRoot,
  resolveScheduledTasksPath,
} = require('./scheduler-service');

const MAX_AUTOMATION_LIST_ITEMS = 100;
const MAX_AUTOMATION_RECENT_FAILURES = 10;
const MAX_AUTOMATION_STATUS_SUMMARY_LENGTH = 400;
const ACTIVE_AUTOMATION_RUN_STATUSES = new Set(['pending', 'started', 'running']);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function latestRun(runs) {
  return Array.isArray(runs) && runs.length ? runs[runs.length - 1] : null;
}

function summarizeRunForList(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    return null;
  }
  return {
    run_id: normalizeString(run.run_id),
    status: normalizeString(run.status),
    reason: normalizeString(run.reason),
    started_at: normalizeString(run.started_at),
    completed_at: normalizeString(run.completed_at),
    summary: normalizeString(run.summary),
  };
}

function sanitizeFailureSummary(value, redactionOptions) {
  const summary = normalizeString(value).slice(0, MAX_AUTOMATION_STATUS_SUMMARY_LENGTH);
  const redacted = normalizeString(redactLogValue(summary, redactionOptions));
  return redacted.replace(/\[redacted:path\](?:[\\/][^\s"'`<>|]+)*/g, '[redacted]');
}

function failureTimestamp(run) {
  return normalizeString(run?.completed_at) || normalizeString(run?.started_at);
}

function compareFailureSummaries(left, right) {
  const leftTs = failureTimestamp(left);
  const rightTs = failureTimestamp(right);
  if (leftTs && rightTs && leftTs !== rightTs) {
    return rightTs.localeCompare(leftTs);
  }
  if (leftTs && !rightTs) return -1;
  if (!leftTs && rightTs) return 1;
  return normalizeString(right?.run_id).localeCompare(normalizeString(left?.run_id));
}

function summarizeFailure(task, run, redactionOptions) {
  return {
    automation_id: normalizeString(task.id),
    task: normalizeString(task.task),
    run_id: normalizeString(run.run_id),
    status: normalizeString(run.status),
    reason: normalizeString(run.reason),
    started_at: normalizeString(run.started_at),
    completed_at: normalizeString(run.completed_at),
    summary: sanitizeFailureSummary(run.summary, redactionOptions),
  };
}

function insertRecentFailure(failures, failure) {
  failures.push(failure);
  failures.sort(compareFailureSummaries);
  if (failures.length > MAX_AUTOMATION_RECENT_FAILURES) {
    failures.pop();
  }
}

function projectAutomationSummary(task) {
  const runs = Array.isArray(task.automation_runs) ? task.automation_runs : [];
  return {
    id: normalizeString(task.id),
    task: normalizeString(task.task),
    enabled: task.enabled === true,
    trigger: cloneJson(task.trigger || {}),
    policy: cloneJson(task.policy || {}),
    isolation_mode: normalizeString(task.input?.isolation?.mode) || 'read_only',
    tool_grants: Array.isArray(task.input?.tool_grants) ? [...task.input.tool_grants] : [],
    retention: cloneJson(task.retention || {}),
    last_status: normalizeString(task.last_status),
    last_reason: normalizeString(task.last_reason),
    last_result_at: normalizeString(task.last_result_at),
    last_completed_at: normalizeString(task.last_completed_at),
    run_count: runs.length,
    latest_run: summarizeRunForList(latestRun(runs)),
  };
}

function projectAutomationDetail(task) {
  return {
    ...projectAutomationSummary(task),
    task_spec: normalizeString(task.input?.task_spec),
    task_spec_trust: 'user_authored_untrusted',
    automation_runs: cloneJson(Array.isArray(task.automation_runs) ? task.automation_runs : []),
  };
}

class AutomationService {
  constructor({
    userDataPath,
    configService,
    backgroundRuntimeRoot = '',
    logger = null,
    fsImpl = undefined,
    nowProvider = () => new Date(),
  } = {}) {
    if (!userDataPath) {
      throw new Error('userDataPath is required for AutomationService.');
    }
    this.userDataPath = userDataPath;
    this.configService = configService || null;
    this.backgroundRuntimeRoot = normalizeString(backgroundRuntimeRoot)
      || resolveBackgroundRuntimeRoot(userDataPath);
    this.logger = typeof logger === 'function' ? logger : () => {};
    this.fs = fsImpl;
    this.nowProvider = typeof nowProvider === 'function' ? nowProvider : () => new Date();
  }

  async listAutomations() {
    const tasks = await this._readAutomationTasks();
    const visibleTasks = tasks.slice(0, MAX_AUTOMATION_LIST_ITEMS);
    return {
      success: true,
      automations: visibleTasks.map(projectAutomationSummary),
      total_count: tasks.length,
      omitted_count: Math.max(tasks.length - visibleTasks.length, 0),
      max_items: MAX_AUTOMATION_LIST_ITEMS,
    };
  }

  async readAutomation(automationId) {
    const id = normalizeString(automationId);
    const task = (await this._readAutomationTasks()).find((entry) => entry.id === id);
    if (!task) {
      return {
        success: false,
        reason: 'not_found',
        message: `Automation "${id || 'unknown'}" was not found.`,
      };
    }
    return {
      success: true,
      automation: projectAutomationDetail(task),
    };
  }

  async getStatusSummary() {
    const tasks = await this._readAutomationTasks();
    const redactionOptions = { prefixes: this._redactionPrefixes() };
    const summary = {
      success: true,
      total: tasks.length,
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
      max_recent_failures: MAX_AUTOMATION_RECENT_FAILURES,
    };
    const recentFailures = [];

    for (const task of tasks) {
      if (task.enabled === true) {
        summary.enabled += 1;
      } else {
        summary.disabled += 1;
      }
      const runs = Array.isArray(task.automation_runs) ? task.automation_runs : [];
      for (const run of runs) {
        const status = normalizeString(run?.status).toLowerCase();
        if (ACTIVE_AUTOMATION_RUN_STATUSES.has(status)) {
          summary.running += 1;
        } else if (status === 'completed') {
          summary.completed_runs += 1;
        } else if (status === 'failed') {
          summary.failed_runs += 1;
          insertRecentFailure(recentFailures, summarizeFailure(task, run, redactionOptions));
        } else if (status === 'skipped') {
          summary.skipped_runs += 1;
        }
      }
    }

    summary.recent_failures = recentFailures;
    summary.recent_failure_count = summary.recent_failures.length;
    summary.omitted_failure_count = Math.max(summary.failed_runs - summary.recent_failures.length, 0);
    summary.last_failure = summary.recent_failures[0] || null;
    summary.last_failure_at = failureTimestamp(summary.last_failure);
    return summary;
  }

  async _readAutomationTasks() {
    const tasksPath = resolveScheduledTasksPath({
      workspaceRoot: this._resolveWorkspaceRoot(),
      userDataPath: this.userDataPath,
      backgroundRuntimeRoot: this.backgroundRuntimeRoot,
    });
    const payload = await readScheduledTasksFileAsync(tasksPath, {
      fsImpl: this.fs,
      logger: this.logger,
      nowProvider: this.nowProvider,
    });
    return Array.isArray(payload.tasks)
      ? payload.tasks.filter((entry) => entry?.kind === 'automation')
      : [];
  }

  _redactionPrefixes() {
    return [
      this._resolveWorkspaceRoot(),
      this.userDataPath,
      this.backgroundRuntimeRoot,
    ].map((value) => normalizeString(value)).filter(Boolean);
  }

  _resolveWorkspaceRoot() {
    if (this.configService && typeof this.configService.getToolsWorkspaceRoot === 'function') {
      return normalizeString(this.configService.getToolsWorkspaceRoot());
    }
    if (this.configService && typeof this.configService.getState === 'function') {
      const state = this.configService.getState() || {};
      return normalizeString(state.toolsWorkspaceRoot || state.tools_workspace_root);
    }
    return '';
  }
}

module.exports = {
  AutomationService,
};
