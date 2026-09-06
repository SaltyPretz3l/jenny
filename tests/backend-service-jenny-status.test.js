'use strict';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const { UsageHistoryService } = require('../services/usage-history-service');
const { ShellLogStore } = require('../services/shell-log-store');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const {
  cleanupTrackedResources,
} = require('./helpers/resource-cleanup');
const {
  createTrackedUserDataPath,
  writeTurnDiagnostic,
} = require('./helpers/turn-diagnostic-fixtures');

function createJennyStatusSafeStorage() {
  return {
    ...createFakeSafeStorage(),
    getSelectedStorageBackend: () => 'dpapi',
  };
}

function getEmptyDiagnosticsMetadata() {
  return { sources: {}, integrity: { complete: true, partial_reasons: [] } };
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('backend service composes Jenny status from existing observability facets', async () => {
  const userDataPath = createTrackedUserDataPath('jenny-status-service-');
  const logStore = new ShellLogStore({ limit: 50 });
  logStore.getCurrentDiagnosticsMetadata = getEmptyDiagnosticsMetadata;
  const usageHistory = new UsageHistoryService({ userDataPath });
  const service = new BackendService({
    appVersion: '9.8.7-test',
    userDataPath,
    safeStorage: createJennyStatusSafeStorage(),
    isSafeStorageReady: () => true,
    usageHistory,
    shellLogStore: logStore,
    toolPermissionStore: {
      getSnapshot() {
        return {
          version: 4,
          legacy_policies: {
            read_file: 'auto',
            write_file: 'ask',
          },
          rules: [
            {
              id: 'deny-secret-path',
              decision: 'deny',
              reason: `block ${userDataPath}`,
              match: {
                tool_id: 'write_file',
                path_prefix: path.join(userDataPath, 'secrets'),
              },
            },
          ],
        };
      },
    },
    automationService: {
      async getStatusSummary() {
        return {
          success: true,
          total: 2,
          enabled: 1,
          disabled: 1,
          running: 1,
          completed_runs: 3,
          failed_runs: 1,
          skipped_runs: 2,
          last_failure_at: '2026-05-19T13:00:04.000Z',
          last_failure: {
            automation_id: 'automation:project_health',
            task: 'project_health',
            run_id: 'run_failed',
            status: 'failed',
            reason: 'sidecar_unavailable',
            started_at: '2026-05-19T13:00:00.000Z',
            completed_at: '2026-05-19T13:00:04.000Z',
            summary: 'Sidecar unavailable.',
          },
          recent_failures: [
            {
              automation_id: 'automation:project_health',
              task: 'project_health',
              run_id: 'run_failed',
              status: 'failed',
              reason: 'sidecar_unavailable',
              started_at: '2026-05-19T13:00:00.000Z',
              completed_at: '2026-05-19T13:00:04.000Z',
              summary: 'Sidecar unavailable.',
            },
          ],
          recent_failure_count: 1,
          omitted_failure_count: 0,
          max_recent_failures: 10,
        };
      },
    },
    systemStatsProvider: () => ({
      cpuPercent: 17.5,
      ramPercent: 44.25,
      battery: 'AC',
      sampledAt: '2026-05-07T12:00:00.000Z',
      arch: 'x64',
      gpuMemory: {
        available: true,
        usedMb: 1024,
        totalMb: 4096,
        gpuType: 'discrete',
        source: 'test',
        sampledAt: '2026-05-07T12:00:00.000Z',
      },
    }),
  });
  service.sidecarManager.getStatus = () => ({
    phase: 'ready',
    detail: 'Managed sidecar ready',
    baseUrl: 'stdio',
    pid: 12345,
    launchSource: 'managed-dev',
  });
  service.sidecarClient = { connected: true, dispose() {} };
  service._managedReadyOnce = true;
  service.currentStatus = {
    engine: 'ollama',
    model: 'qwen3:8b',
    model_loaded: true,
    tools_status: {
      read_file: { available: true, reason: '', tool_family: 'filesystem' },
    },
    schema_versions: [
      {
        id: 'sidecar.memory_store',
        surface: 'Memory store',
        owner: 'sidecar',
        kind: 'sqlite_schema',
        version: 5,
        forward_policy: 'reject_future',
        source: 'sidecar/ai/memory/store.py',
      },
    ],
  };
  service.inspectHarness = async () => ({
    generated_at: '2026-05-07T12:00:00.000Z',
    sections: ['tools'],
    runtime: {
      system_pressure: {
        status: 'warn',
        cpu_percent: 80,
        ram_percent: 72,
        reason: 'test pressure',
      },
    },
    tools: { counts: { total: 1, enabled: 1, disabled: 0 }, items: [] },
  });
  writeTurnDiagnostic(userDataPath, '2026-05-07', 'stream-a', {
    schema_version: 1,
    written_at: '2026-05-07T12:00:01.000Z',
    request_id: 'request-a',
    stream_id: 'stream-a',
    session_id: 'session-a',
    trace_id: 'trace-a',
    terminal_status: 'complete',
    engine_type: 'ollama',
    model: 'qwen3:8b',
    mode: 'chat',
    timing_markers: [
      { name: 'created', ts_ms: 1_000 },
      { name: 'provider_request_start', ts_ms: 1_080 },
      { name: 'first_chunk', ts_ms: 1_520 },
      { name: 'done', ts_ms: 1_700 },
    ],
    provider_diagnostics: {
      time_to_provider_request_start_ms: 80,
      time_to_first_chunk_ms: 520,
      time_to_first_visible_token_ms: 640,
      visible_tokens_per_second_estimate: 12.5,
    },
    tool_events: [
      { call_id: 'call-read-file', name: 'read_file', phase: 'executing', ts_ms: 1_100 },
      { call_id: 'call-read-file', name: 'read_file', phase: 'result', ts_ms: 1_400 },
    ],
    assistant_content: 'private assistant text',
  });
  logStore.append({ level: 'INFO', event: 'backend.ready', details: { requestId: 'req-1' } });
  logStore.append({
    level: 'WARN',
    event: 'tool.slow',
    details: {
      tool: 'read_file',
      sessionId: 'session-a',
      streamId: 'stream-a',
      requestId: 'request-a',
      traceId: 'trace-a',
      category: 'latency',
    },
  });
  logStore.append({
    level: 'ERROR',
    event: 'tool.failed',
    details: {
      errorCode: 'CMP-TOOL-0001',
      sessionId: 'session-a',
      streamId: 'stream-a',
      requestId: 'request-a',
      traceId: 'trace-a',
      category: 'tool',
    },
  });
  usageHistory.recordTurnUsage('session-a', {
    model: 'qwen3:8b',
    provider: 'chatgpt',
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
    cost_usd: 0.0123,
    cost_source: 'provider',
  }, {
    streamId: 'stream-a',
    requestId: 'request-a',
    traceId: 'trace-a',
    terminalType: 'complete',
    durationMs: 700,
  });
  service.phasePercentilesAggregator.record('provider_request_start_to_first_chunk', 500);
  service.toolObservabilityAggregator.recordToolResult({
    streamId: 'stream-a',
    sessionId: 'session-a',
    callId: 'call-read-file',
    toolName: 'read_file',
    success: false,
    errorCode: 'CMP-TOOL-0001',
    durationMs: 3000,
  });

  try {
    const status = await service.getJennyStatus({ sessionId: 'session-a', recentLogLimit: 5 });

    assert.equal(status.facade, 'jenny_status');
    assert.equal(status.schema_version, 4);
    assert.equal(status.backend.phase, 'ready');
    assert.equal(status.backend.app_version, '9.8.7-test');
    assert.equal(status.runtime.model, 'qwen3:8b');
    assert.equal(status.runtime.model_loaded, true);
    assert.equal(status.runtime.lifecycle.state, 'ready');
    assert.equal(status.runtime.lifecycle.managed_initialized, true);
    assert.equal(status.runtime.lifecycle.transport_connected, true);
    assert.equal(status.runtime.lifecycle.pid, 12345);
    assert.equal(status.harness.available, true);
    assert.equal(status.harness.snapshot.tools.counts.total, 1);
    assert.equal(status.resources.available, true);
    assert.equal(status.resources.system.cpuPercent, 17.5);
    assert.equal(status.resources.system.gpuMemory.totalMb, 4096);
    assert.equal(status.resources.sidecar.system_pressure.status, 'warn');
    assert.equal(status.automations.available, true);
    assert.equal(status.automations.total, 2);
    assert.equal(status.automations.enabled, 1);
    assert.equal(status.automations.disabled, 1);
    assert.equal(status.automations.running, 1);
    assert.equal(status.automations.completed_runs, 3);
    assert.equal(status.automations.failed_runs, 1);
    assert.equal(status.automations.skipped_runs, 2);
    assert.equal(status.automations.last_failure_at, '2026-05-19T13:00:04.000Z');
    assert.equal(status.automations.last_failure.run_id, 'run_failed');
    assert.equal(status.automations.recent_failures.length, 1);
    assert.equal(status.tool_policy.available, true);
    assert.equal(status.tool_policy.kind, 'policy');
    assert.equal(status.tool_policy.version, 4);
    assert.equal(status.tool_policy.legacy_policy_count, 2);
    assert.equal(status.tool_policy.rule_count, 1);
    assert.match(status.tool_policy.snapshot_id, /^policy_[a-f0-9]{16}$/);
    assert.deepEqual(status.tool_policy.hooks, { enabled: false, registered_count: 0 });
    const policyStatusText = JSON.stringify(status.tool_policy);
    assert.equal(policyStatusText.includes(userDataPath), false);
    assert.equal(policyStatusText.includes('deny-secret-path'), false);
    assert.equal(policyStatusText.includes('path_prefix'), false);
    assert.equal(status.trace_timing.available, true);
    assert.equal(status.trace_timing.recent.length, 1);
    assert.equal(status.trace_timing.recent[0].stream_id, 'stream-a');
    assert.equal(status.trace_timing.recent[0].request_id, 'request-a');
    assert.equal(status.trace_timing.recent[0].duration_ms, 700);
    assert.equal(status.trace_timing.recent[0].provider_timing.time_to_first_chunk_ms, 520);
    assert.deepEqual(status.trace_timing.recent[0].timing_spans[0], {
      from: 'created',
      to: 'provider_request_start',
      duration_ms: 80,
    });
    assert.equal(status.tool_observability.available, true);
    assert.equal(status.tool_observability.tools.read_file.count, 1);
    assert.equal(status.tool_observability.tools.read_file.error_codes['CMP-TOOL-0001'], 1);
    assert.equal(
      status.slow_operations.items.some((entry) => entry.kind === 'tool' && entry.id === 'read_file'),
      true
    );
    assert.equal(
      status.slow_operations.items.some((entry) => entry.kind === 'phase' && entry.id === 'provider_request_start_to_first_chunk'),
      true
    );
    assert.equal(status.logs.counts_by_level.ERROR, 1);
    assert.equal(status.logs.counts_by_level.WARN, 1);
    assert.deepEqual(
      status.logs.recent_issues.map((entry) => entry.event),
      ['tool.slow', 'tool.failed']
    );
    assert.equal(status.logs.error_distribution.by_event['tool.failed'], 1);
    assert.equal(status.logs.error_distribution.by_error_code['CMP-TOOL-0001'], 1);
    assert.equal(status.logs.error_distribution.by_category.tool, 1);
    const failedLog = status.logs.recent_issues.find((entry) => entry.event === 'tool.failed');
    assert.equal(failedLog.source.session_id, 'session-a');
    assert.equal(failedLog.source.stream_id, 'stream-a');
    assert.equal(failedLog.source.request_id, 'request-a');
    assert.equal(failedLog.source.trace_id, 'trace-a');
    assert.equal(failedLog.source.error_code, 'CMP-TOOL-0001');
    assert.equal(
      failedLog.source.diagnostic_ref.relative_path,
      'diagnostics/2026-05-07/stream-a.json'
    );
    assert.equal(status.usage.session.total_tokens, 30);
    assert.equal(status.usage.cumulative.provider_cost_usd, 0.0123);
    assert.equal(status.usage.cumulative.cost_coverage.provider_reported_turns, 1);
    assert.equal(status.usage.recent_turns.length, 1);
    assert.equal(status.usage.recent_turns[0].stream_id, 'stream-a');
    assert.equal(status.usage.recent_turns[0].request_id, 'request-a');
    assert.equal(status.usage.recent_turns[0].trace_id, 'trace-a');
    assert.equal(status.usage.recent_turns[0].provider, 'chatgpt');
    assert.equal(status.phase_percentiles.phases.provider_request_start_to_first_chunk.count, 1);
    assert.equal(
      status.schemas.items.some((entry) => entry.id === 'sidecar.memory_store'),
      true
    );
    assert.equal(status.budgets.status, 'warn');
    assert.equal(status.budgets.available, true);
    assert.deepEqual(status.budgets.inputs, {
      usage: true,
      resources: true,
      tool_observability: true,
      phase_percentiles: true,
      slow_operations: true,
    });
    assert.equal(status.budgets.percentiles.tools.read_file.p95, 3000);
    assert.equal(
      status.budgets.percentiles.phases.provider_request_start_to_first_chunk.p95,
      500
    );
    assert.equal(JSON.stringify(status).includes('private assistant text'), false);
    JSON.stringify(status);
  } finally {
    service.dispose();
  }
});

test('backend service Jenny status fails closed when optional facets throw', async () => {
  const userDataPath = createTrackedUserDataPath('jenny-status-fail-closed-');
  const service = new BackendService({
    userDataPath,
    safeStorage: createJennyStatusSafeStorage(),
    isSafeStorageReady: () => true,
    systemStatsProvider() {
      throw new Error('system stats unavailable');
    },
    usageHistory: {
      getSnapshot() {
        throw new Error('usage history unavailable');
      },
    },
    shellLogStore: {
      list() {
        throw new Error('logs unavailable');
      },
      getCurrentDiagnosticsMetadata: getEmptyDiagnosticsMetadata,
    },
  });
  service.inspectHarness = async () => {
    throw new Error('harness unavailable');
  };
  service.getBackendStatus = () => {
    throw new Error('backend status unavailable');
  };
  service._buildManagedStatusSnapshot = () => {
    throw new Error('runtime status unavailable');
  };
  service.getPhasePercentilesSnapshot = async () => {
    throw new Error('percentiles unavailable');
  };
  service.getToolObservabilitySnapshot = () => {
    throw new Error('tool observability unavailable');
  };

  try {
    const status = await service.getJennyStatus({ sessionId: 'session-a' });

    assert.equal(status.facade, 'jenny_status');
    assert.equal(status.backend.available, false);
    assert.match(status.backend.error, /backend status unavailable/);
    assert.equal(status.runtime.available, false);
    assert.match(status.runtime.error, /runtime status unavailable/);
    assert.equal(status.schemas.available, false);
    assert.equal(status.harness.available, false);
    assert.match(status.harness.error, /harness unavailable/);
    assert.equal(status.logs.available, false);
    assert.match(status.logs.error, /logs unavailable/);
    assert.equal(status.usage.available, false);
    assert.match(status.usage.error, /usage history unavailable/);
    assert.equal(status.phase_percentiles.available, false);
    assert.match(status.phase_percentiles.error, /percentiles unavailable/);
    assert.equal(status.tool_observability.available, false);
    assert.match(status.tool_observability.error, /tool observability unavailable/);
    assert.equal(status.resources.available, false);
    assert.match(status.resources.error, /system stats unavailable|harness unavailable/);
    assert.equal(status.automations.available, false);
    assert.match(status.automations.error, /Automation service is unavailable/);
    assert.equal(status.automations.total, 0);
    assert.deepEqual(status.automations.recent_failures, []);
    assert.equal(status.tool_policy.available, false);
    assert.match(status.tool_policy.error, /Tool permission store is unavailable/);
  } finally {
    service.dispose();
  }
});

test('backend service Jenny status redacts display-facing facet errors', async () => {
  const userDataPath = createTrackedUserDataPath('jenny-status-redaction-');
  const service = new BackendService({
    userDataPath,
    safeStorage: createJennyStatusSafeStorage(),
    isSafeStorageReady: () => true,
    shellLogStore: {
      list() {
        return [{
          level: 'ERROR',
          event: 'status.redaction_probe',
          details: {
            file: path.join(userDataPath, 'secure-state.json'),
            authorization: 'Bearer abcdefghijk',
            apiKey: 'sk-testsecret123456',
          },
        }];
      },
      getCurrentDiagnosticsMetadata: getEmptyDiagnosticsMetadata,
    },
    toolPermissionStore: {
      getSnapshot() {
        throw new Error(sensitiveMessage);
      },
    },
    automationService: {
      async getStatusSummary() {
        throw new Error(sensitiveMessage);
      },
    },
  });
  const sensitiveMessage =
    `failed at ${path.join(userDataPath, 'secure-state.json')} api_key=sk-testsecret123456 Bearer abcdefghijk`;
  service.getBackendStatus = () => {
    throw new Error(sensitiveMessage);
  };
  service.inspectHarness = async () => {
    throw new Error(sensitiveMessage);
  };

  try {
    const status = await service.getJennyStatus();

    assert.equal(status.backend.available, false);
    assert.equal(status.harness.available, false);
    assert.equal(status.automations.available, false);
    assert.equal(status.tool_policy.available, false);
    const exposed = JSON.stringify(status);
    assert.equal(exposed.includes(userDataPath), false);
    assert.equal(exposed.includes('sk-testsecret123456'), false);
    assert.equal(exposed.includes('abcdefghijk'), false);
    assert.match(status.backend.error, /failed at/);
    assert.match(status.backend.error, /api_key=\[redacted\]/);
    assert.match(status.backend.error, /Bearer \[redacted\]/);
    assert.match(status.automations.error, /failed at/);
    assert.match(status.automations.error, /api_key=\[redacted\]/);
    assert.match(status.automations.error, /Bearer \[redacted\]/);
    assert.match(status.tool_policy.error, /failed at/);
    assert.match(status.tool_policy.error, /api_key=\[redacted\]/);
    assert.match(status.tool_policy.error, /Bearer \[redacted\]/);
    assert.equal(status.logs.recent[0].details.file.includes(userDataPath), false);
    assert.equal(status.logs.recent[0].details.authorization, '[redacted]');
    assert.equal(status.logs.recent[0].details.apiKey, '[redacted]');
  } finally {
    service.dispose();
  }
});

test('backend service Jenny status bounds and allowlists automation facet payloads', async () => {
  const userDataPath = createTrackedUserDataPath('jenny-status-automation-malformed-');
  const sensitiveResultPath = path.join(userDataPath, 'automations', 'failed.json');
  const service = new BackendService({
    userDataPath,
    safeStorage: createJennyStatusSafeStorage(),
    isSafeStorageReady: () => true,
    automationService: {
      async getStatusSummary() {
        return {
          success: true,
          total: Infinity,
          enabled: -3,
          disabled: '2.9',
          running: 'not-a-number',
          completed_runs: '3.8',
          failed_runs: null,
          skipped_runs: -1,
          last_failure_at: sensitiveResultPath,
          last_failure: {
            automation_id: 'automation:malformed',
            task: 'malformed',
            run_id: 'run_last',
            status: 'failed',
            reason: 'api_key=sk-testsecret123456',
            started_at: '2026-05-20T10:00:00.000Z',
            completed_at: '2026-05-20T10:00:01.000Z',
            summary: `failed at ${sensitiveResultPath} Bearer abcdefghijk`,
            task_spec: 'Inspect private project notes',
            result_ref: sensitiveResultPath,
          },
          recent_failures: Array.from({ length: 12 }, (_entry, index) => ({
            automation_id: 'automation:malformed',
            task: 'malformed',
            run_id: `run_${String(index).padStart(2, '0')}`,
            status: 'failed',
            reason: 'rpc_failed',
            started_at: '2026-05-20T10:00:00.000Z',
            completed_at: '2026-05-20T10:00:01.000Z',
            summary: `failed at ${sensitiveResultPath} api_key=sk-testsecret123456`,
            task_spec: 'Inspect private project notes',
            result_ref: sensitiveResultPath,
            diagnostics: { file: sensitiveResultPath },
          })),
          recent_failure_count: 999,
          omitted_failure_count: 0,
          max_recent_failures: 999,
        };
      },
    },
  });

  try {
    const status = await service.getJennyStatus({ includeHarness: false });

    assert.equal(status.automations.available, true);
    assert.equal(status.automations.total, 0);
    assert.equal(status.automations.enabled, 0);
    assert.equal(status.automations.disabled, 2);
    assert.equal(status.automations.running, 0);
    assert.equal(status.automations.completed_runs, 3);
    assert.equal(status.automations.skipped_runs, 0);
    assert.equal(status.automations.recent_failures.length, 10);
    assert.equal(status.automations.recent_failure_count, 10);
    assert.equal(status.automations.omitted_failure_count, 2);
    assert.equal(status.automations.max_recent_failures, 10);
    assert.deepEqual(Object.keys(status.automations.recent_failures[0]).sort(), [
      'automation_id',
      'completed_at',
      'reason',
      'run_id',
      'started_at',
      'status',
      'summary',
      'task',
    ].sort());
    assert.match(status.automations.last_failure.reason, /api_key=\[redacted\]/);
    assert.match(status.automations.last_failure.summary, /Bearer \[redacted\]/);
    const exposed = JSON.stringify(status.automations);
    assert.equal(exposed.includes(userDataPath), false);
    assert.equal(exposed.includes('sk-testsecret123456'), false);
    assert.equal(exposed.includes('task_spec'), false);
    assert.equal(exposed.includes('result_ref'), false);
    assert.equal(exposed.includes('private project notes'), false);
    assert.equal(exposed.includes('failed.json'), false);
  } finally {
    service.dispose();
  }
});
