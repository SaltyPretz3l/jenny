const test = require('node:test');
const assert = require('node:assert/strict');

const { stopManagedServerOrAbort } = require('../services/backend/ninfer-load-path');

function fakeManager() {
  const calls = [];
  return { calls, stop: async (options) => { calls.push(options); return { state: 'stopped', lastError: '' }; } };
}

test('an engine switch names itself on the managed-server stop; an unload does not', async () => {
  const service = { _emitServiceLog() {} };
  const switching = fakeManager();
  await stopManagedServerOrAbort(service, switching, 'ninfer', 'ollama');
  assert.deepEqual(switching.calls, [{ stoppedBy: 'engine_switch' }]);
  const unloading = fakeManager();
  await stopManagedServerOrAbort(service, unloading, 'ninfer', 'unload');
  assert.deepEqual(unloading.calls, [{}]);
});
