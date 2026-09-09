'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeManagedSidecar } = require('../services/backend/managed-sidecar-lifecycle');
const { registerCommandSandboxIpc } = require('../services/main/command-sandbox-ipc-registration');
function fixture(ack) {
 const process = {};
 const service = { currentEngineType: 'mock', currentModel: 'mock', options: { userDataPath: require('node:os').tmpdir() },
  configService: { getState: () => ({ commandSandbox: { enabled: true } }), getToolsWorkspaceRoot: () => '' },
  sidecarManager: { process }, sidecarClient: { process, connected: true, initialize: async () => ack } };
 return service;
}
test('desktop policy acknowledgement requires exact version and current process', async () => {
 for (const version of [undefined, null, true, '1', 2]) {
  const service = fixture({ desktop_execution_policy_version: version });
  await assert.rejects(initializeManagedSidecar(service, { applyResult: false }), /acknowledgement/);
  assert.equal(service._desktopPolicyProcess, null);
 }
 const service = fixture({ desktop_execution_policy_version: 1 });
 await initializeManagedSidecar(service, { applyResult: false });
 assert.equal(service._desktopPolicyProcess, service.sidecarManager.process);
 service.sidecarClient.initialize = async () => { service.sidecarManager.process = {}; return { desktop_execution_policy_version: 1 }; };
 await assert.rejects(initializeManagedSidecar(service, { applyResult: false }), /acknowledgement/);
});
test('lifecycle IPC authenticates sender and exposes no command channel', async () => {
 const handlers = new Map(); let changes = 0;
 registerCommandSandboxIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
  service: { getState: () => ({ state: 'disabled' }), setEnabled: () => { changes++; return { state: 'ready' }; }, retry: () => ({ state: 'ready' }) },
  authorization: { authorize: event => event.trusted === true },
 });
 assert.equal(handlers.size, 3);
 const change = handlers.get('command-sandbox:set-enabled');
 assert.equal((await change({}, { enabled: true })).authorized, false); assert.equal(changes, 0);
 assert.equal((await change({ trusted: true }, { enabled: true })).ok, true); assert.equal(changes, 1);
 assert.equal((await handlers.get('command-sandbox:retry')({ trusted: true }, { command: 'bad' })).ok, false);
});
