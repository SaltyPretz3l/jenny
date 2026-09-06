'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { AutomationService } = require('../services/automation-service');
const { createDefaultRegistry } = require('../services/tools');
const {
  executeElectronToolRequest,
} = require('../services/backend/electron-tool-bridge');
const {
  SCHEDULED_TASKS_SCHEMA_VERSION,
} = require('../services/scheduler-schema-version');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function writeScheduledTasks(workspaceRoot, tasks) {
  const tasksPath = path.join(workspaceRoot, '.jenny', 'scheduled_tasks.json');
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify({
    version: SCHEDULED_TASKS_SCHEMA_VERSION,
    tasks,
  }, null, 2));
}

function createAutomationRecord(overrides = {}) {
  return {
    id: 'automation:project_health',
    task: 'project_health',
    kind: 'automation',
    enabled: true,
    trigger: { type: 'interval', interval_seconds: 86_400 },
    policy: {
      requires_feature_flags: ['tools_automations_enabled', 'tools_git_enabled'],
      defer_when_chat_active: true,
    },
    input: {
      task_spec: 'Run the read-only project health check.',
      tool_grants: ['filesystem', 'git'],
      isolation: { mode: 'read_only' },
    },
    retention: { max_runs: 2, max_log_bytes: 8_000 },
    automation_runs: [
      {
        run_id: 'run_01',
        status: 'completed',
        reason: 'ok',
        started_at: '2026-05-19T10:00:00.000Z',
        completed_at: '2026-05-19T10:00:07.000Z',
        summary: 'No failing checks found.',
        budget: { runtime_ms: 7000, tool_calls: 3 },
        artifacts: [
          { artifact_id: 'artifact_project_health', kind: 'report', title: 'Project Health' },
        ],
      },
    ],
    last_status: 'completed',
    last_reason: 'ok',
    last_started_at: '2026-05-19T10:00:00.000Z',
    last_result_at: '2026-05-19T10:00:07.000Z',
    last_completed_at: '2026-05-19T10:00:07.000Z',
    updated_at: '2026-05-19T10:00:08.000Z',
    ...overrides,
  };
}

function makeAutomationService(workspaceRoot) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-automation-userdata-'));
  trackDirectory(userDataPath);
  return new AutomationService({
    userDataPath,
    configService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
  });
}

describe('AutomationService read-only projection', () => {
  test('lists automation records without exposing task specs or local paths', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-automation-workspace-'));
    trackDirectory(workspaceRoot);
    writeScheduledTasks(workspaceRoot, [
      createAutomationRecord(),
      {
        id: 'builtin:sub_agent_planner',
        task: 'sub_agent_planner',
        kind: 'sub_agent',
        enabled: true,
        trigger: { type: 'interval', interval_seconds: 60 },
      },
    ]);

    const result = await makeAutomationService(workspaceRoot).listAutomations();

    assert.equal(result.success, true);
    assert.equal(result.automations.length, 1);
    assert.deepEqual(result.automations[0], {
      id: 'automation:project_health',
      task: 'project_health',
      enabled: true,
      trigger: { type: 'interval', interval_seconds: 86400 },
      policy: {
        requires_feature_flags: ['tools_automations_enabled', 'tools_git_enabled'],
        defer_when_chat_active: true,
      },
      isolation_mode: 'read_only',
      tool_grants: ['filesystem', 'git'],
      retention: { max_runs: 2, max_log_bytes: 8000 },
      last_status: 'completed',
      last_reason: 'ok',
      last_result_at: '2026-05-19T10:00:07.000Z',
      last_completed_at: '2026-05-19T10:00:07.000Z',
      run_count: 1,
      latest_run: {
        run_id: 'run_01',
        status: 'completed',
        reason: 'ok',
        started_at: '2026-05-19T10:00:00.000Z',
        completed_at: '2026-05-19T10:00:07.000Z',
        summary: 'No failing checks found.',
      },
    });
    assert.equal(JSON.stringify(result).includes('Run the read-only project health check'), false);
    assert.equal(JSON.stringify(result).includes(workspaceRoot), false);
  });

  test('lists automation records through the async scheduled task reader', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-automation-async-userdata-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-automation-async-workspace-'));
    trackDirectory(userDataPath);
    trackDirectory(workspaceRoot);
    const readCalls = [];
    const fsImpl = {
      promises: {
        async readFile(tasksPath, encoding) {
          readCalls.push({ tasksPath, encoding });
          return JSON.stringify({
            version: SCHEDULED_TASKS_SCHEMA_VERSION,
            tasks: [createAutomationRecord()],
          });
        },
      },
      readFileSync() {
        throw new Error('sync read should not be used');
      },
    };

    const service = new AutomationService({
      userDataPath,
      fsImpl,
      configService: {
        getState() {
          return { toolsWorkspaceRoot: workspaceRoot };
        },
      },
    });

    const result = await service.listAutomations();

    assert.equal(readCalls.length, 1);
    assert.equal(readCalls[0].encoding, 'utf8');
    assert.equal(result.success, true);
    assert.equal(result.automations.length, 1);
    assert.equal(result.automations[0].id, 'automation:project_health');
  });

  test('caps automation list projections and reports omitted entries', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-automation-many-workspace-'));
    trackDirectory(workspaceRoot);
    writeScheduledTasks(
      workspaceRoot,
      Array.from({ length: 105 }, (_entry, index) => createAutomationRecord({
        id: `automation:item_${String(index).padStart(3, '0')}`,
        task: `item_${String(index).padStart(3, '0')}`,
        automation_runs: [],
      }))
    );

    const result = await makeAutomationService(workspaceRoot).listAutomations();

    assert.equal(result.success, true);
    assert.equal(result.total_count, 105);
    assert.equal(result.omitted_count, 5);
    assert.equal(result.max_items, 100);
    assert.equal(result.automations.length, 100);
    assert.equal(result.automations.at(-1).id, 'automation:item_099');
  });

  test('reads one automation with bounded run history and an untrusted task spec marker', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-automation-read-workspace-'));
    trackDirectory(workspaceRoot);
    writeScheduledTasks(workspaceRoot, [createAutomationRecord()]);

    const result = await makeAutomationService(workspaceRoot).readAutomation('automation:project_health');

    assert.equal(result.success, true);
    assert.equal(result.automation.id, 'automation:project_health');
    assert.equal(result.automation.task_spec, 'Run the read-only project health check.');
    assert.equal(result.automation.task_spec_trust, 'user_authored_untrusted');
    assert.equal(result.automation.automation_runs.length, 1);
    assert.deepEqual(result.automation.automation_runs[0].artifacts, [
      { artifact_id: 'artifact_project_health', kind: 'report', title: 'Project Health' },
    ]);
  });

  test('returns a structured not_found result for missing automation ids', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-automation-missing-workspace-'));
    trackDirectory(workspaceRoot);
    writeScheduledTasks(workspaceRoot, [createAutomationRecord()]);

    const result = await makeAutomationService(workspaceRoot).readAutomation('automation:missing');

    assert.deepEqual(result, {
      success: false,
      reason: 'not_found',
      message: 'Automation "automation:missing" was not found.',
    });
  });

  test('summarizes automation status without leaking task specs or local paths', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-automation-status-workspace-'));
    trackDirectory(workspaceRoot);
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-automation-status-userdata-'));
    trackDirectory(userDataPath);
    const secretTaskSpec = `Inspect ${workspaceRoot}\\private\\plan.md`;
    writeScheduledTasks(workspaceRoot, [
      createAutomationRecord({
        input: {
          task_spec: secretTaskSpec,
          tool_grants: ['filesystem', 'git'],
          isolation: { mode: 'read_only' },
        },
        automation_runs: [
          {
            run_id: 'run_completed',
            status: 'completed',
            reason: 'ok',
            started_at: '2026-05-19T10:00:00.000Z',
            completed_at: '2026-05-19T10:00:01.000Z',
            summary: 'Healthy.',
            result_ref: `${workspaceRoot}\\automations\\completed.json`,
          },
          {
            run_id: 'run_failed_old',
            status: 'failed',
            reason: 'budget_exceeded',
            started_at: '2026-05-19T11:00:00.000Z',
            completed_at: '2026-05-19T11:00:03.000Z',
            summary: `Could not inspect ${workspaceRoot}\\private\\plan.md before timeout.`,
            result_ref: `${workspaceRoot}\\automations\\failed-old.json`,
          },
          { run_id: '', status: 'failed', summary: 'missing id is ignored' },
          'not-a-run',
        ],
      }),
      createAutomationRecord({
        id: 'automation:nightly_docs',
        task: 'nightly_docs',
        enabled: false,
        retention: { max_runs: 4, max_log_bytes: 8_000 },
        input: {
          task_spec: `Summarize ${userDataPath}\\notes.txt`,
          tool_grants: ['filesystem'],
          isolation: { mode: 'read_only' },
        },
        automation_runs: [
          {
            run_id: 'run_running',
            status: 'running',
            reason: 'in_progress',
            started_at: '2026-05-19T12:00:00.000Z',
            summary: 'Running now.',
          },
          {
            run_id: 'run_pending',
            status: 'pending',
            reason: 'awaiting_reconcile',
            started_at: '2026-05-19T12:10:00.000Z',
            summary: 'Pending result reconciliation.',
          },
          {
            run_id: 'run_skipped',
            status: 'skipped',
            reason: 'feature_disabled',
            started_at: '2026-05-19T12:30:00.000Z',
            completed_at: '2026-05-19T12:30:00.000Z',
            summary: 'Skipped.',
          },
          {
            run_id: 'run_failed_new',
            status: 'failed',
            reason: 'sidecar_unavailable',
            started_at: '2026-05-19T13:00:00.000Z',
            completed_at: '2026-05-19T13:00:04.000Z',
            summary: `Sidecar failed at ${userDataPath}\\worker.json`,
            result_ref: `${userDataPath}\\automations\\failed-new.json`,
          },
        ],
      }),
    ]);
    const service = new AutomationService({
      userDataPath,
      configService: {
        getState() {
          return { toolsWorkspaceRoot: workspaceRoot };
        },
      },
    });

    const result = await service.getStatusSummary();

    assert.equal(result.success, true);
    assert.equal(result.total, 2);
    assert.equal(result.enabled, 1);
    assert.equal(result.disabled, 1);
    assert.equal(result.running, 2);
    assert.equal(result.completed_runs, 1);
    assert.equal(result.failed_runs, 2);
    assert.equal(result.skipped_runs, 1);
    assert.equal(result.last_failure_at, '2026-05-19T13:00:04.000Z');
    assert.deepEqual(result.last_failure, {
      automation_id: 'automation:nightly_docs',
      task: 'nightly_docs',
      run_id: 'run_failed_new',
      status: 'failed',
      reason: 'sidecar_unavailable',
      started_at: '2026-05-19T13:00:00.000Z',
      completed_at: '2026-05-19T13:00:04.000Z',
      summary: 'Sidecar failed at [redacted]',
    });
    assert.deepEqual(
      result.recent_failures.map((entry) => entry.run_id),
      ['run_failed_new', 'run_failed_old']
    );
    const exposed = JSON.stringify(result);
    assert.equal(exposed.includes(secretTaskSpec), false);
    assert.equal(exposed.includes(workspaceRoot), false);
    assert.equal(exposed.includes(userDataPath), false);
    assert.equal(exposed.includes('result_ref'), false);
    assert.equal(exposed.includes('failed-new.json'), false);
  });

  test('caps recent automation failure summaries', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-automation-failure-cap-'));
    trackDirectory(workspaceRoot);
    writeScheduledTasks(workspaceRoot, [
      createAutomationRecord({
        automation_runs: Array.from({ length: 12 }, (_entry, index) => ({
          run_id: `run_failed_${String(index).padStart(2, '0')}`,
          status: 'failed',
          reason: 'test_failure',
          started_at: `2026-05-19T${String(index).padStart(2, '0')}:00:00.000Z`,
          completed_at: `2026-05-19T${String(index).padStart(2, '0')}:00:01.000Z`,
          summary: `Failure ${index}`,
        })),
        retention: { max_runs: 20, max_log_bytes: 8_000 },
      }),
    ]);

    const result = await makeAutomationService(workspaceRoot).getStatusSummary();

    assert.equal(result.success, true);
    assert.equal(result.failed_runs, 12);
    assert.equal(result.recent_failures.length, 10);
    assert.equal(result.recent_failures[0].run_id, 'run_failed_11');
    assert.equal(result.recent_failures.at(-1).run_id, 'run_failed_02');
    assert.equal(result.recent_failure_count, 10);
    assert.equal(result.omitted_failure_count, 2);
  });
});

describe('automation tool registry', () => {
  test('automation tools are default-off and enabled only with toolsAutomationsEnabled', () => {
    const defaultRegistry = createDefaultRegistry();
    assert.equal(defaultRegistry.getTool('automation_list'), undefined);
    assert.equal(defaultRegistry.getTool('automation_read'), undefined);

    const enabledRegistry = createDefaultRegistry({ toolsAutomationsEnabled: true });
    assert.equal(enabledRegistry.getTool('automation_list').readOnly, true);
    assert.equal(enabledRegistry.getTool('automation_read').readOnly, true);
  });
});

describe('automation_list and automation_read tools', () => {
  test('automation_list delegates to the Electron-owned AutomationService', async () => {
    const registry = createDefaultRegistry({ toolsAutomationsEnabled: true });
    const tool = registry.getTool('automation_list');
    let listed = false;

    const result = await tool.execute({}, {
      automationService: {
        async listAutomations() {
          listed = true;
          return {
            success: true,
            automations: [
              {
                id: 'automation:project_health',
                task: 'project_health',
                enabled: true,
                run_count: 1,
                last_status: 'completed',
              },
            ],
          };
        },
      },
    });

    assert.equal(listed, true);
    assert.equal(result.isError, false);
    assert.equal(result.metadata.result_kind, 'automation_list');
    assert.equal(result.metadata.count, 1);
    assert.equal(result.metadata.automations[0].id, 'automation:project_health');
  });

  test('automation_read delegates by id and returns not_found as a tool error', async () => {
    const registry = createDefaultRegistry({ toolsAutomationsEnabled: true });
    const tool = registry.getTool('automation_read');
    let readId = '';

    const result = await tool.execute({ automation_id: 'automation:missing' }, {
      automationService: {
        async readAutomation(id) {
          readId = id;
          return {
            success: false,
            reason: 'not_found',
            message: 'Automation "automation:missing" was not found.',
          };
        },
      },
    });

    assert.equal(readId, 'automation:missing');
    assert.equal(result.isError, true);
    assert.equal(result.metadata.result_kind, 'automation_read');
    assert.equal(result.metadata.reason, 'not_found');
  });

  test('automation_read includes the bounded definition and run history in model-visible content', async () => {
    const registry = createDefaultRegistry({ toolsAutomationsEnabled: true });
    const tool = registry.getTool('automation_read');
    const automation = {
      id: 'automation:project_health',
      task: 'project_health',
      task_spec: 'Run project checks.',
      automation_runs: [{ id: 'run-1', status: 'completed', artifacts: ['report.json'] }],
    };

    const result = await tool.execute({ automation_id: automation.id }, {
      automationService: {
        async readAutomation() {
          return { success: true, automation };
        },
      },
    });

    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content), { automation });
  });
});

describe('Electron automation tool bridge', () => {
  test('allows automation_list through the Electron tool bridge allowlist', async () => {
    let bridgedCall = null;
    const result = await executeElectronToolRequest(
      {
        configService: {
          getState() {
            return { toolsWorkspaceRoot: 'C:/dev/jenny' };
          },
        },
        toolExecutor: {
          async executePreApproved(call, context) {
            bridgedCall = { call, context };
            return {
              content: 'Found 0 automation(s).',
              isError: false,
              metadata: { result_kind: 'automation_list', count: 0 },
            };
          },
        },
      },
      {
        sessionId: 'session_automation',
        streamId: 'stream_automation',
        params: {
          tool_name: 'automation_list',
          tool_call_id: 'call_automation',
          arguments: {},
        },
      }
    );

    assert.equal(result.success, true);
    assert.equal(result.metadata.result_kind, 'automation_list');
    assert.equal(bridgedCall.call.toolName, 'automation_list');
    assert.equal(bridgedCall.context.workingDirectory, path.resolve('C:/dev/jenny'));
  });
});
