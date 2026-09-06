'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcileAutomationRuns } = require('../services/scheduler-automation-runtime');

test('reconciliation fails an active persisted run with no valid start timestamp', async () => {
  const recorded = [];
  const scheduler = {
    backgroundRuntimeRoot: 'G:\\runtime',
    fs: {
      readFileSync() {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
    },
    logger() {},
    nowProvider: () => new Date('2026-05-19T11:00:00.000Z'),
    async _recordTaskResult(tasksPath, result, taskId) {
      recorded.push({ tasksPath, result, taskId });
    },
  };
  const task = {
    id: 'automation:malformed',
    task: 'project_health',
    kind: 'automation',
    last_started_at: 'not-a-date',
    policy: { runtime_budget_ms: 60_000 },
    automation_runs: [{
      run_id: 'run_malformed',
      status: 'running',
      started_at: '',
      result_ref: 'automation_malformed/run_malformed.result.json',
      budget: { runtime_ms: 60_000, tool_calls: 0 },
    }],
  };

  const changed = await reconcileAutomationRuns(scheduler, 'tasks.json', [task]);

  assert.equal(changed, true);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].result.status, 'failed');
  assert.equal(recorded[0].result.reason, 'invalid_started_at');
  assert.equal(recorded[0].result.run_id, 'run_malformed');
});
