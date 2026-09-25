'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { BackendService } = require('../../services/backend/backend-service');
const { ShellConfigService } = require('../../services/shell-config-service');
const { ToolPermissionStore } = require('../../services/tools/tool-permission-store');
const { createConversationToolExecutor } = require('../../services/host/conversation-tool-executor');
const { createFakeSafeStorage } = require('./fake-safe-storage');
const { filesystemResource } = require('../../services/session-runtime/resource-broker');
const protocol = require('../../services/session-runtime/inference-protocol');
const ROOT = path.resolve(__dirname, '../..');
const PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
async function waitFor(predicate, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Desktop decision fixture timed out');
}
function createBackend(profile, workspace, seen, logs, kind, launchArgs) {
  const configService = new ShellConfigService({ userDataPath: profile });
  configService.setToolsWorkspaceRoot(workspace);
  const permissions = new ToolPermissionStore(path.join(profile, 'tool-permissions.json'));
  if (kind === 'approval') permissions.setPolicy('read_file', 'ask');
  const backend = new BackendService({ userDataPath: profile, repoRoot: ROOT, pythonExecutable: PYTHON, launchArgs,
    defaultModel: 'replay-model', preferredEngineType: 'replay', configService,
    safeStorage: createFakeSafeStorage(), toolPermissionStore: permissions,
    toolExecutor: createConversationToolExecutor({ configService, permissionStore: permissions,
      logger: (level, event, data) => logs.push({ level, event, data }) }),
    featureFlags: { session_runtime: true, multiplexer: true, chat_cancel: true,
      canonical_turn_events: false, canonical_bridge: false, phase_events: true } });
  if (launchArgs) backend.toolExecutor.registry = require('../../services/tools').createDefaultRegistry();
  // Inspect the real initialize result without injecting protocol support.
  const initialize = backend._initializeManagedSidecar.bind(backend);
  backend._initializeManagedSidecar = async (...args) => {
    const result = await initialize(...args);
    assert.ok(result.mcp_servers_connected?.includes('jenny_local_tools'), JSON.stringify(result.mcp_servers_failed));
    assert.ok(['list_dir', 'read_file', 'ask_user'].every(name => result.tools_available?.includes(name)), JSON.stringify(result.tools_available));
    assert.equal(result.runtime_continuation_version, 1);
    assert.equal(protocol.assertRuntimeContinuationProtocol(backend.sidecarClient), true);
    return result;
  };
  backend.on('chat-stream', event => seen.push(event));
  backend.on('service-log', event => logs.push(event));
  return backend;
}

function holdAtAdmission(runtime, workspace, target) {
  const acquire = runtime.resourceBroker.tryAcquire.bind(runtime.resourceBroker);
  let admissions = 0; let held;
  runtime.resourceBroker.tryAcquire = request => {
    if (++admissions === target) {
      const result = acquire({ ownerId: 'fixture-held-file', resources: [
        filesystemResource(runtime.pathResolver.resolve(path.join(workspace, 'blocked.txt')))] });
      assert.equal(result.status, 'granted'); held = result.lease;
    }
    return acquire(request);
  };
  return () => runtime.resourceBroker.release(held, { producerSettled: true });
}

module.exports = { ROOT, waitFor, createBackend, holdAtAdmission };
