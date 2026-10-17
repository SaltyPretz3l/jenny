'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('non-resumable command start gate is bound to the application-selected call', async t => {
  const commandBridge = require('../services/execution/command-bridge');
  const bridgePath = require.resolve('../services/backend/electron-tool-bridge');
  const priorModule = require.cache[bridgePath];
  const priorExecute = commandBridge.executeSandboxCommand;
  let executions = 0;
  commandBridge.executeSandboxCommand = async (_service, { beforeProducer }) => {
    await beforeProducer();
    executions++;
    return { success: true, output: 'done' };
  };
  delete require.cache[bridgePath];
  t.after(() => {
    commandBridge.executeSandboxCommand = priorExecute;
    if (priorModule) require.cache[bridgePath] = priorModule;
    else delete require.cache[bridgePath];
  });
  const { buildManagedSidecarChatSendOptions } = require(bridgePath);
  function options(callId) {
    return buildManagedSidecarChatSendOptions({
      service: { commandSandbox: { enabled: true } }, controller: new AbortController(),
      streamId: 'stream', requestId: 'stream', resolvedSessionId: 'session',
      runtime: { handleNotification() {} }, toolContext: {}, normalizedPreferences: { plan_mode: false },
      commandResourceStartToolCallId: callId,
    });
  }
  const params = { tool_name: 'run_command', tool_call_id: 'exact_call', request_id: 'stream',
    session_id: 'session', arguments: { command: 'echo exact' }, plan_mode: false, read_only: false,
    runtime_resource_gate: { schema_version: 1, phase: 'prepare' } };
  for (const [callId, changed] of [
    [null, {}], ['other_call', {}], ['exact_call', { tool_name: 'jenny_status' }],
    ['exact_call', { request_id: 'other' }], ['exact_call', { session_id: 'other' }],
  ]) {
    await assert.rejects(options(callId).onElectronToolRequest({ ...params, ...changed }),
      /runtime_electron_start_invalid/);
  }
  assert.equal(executions, 0);
  const exact = options('exact_call');
  const ready = (await exact.onElectronToolRequest(params)).runtime_resource_ready;
  assert.equal(executions, 0);
  const start = { ...params, runtime_resource_gate: {
    schema_version: 1, phase: 'start', token: ready.token,
  } };
  assert.equal((await exact.onElectronToolRequest(start)).success, true);
  assert.equal(executions, 1);
  await assert.rejects(exact.onElectronToolRequest(start), /runtime_electron_start_invalid/);
  assert.equal(executions, 1);
});
