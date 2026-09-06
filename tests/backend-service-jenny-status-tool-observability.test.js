'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const { createTrackedUserDataPath } = require('./helpers/turn-diagnostic-fixtures');

function createJennyStatusSafeStorage() {
  return {
    ...createFakeSafeStorage(),
    getSelectedStorageBackend: () => 'dpapi',
  };
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('backend service Jenny status rejects malformed tool observability snapshots', async () => {
  const userDataPath = createTrackedUserDataPath('jenny-status-malformed-tool-observability-');
  const service = new BackendService({
    userDataPath,
    safeStorage: createJennyStatusSafeStorage(),
    isSafeStorageReady: () => true,
  });
  service.getToolObservabilitySnapshot = () => 'not-an-object';

  try {
    const status = await service.getJennyStatus({ includeHarness: false });

    assert.equal(status.tool_observability.available, false);
    assert.match(status.tool_observability.error, /malformed/i);
    assert.equal(status.tool_observability.open_call_count, 0);
    assert.deepEqual(status.tool_observability.tools, {});
  } finally {
    service.dispose();
  }
});
