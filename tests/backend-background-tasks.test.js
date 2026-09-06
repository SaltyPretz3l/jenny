const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runBackgroundTask,
} = require('../services/backend/backend-background-tasks');

test('runBackgroundTask skips when managed sidecar is unavailable', async () => {
  const logs = [];
  const result = await runBackgroundTask({
    sidecarClient: null,
    _emitServiceLog(level, event, data) {
      logs.push({ level, event, data });
    },
  }, 'automation_run', {});

  assert.deepEqual(result, {
    status: 'skipped',
    task: 'automation_run',
    reason: 'sidecar_unavailable',
  });
  assert.equal(logs[0].event, 'background.run_skipped');
});

test('runBackgroundTask delegates to sidecar background.run and normalizes result fields', async () => {
  const calls = [];
  const service = {
    sidecarClient: {
      async backgroundRun(task, params) {
        calls.push({ task, params });
        return {
          status: 'started',
          task: 'automation_run',
          reason: '',
        };
      },
    },
  };

  const result = await runBackgroundTask(service, ' automation_run ', {
    task_id: 'automation:project_health',
  });

  assert.deepEqual(calls, [
    {
      task: 'automation_run',
      params: { task_id: 'automation:project_health' },
    },
  ]);
  assert.deepEqual(result, {
    status: 'started',
    task: 'automation_run',
    reason: undefined,
  });
});

test('runBackgroundTask preserves bounded automation result fields from sidecar', async () => {
  const service = {
    sidecarClient: {
      async backgroundRun() {
        return {
          status: 'completed',
          task: 'automation_run',
          reason: 'ok',
          run_id: 'run_123',
          started_at: '2026-05-19T11:00:00.000Z',
          completed_at: '2026-05-19T11:00:03.000Z',
          summary: 'Project health looks good.',
          budget: {
            runtime_ms: 3123.8,
            tool_calls: 2.2,
            raw_path: 'G:\\Secret\\do-not-preserve.txt',
          },
          artifacts: [
            {
              artifact_id: 'artifact_project_health',
              kind: 'report',
              title: 'Project Health',
              path: 'G:\\Secret\\report.md',
            },
          ],
          result_ref: 'automation_project_health/run_123.result.json',
          raw_path: 'G:\\Secret\\result.json',
        };
      },
    },
  };

  const result = await runBackgroundTask(service, 'automation_run', {});

  assert.deepEqual(result, {
    status: 'completed',
    task: 'automation_run',
    reason: 'ok',
    run_id: 'run_123',
    started_at: '2026-05-19T11:00:00.000Z',
    completed_at: '2026-05-19T11:00:03.000Z',
    summary: 'Project health looks good.',
    budget: {
      runtime_ms: 3123,
      tool_calls: 2,
    },
    artifacts: [
      {
        artifact_id: 'artifact_project_health',
        kind: 'report',
        title: 'Project Health',
      },
    ],
    result_ref: 'automation_project_health/run_123.result.json',
  });
});

test('runBackgroundTask skips cleanly when background.run is unavailable on the client', async () => {
  const logs = [];
  const result = await runBackgroundTask({
    sidecarClient: {},
    _emitServiceLog(level, event, data) {
      logs.push({ level, event, data });
    },
  }, 'automation_run', {});

  assert.deepEqual(result, {
    status: 'skipped',
    task: 'automation_run',
    reason: 'background_run_unavailable',
  });
  assert.deepEqual(logs[0], {
    level: 'INFO',
    event: 'background.run_skipped',
    data: {
      task: 'automation_run',
      reason: 'background_run_unavailable',
    },
  });
});
