'use strict';

function normalizeTaskName(task) {
  return String(task || '').trim().toLowerCase();
}

function normalizeOptionalText(value, maxLength = 2000) {
  const token = String(value || '').trim();
  return token ? token.slice(0, maxLength) : undefined;
}

function normalizeNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : undefined;
}

function normalizeBudget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const runtimeMs = normalizeNonNegativeInteger(value.runtime_ms);
  const toolCalls = normalizeNonNegativeInteger(value.tool_calls);
  if (runtimeMs === undefined && toolCalls === undefined) {
    return undefined;
  }
  return {
    runtime_ms: runtimeMs ?? 0,
    tool_calls: toolCalls ?? 0,
  };
}

function normalizeArtifacts(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const artifacts = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const artifactId = normalizeOptionalText(entry.artifact_id || entry.id, 128);
    if (!artifactId) {
      continue;
    }
    artifacts.push({
      artifact_id: artifactId,
      kind: normalizeOptionalText(entry.kind, 128) || 'artifact',
      title: normalizeOptionalText(entry.title, 200) || '',
    });
    if (artifacts.length >= 20) {
      break;
    }
  }
  return artifacts.length ? artifacts : undefined;
}

function normalizeBackgroundResult(payload, normalizedTask) {
  const result = {
    status: normalizeOptionalText(payload?.status, 128) || 'skipped',
    task: normalizeOptionalText(payload?.task, 128) || normalizedTask,
    reason: normalizeOptionalText(payload?.reason, 512),
  };
  for (const key of ['run_id', 'started_at', 'completed_at', 'result_ref']) {
    const value = normalizeOptionalText(payload?.[key], 256);
    if (value) {
      result[key] = value;
    }
  }
  const summary = normalizeOptionalText(payload?.summary, 2000);
  if (summary) {
    result.summary = summary;
  }
  const budget = normalizeBudget(payload?.budget);
  if (budget) {
    result.budget = budget;
  }
  const artifacts = normalizeArtifacts(payload?.artifacts);
  if (artifacts) {
    result.artifacts = artifacts;
  }
  return result;
}

async function runBackgroundTask(service, task, params = {}) {
  const normalizedTask = normalizeTaskName(task);
  if (!normalizedTask) {
    throw new Error('task is required');
  }
  if (
    !service.sidecarClient
    || typeof service.sidecarClient.backgroundRun !== 'function'
  ) {
    const reason = service.sidecarClient ? 'background_run_unavailable' : 'sidecar_unavailable';
    if (typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('INFO', 'background.run_skipped', {
        task: normalizedTask,
        reason,
      });
    }
    return {
      status: 'skipped',
      task: normalizedTask,
      reason,
    };
  }
  const payload = await service.sidecarClient.backgroundRun(normalizedTask, params);
  return normalizeBackgroundResult(payload, normalizedTask);
}

module.exports = {
  runBackgroundTask,
};
