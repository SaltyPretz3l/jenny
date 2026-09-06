'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getJennyStatus } = require('../services/backend/jenny-status-composer');

test('Jenny status error distribution counts prototype-looking keys as data', async () => {
  const service = {
    getBackendStatus: () => ({ phase: 'ready', appVersion: '1.0.0-test' }),
    currentStatus: { engine: 'ollama', model: '', model_loaded: false, tools_status: {} },
    shellLogStore: {
      list: () => [{
        level: 'ERROR',
        event: '__proto__',
        details: { errorCode: 'constructor', category: 'toString' },
      }],
      getCurrentDiagnosticsMetadata: () => ({
        sources: {},
        integrity: { complete: true, partial_reasons: [] },
      }),
    },
    toolPermissionStore: {
      getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }),
    },
  };

  const distribution = (await getJennyStatus(service, { includeHarness: false }))
    .logs.error_distribution;
  assert.equal(Object.getPrototypeOf(distribution.by_event), null);
  assert.equal(Object.getPrototypeOf(distribution.by_error_code), null);
  assert.equal(Object.getPrototypeOf(distribution.by_category), null);
  assert.equal(distribution.by_event.__proto__, 1);
  assert.equal(distribution.by_error_code.constructor, 1);
  assert.equal(distribution.by_category.toString, 1);
});
