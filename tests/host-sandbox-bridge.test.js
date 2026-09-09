'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  executeElectronToolRequest,
} = require('../services/backend/electron-tool-bridge');
const { drainHostedExecution, settleHostedExecution } = require('../services/backend/hosted-execution-settlement');

function hostedService(broker) {
  return {
    hostMode: 'server',
    options: { hostExecutionPolicyVersion: 2, hostExecutionBroker: broker },
    toolExecutor: {
      async executePreApproved() {
        throw new Error('hosted run_command must not use the sidecar tool executor');
      },
    },
  };
}

test('hosted run_command uses the injected worker broker and foreground contract', async () => {
  let observed = null;
  const broker = {
    status: () => ({ available: true }),
    async execute(input, context) {
      observed = { input, context };
      return {
        status: 'completed',
        exit_code: 0,
        stdout: 'ok',
        stderr: '',
        success: true,
        cleanup_confirmed: true,
        workspace: 'disposable_copy',
      };
    },
  };
  const result = await executeElectronToolRequest(hostedService(broker), {
    params: {
      tool_name: 'run_command', plan_mode: false, read_only: false,
      arguments: { command: 'printf ok', cwd: 'src', timeout_seconds: 5 },
      request_id: 'stream-1',
    },
    sessionId: 'session-1',
    streamId: 'stream-1',
  });

  assert.equal(result.success, true);
  assert.equal(result.output, 'ok');
  assert.deepEqual(observed.input, {
    command: 'printf ok', cwd: 'src', timeoutSeconds: 5, expectedExitCodes: [0],
  });
  assert.deepEqual(observed.context, {
    sessionId: 'session-1', streamId: 'stream-1', signal: null,
  });
});

test('hosted run_command rejects background and malformed cwd arguments', async () => {
  const broker = { status: () => ({ available: true }), execute: async () => {
    throw new Error('must not execute malformed arguments');
  } };
  for (const arguments_ of [
    { command: 'sleep 1', run_in_background: true },
    { command: 'pwd', cwd: '../outside' },
  ]) {
    const result = await executeElectronToolRequest(hostedService(broker), {
      params: { tool_name: 'run_command', plan_mode: false, read_only: false, arguments: arguments_, request_id: 'stream-1' },
      sessionId: 'session-1', streamId: 'stream-1',
    });
    assert.equal(result.success, false);
  }
});

test('hosted execution settlement waits for the broker cleanup barrier', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const broker = { drainStream: async () => pending };
  let settled = false;
  const draining = drainHostedExecution({
    hostMode: 'server',
    options: { hostExecutionPolicyVersion: 2, hostExecutionBroker: broker },
  }, 'stream-1').then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  await draining;
  assert.equal(settled, true);
});



test('hosted reverse bridge rejects read-only, plan mode and missing mode declarations', async () => {
  const broker = { status: () => ({ available: true }), execute: async () => { throw new Error('must not run'); } };
  for (const flags of [{}, { plan_mode: true, read_only: false }, { plan_mode: false, read_only: true }]) {
    const result = await executeElectronToolRequest(hostedService(broker), {
      params: { tool_name: 'run_command', arguments: { command: 'echo no' }, ...flags },
      sessionId: 's', streamId: 't',
    });
    assert.equal(result.success, false);
    assert.match(result.output, /read-only or plan mode/);
  }
});


test('unconfirmed cleanup prevents success and replaces optimistic cancellation', async () => {
  const service = hostedService({ drainStream: async () => {
    throw Object.assign(new Error('unconfirmed'), { reason: 'sandbox_cleanup_unconfirmed' });
  } });
  await assert.rejects(settleHostedExecution(service, 'stream-1'), (error) => error.execution_uncertain === true);
  const payload = { status: 'cancelled', retryable: true, cancel_reason: 'user' };
  await settleHostedExecution(service, 'stream-1', payload);
  assert.equal(payload.status, 'runtime_error');
  assert.equal(payload.terminal_subcode, 'execution_uncertain');
  assert.equal(payload.retryable, false);
  assert.equal(payload.cancel_reason, '');
});
