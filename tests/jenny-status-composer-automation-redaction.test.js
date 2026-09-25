'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getJennyStatus } = require('../services/backend/jenny-status-composer');

// Lives beside tests/jenny-status-composer.test.js, which is at the file-size
// cap. The prefix redaction leaves the relative tail behind [redacted:path];
// collapsing that tail used to stop at the first space and leak the rest.
const USER_DATA_PATH = String.raw`C:\Users\example`;
const SUMMARY_CASES = [
  [String.raw`Sidecar failed at ${USER_DATA_PATH}\AI Tools\My Models\model.gguf ENOENT`, 'Sidecar failed at [redacted] ENOENT'],
  [String.raw`Could not load ${USER_DATA_PATH}\AI Tools\My Models\My Model Q4.gguf, retrying`, 'Could not load [redacted], retrying'],
  [String.raw`Model folder ${USER_DATA_PATH}\GGUF Models\Local GGUF`, 'Model folder [redacted]'],
  [String.raw`spawn ${USER_DATA_PATH}\AI Tools\llama-server.exe ENOENT and/or EACCES`, 'spawn [redacted] ENOENT and/or EACCES'],
  [String.raw`read token: ${USER_DATA_PATH}\My Keys\key.pem`, 'read token: [redacted]'],
  [String.raw`copy to ${USER_DATA_PATH}-backup\Secret Folder\file.txt failed`, 'copy to [redacted] failed'],
];

function makeServiceWithFailures(recentFailures) {
  return {
    options: { userDataPath: USER_DATA_PATH },
    getBackendStatus: () => ({ phase: 'ready', appVersion: '1.0.0-test' }),
    currentStatus: { engine: 'ollama', model: '', model_loaded: false, tools_status: {} },
    shellLogStore: {
      list: () => [],
      getCurrentDiagnosticsMetadata: () => ({
        sources: {},
        integrity: { complete: true, partial_reasons: [] },
      }),
    },
    toolPermissionStore: {
      getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }),
    },
    automationService: {
      async getStatusSummary() {
        return {
          success: true,
          total: 1,
          failed_runs: recentFailures.length,
          last_failure: null,
          recent_failures: recentFailures,
          omitted_failure_count: 0,
        };
      },
    },
  };
}

test('automation facet collapses known-prefix path tails with spaces', async () => {
  const service = makeServiceWithFailures(SUMMARY_CASES.map(([summary], index) => ({
    automation_id: 'automation:nightly',
    task: 'nightly',
    run_id: `run-${index}`,
    status: 'failed',
    summary,
  })));

  const status = await getJennyStatus(service, { includeHarness: false });

  assert.equal(status.automations.available, true);
  assert.deepEqual(
    status.automations.recent_failures.map((entry) => entry.summary),
    SUMMARY_CASES.map(([, expected]) => expected)
  );
});
