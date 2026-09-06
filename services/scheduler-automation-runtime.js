'use strict';

const crypto = require('crypto');
const path = require('path');

const { normalizeString } = require('../renderer/shared/string-utils');

const AUTOMATION_RUN_TASK_NAME = 'automation_run';
const DEFAULT_AUTOMATION_RUNTIME_BUDGET_MS = 5 * 60 * 1000;
const MAX_AUTOMATION_RESULT_RUNTIME_MS = 1_800_000;
const ACTIVE_AUTOMATION_STATUSES = new Set(['pending', 'started', 'running']);
const TERMINAL_AUTOMATION_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);

function safeAutomationPathToken(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 128) || 'automation';
}

function parseIsoMs(value) {
  const token = normalizeString(value);
  if (!token) return 0;
  const parsed = Date.parse(token);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildAutomationRunId({ taskId, startedAt }) {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      taskId: normalizeString(taskId),
      startedAt: normalizeString(startedAt),
    }))
    .digest('hex')
    .slice(0, 16);
  return `run_${hash}`;
}

function resolveAutomationResultRef({ automationId, runId }) {
  return `${safeAutomationPathToken(automationId)}/${safeAutomationPathToken(runId)}.result.json`;
}

function resolveAutomationRunResultPath({ backgroundRuntimeRoot, automationId, runId }) {
  return path.join(
    normalizeString(backgroundRuntimeRoot),
    'automations',
    safeAutomationPathToken(automationId),
    `${safeAutomationPathToken(runId)}.result.json`
  );
}

function normalizeRuntimeBudgetMs(task) {
  const parsed = Number(task?.policy?.runtime_budget_ms);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AUTOMATION_RUNTIME_BUDGET_MS;
  }
  return Math.min(Math.max(Math.trunc(parsed), 30_000), 1_800_000);
}

function normalizeAutomationResultBudget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const runtimeMs = Number(value.runtime_ms);
  const toolCalls = Number(value.tool_calls);
  if (!Number.isFinite(runtimeMs) && !Number.isFinite(toolCalls)) {
    return undefined;
  }
  return {
    runtime_ms: Number.isFinite(runtimeMs)
      ? Math.min(Math.max(Math.trunc(runtimeMs), 0), MAX_AUTOMATION_RESULT_RUNTIME_MS)
      : 0,
    tool_calls: Number.isFinite(toolCalls) ? Math.max(Math.trunc(toolCalls), 0) : 0,
  };
}

function normalizeAutomationResultPayload(raw, { fallbackRun = {}, fallbackTask = {} } = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (Number(source.version) !== 1) {
    return null;
  }
  const status = normalizeString(source.status).toLowerCase();
  if (!TERMINAL_AUTOMATION_STATUSES.has(status)) {
    return null;
  }
  const expectedRunId = normalizeString(fallbackRun.run_id);
  const runId = normalizeString(source.run_id);
  if (!runId || (expectedRunId && runId !== expectedRunId)) {
    return null;
  }
  const expectedAutomationId = normalizeString(fallbackTask.id);
  const automationId = normalizeString(source.automation_id);
  if (!automationId || (expectedAutomationId && automationId !== expectedAutomationId)) {
    return null;
  }
  return {
    status,
    task: normalizeString(fallbackTask.task),
    reason: normalizeString(source.reason),
    run_id: runId,
    started_at: normalizeString(fallbackRun.started_at) || normalizeString(source.started_at),
    completed_at: normalizeString(source.completed_at),
    summary: normalizeString(source.summary),
    budget: normalizeAutomationResultBudget(source.budget),
    artifacts: source.artifacts,
    result_ref: normalizeString(fallbackRun.result_ref) || normalizeString(source.result_ref),
  };
}

function readAutomationResultFile(scheduler, resultPath, { task, run }) {
  try {
    const raw = scheduler.fs.readFileSync(resultPath, 'utf8');
    const result = normalizeAutomationResultPayload(JSON.parse(raw), {
      fallbackRun: run,
      fallbackTask: task,
    });
    if (result) {
      return { result };
    }
    scheduler.logger('WARN', 'scheduler.automation_result_invalid', {
      taskId: normalizeString(task.id),
      runId: normalizeString(run.run_id),
    });
    return { invalidReason: 'invalid_result' };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      scheduler.logger('WARN', 'scheduler.automation_result_read_failed', {
        taskId: normalizeString(task.id),
        runId: normalizeString(run.run_id),
        message: String(error?.message || error),
      });
      return { invalidReason: 'invalid_result' };
    }
    return { missing: true };
  }
}

function hasActiveAutomationRun(task) {
  if (task?.kind !== 'automation') {
    return false;
  }
  return (Array.isArray(task.automation_runs) ? task.automation_runs : []).some((run) => (
    ACTIVE_AUTOMATION_STATUSES.has(normalizeString(run?.status).toLowerCase())
    && Boolean(normalizeString(run?.run_id))
  ));
}

async function reconcileAutomationRuns(scheduler, tasksPath, tasks) {
  let changed = false;
  const nowMs = scheduler.nowProvider().getTime();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task?.kind !== 'automation') continue;
    for (const run of Array.isArray(task.automation_runs) ? task.automation_runs : []) {
      const status = normalizeString(run?.status).toLowerCase();
      if (!ACTIVE_AUTOMATION_STATUSES.has(status)) continue;
      const runId = normalizeString(run.run_id);
      if (!runId) continue;
      const resultPath = resolveAutomationRunResultPath({
        backgroundRuntimeRoot: scheduler.backgroundRuntimeRoot,
        automationId: task.id,
        runId,
      });
      const outcome = readAutomationResultFile(scheduler, resultPath, { task, run });
      if (outcome?.result) {
        await scheduler._recordTaskResult(tasksPath, outcome.result, task.id);
        changed = true;
        continue;
      }
      if (outcome?.invalidReason) {
        await scheduler._recordTaskResult(tasksPath, {
          status: 'failed',
          task: task.task,
          reason: outcome.invalidReason,
          run_id: runId,
          started_at: normalizeString(run.started_at),
          completed_at: scheduler.nowProvider().toISOString(),
          budget: {
            runtime_ms: Number(run.budget?.runtime_ms) || normalizeRuntimeBudgetMs(task),
            tool_calls: Number(run.budget?.tool_calls) || 0,
          },
          result_ref: normalizeString(run.result_ref),
        }, task.id);
        changed = true;
        continue;
      }
      const startedMs = parseIsoMs(run.started_at) || parseIsoMs(task.last_started_at);
      const budgetMs = Number(run.budget?.runtime_ms) || normalizeRuntimeBudgetMs(task);
      if (startedMs <= 0) {
        await scheduler._recordTaskResult(tasksPath, {
          status: 'failed',
          task: task.task,
          reason: 'invalid_started_at',
          run_id: runId,
          started_at: normalizeString(run.started_at),
          completed_at: scheduler.nowProvider().toISOString(),
          budget: { runtime_ms: Math.max(0, Math.trunc(budgetMs)), tool_calls: 0 },
          result_ref: normalizeString(run.result_ref),
        }, task.id);
        changed = true;
        continue;
      }
      if (startedMs > 0 && nowMs - startedMs >= budgetMs) {
        await scheduler._recordTaskResult(tasksPath, {
          status: 'failed',
          task: task.task,
          reason: 'budget_exceeded',
          run_id: runId,
          started_at: normalizeString(run.started_at),
          completed_at: scheduler.nowProvider().toISOString(),
          budget: { runtime_ms: Math.max(0, Math.trunc(budgetMs)), tool_calls: 0 },
          result_ref: normalizeString(run.result_ref),
        }, task.id);
        changed = true;
      }
    }
  }
  return changed;
}

function buildAutomationSnapshot({ task, runId, startedAt, workspaceRoot, resultRef, budgetMs }) {
  const input = task.input && typeof task.input === 'object' && !Array.isArray(task.input)
    ? task.input
    : {};
  return {
    version: 1,
    run_id: runId,
    automation_id: normalizeString(task.id),
    task: normalizeString(task.task).toLowerCase(),
    task_spec: normalizeString(input.task_spec),
    tool_grants: Array.isArray(input.tool_grants) ? input.tool_grants.map(normalizeString).filter(Boolean) : [],
    isolation: input.isolation && typeof input.isolation === 'object' && !Array.isArray(input.isolation)
      ? { mode: normalizeString(input.isolation.mode).toLowerCase() || 'read_only' }
      : { mode: 'read_only' },
    workspace_root: workspaceRoot,
    started_at: startedAt,
    runtime_budget_ms: budgetMs,
    result_ref: resultRef,
  };
}

async function dispatchAutomationTask(scheduler, tasksPath, task) {
  const taskId = normalizeString(task.id);
  const startedAt = scheduler.nowProvider().toISOString();
  const runId = buildAutomationRunId({ taskId, startedAt });
  const resultRef = resolveAutomationResultRef({ automationId: taskId, runId });
  const resultPath = resolveAutomationRunResultPath({
    backgroundRuntimeRoot: scheduler.backgroundRuntimeRoot,
    automationId: taskId,
    runId,
  });
  const budgetMs = normalizeRuntimeBudgetMs(task);
  const snapshot = buildAutomationSnapshot({
    task,
    runId,
    startedAt,
    workspaceRoot: scheduler._resolveWorkspaceRoot(),
    resultRef,
    budgetMs,
  });
  const startedResult = {
    status: 'started',
    task: task.task,
    reason: 'scheduled',
    run_id: runId,
    started_at: startedAt,
    budget: { runtime_ms: budgetMs, tool_calls: 0 },
    result_ref: resultRef,
  };
  await scheduler._recordTaskResult(tasksPath, startedResult, taskId);
  try {
    const result = await scheduler._runBackgroundTask(AUTOMATION_RUN_TASK_NAME, {
      task_id: taskId,
      run_id: runId,
      started_at: startedAt,
      result_path: resultPath,
      result_ref: resultRef,
      automation: snapshot,
    });
    const normalizedResult = {
      ...startedResult,
      ...(result && typeof result === 'object' && !Array.isArray(result) ? result : {}),
      task: normalizeString(result?.task) || AUTOMATION_RUN_TASK_NAME,
      reason: normalizeString(result?.reason) || startedResult.reason,
      run_id: normalizeString(result?.run_id) || runId,
      started_at: normalizeString(result?.started_at) || startedAt,
      result_ref: normalizeString(result?.result_ref) || resultRef,
    };
    await scheduler._recordTaskResult(tasksPath, normalizedResult, taskId);
    return normalizedResult;
  } catch (error) {
    scheduler.logger('WARN', 'scheduler.automation_dispatch_failed', {
      taskId,
      runId,
      message: String(error?.message || error),
    });
    const failedResult = {
      ...startedResult,
      status: 'failed',
      reason: 'rpc_failed',
      completed_at: scheduler.nowProvider().toISOString(),
    };
    await scheduler._recordTaskResult(tasksPath, failedResult, taskId);
    return failedResult;
  }
}

module.exports = {
  AUTOMATION_RUN_TASK_NAME,
  buildAutomationRunId,
  dispatchAutomationTask,
  hasActiveAutomationRun,
  reconcileAutomationRuns,
  resolveAutomationRunResultPath,
};
