'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeScheduledTasks,
} = require('../services/scheduler-task-registry');
const {
  SCHEDULED_TASKS_SCHEMA_VERSION,
} = require('../services/scheduler-schema-version');

describe('scheduler schema v4 / automation-only migration', () => {
  test('schema version constant advances to v4', () => {
    assert.equal(SCHEDULED_TASKS_SCHEMA_VERSION, 4);
  });

  test('normalizeScheduledTasks stamps the new schema version on output', () => {
    const result = normalizeScheduledTasks({ tasks: [] });
    assert.equal(result.version, SCHEDULED_TASKS_SCHEMA_VERSION);
  });

  for (const version of [2, 3]) {
    test(`v${version} planner records are dropped during the v4 migration`, () => {
      const result = normalizeScheduledTasks({
        version,
        tasks: [
          {
            id: 'builtin:sub_agent_planner',
            task: 'sub_agent_planner',
            kind: 'sub_agent',
            enabled: true,
            trigger: { type: 'interval', interval_seconds: 60 },
          },
        ],
      });
      assert.equal(result.version, 4);
      assert.equal(result.tasks.some((t) => t.id === 'builtin:sub_agent_planner'), false);
    });
  }
});

describe('automation task records preserve automation_runs[]', () => {
  function automationPayload(overrides = {}) {
    return {
      id: 'automation:project_health',
      task: 'project_health',
      kind: 'automation',
      enabled: true,
      trigger: { type: 'interval', interval_seconds: 86_400 },
      automation_runs: [
        {
          run_id: 'run_01',
          status: 'completed',
          started_at: '2026-05-16T10:00:00.000Z',
          completed_at: '2026-05-16T10:00:07.000Z',
          summary: 'No issues found.',
          budget: { runtime_ms: 7_000, tool_calls: 3 },
          artifacts: [],
        },
      ],
      ...overrides,
    };
  }

  test('automation record carries normalized trigger, policy, retention, and automation_runs[]', () => {
    const result = normalizeScheduledTasks({
      tasks: [
        automationPayload({
          trigger: { type: 'interval', interval_seconds: 0.5 },
          policy: {
            requires_feature_flags: ['TOOLS_AUTOMATIONS_ENABLED', '', 'tools_git_enabled'],
            defer_when_chat_active: false,
            runtime_budget_ms: 60_500.8,
          },
          input: {
            task_spec: 'Run the read-only project health check.',
            tool_grants: ['filesystem', 'git', '', 'git'],
            isolation: { mode: 'read_only' },
          },
          retention: { max_runs: 2, max_log_bytes: 5_000 },
          automation_runs: [
            {
              run_id: 'run_oldest',
              status: 'completed',
              summary: 'Oldest run should be evicted by retention.',
            },
            {
              run_id: 'run_recent',
              status: 'completed',
              summary: 'Recent run.',
              budget: { runtime_ms: 12.8, tool_calls: -4 },
              artifacts: [
                { artifact_id: 'artifact_1', kind: 'report', title: 'Project report' },
              ],
            },
            {
              run_id: 'run_newest',
              status: 'surprising',
              summary: 'x'.repeat(2_100),
              artifacts: Array.from({ length: 25 }, (_entry, index) => ({
                artifact_id: `artifact_${index}`,
                kind: 'log',
                title: `Log ${index}`,
              })),
            },
          ],
        }),
      ],
    });
    const record = result.tasks.find((t) => t.id === 'automation:project_health');

    assert.ok(record);
    assert.equal(record.kind, 'automation');
    assert.equal(record.task, 'project_health');
    assert.deepEqual(record.trigger, { type: 'interval', interval_seconds: 1 });
    assert.deepEqual(record.policy, {
      requires_feature_flags: ['tools_automations_enabled', 'tools_git_enabled'],
      defer_when_chat_active: false,
      runtime_budget_ms: 60500,
    });
    assert.deepEqual(record.input, {
      task_spec: 'Run the read-only project health check.',
      tool_grants: ['filesystem', 'git'],
      isolation: { mode: 'read_only' },
    });
    assert.deepEqual(record.retention, { max_runs: 2, max_log_bytes: 5_000 });
    assert.equal(record.automation_runs.length, 2);
    assert.equal(record.automation_runs[0].run_id, 'run_recent');
    assert.equal(record.automation_runs[0].budget.runtime_ms, 12);
    assert.equal(record.automation_runs[0].budget.tool_calls, 0);
    assert.equal(record.automation_runs[1].run_id, 'run_newest');
    assert.equal(record.automation_runs[1].status, 'pending');
    assert.equal(record.automation_runs[1].summary.length, 2_000);
    assert.equal(record.automation_runs[1].artifacts.length, 20);
  });

  test('automation records require automation-prefixed ids and do not collide with builtins', () => {
    const result = normalizeScheduledTasks({
      tasks: [
        automationPayload({ id: 'builtin:sub_agent_planner' }),
        automationPayload({ id: 'automation:project_health' }),
        automationPayload({ id: 'automation:project_health', task: 'duplicate' }),
      ],
    });

    const automationRecords = result.tasks.filter((entry) => entry.kind === 'automation');
    assert.equal(automationRecords.length, 1);
    assert.equal(automationRecords[0].id, 'automation:project_health');
  });

  test('automation run retention scans past malformed tail entries', () => {
    const malformedTail = Array.from({ length: 60 }, (_entry, index) => ({
      status: 'completed',
      summary: `malformed ${index}`,
    }));
    const result = normalizeScheduledTasks({
      tasks: [
        automationPayload({
          retention: { max_runs: 2 },
          automation_runs: [
            { run_id: 'run_keep_1', status: 'completed', summary: 'keep one' },
            { run_id: 'run_keep_2', status: 'failed', summary: 'keep two' },
            ...malformedTail,
          ],
        }),
      ],
    });

    const record = result.tasks.find((t) => t.id === 'automation:project_health');
    assert.ok(record);
    assert.deepEqual(
      record.automation_runs.map((entry) => entry.run_id),
      ['run_keep_1', 'run_keep_2']
    );
  });

  test('automation status and timestamp fields are bounded before projection', () => {
    const longToken = 'x'.repeat(5_000);
    const result = normalizeScheduledTasks({
      tasks: [
        automationPayload({
          last_status: longToken,
          last_reason: longToken,
          last_started_at: longToken,
          last_result_at: longToken,
          last_completed_at: longToken,
          updated_at: longToken,
          automation_runs: [
            {
              run_id: 'run_long_fields',
              status: 'completed',
              reason: longToken,
              started_at: longToken,
              completed_at: longToken,
            },
          ],
        }),
      ],
    });

    const record = result.tasks.find((t) => t.id === 'automation:project_health');
    assert.ok(record);
    assert.equal(record.last_status.length, 128);
    assert.equal(record.last_reason.length, 128);
    assert.equal(record.last_started_at.length, 128);
    assert.equal(record.last_result_at.length, 128);
    assert.equal(record.last_completed_at.length, 128);
    assert.equal(record.updated_at.length, 128);
    assert.equal(record.automation_runs[0].reason.length, 128);
    assert.equal(record.automation_runs[0].started_at.length, 128);
    assert.equal(record.automation_runs[0].completed_at.length, 128);
  });
});
