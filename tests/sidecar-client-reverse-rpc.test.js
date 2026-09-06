'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');

const { SidecarClient } = require('../services/backend/sidecar-client');

function recordingProcess() {
  const writes = [];
  const proc = new EventEmitter();
  proc.stdout = new Readable({ read() {} });
  proc.stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk));
      callback();
    },
  });
  return { proc, writes };
}

function decode(chunk) {
  return JSON.parse(chunk.toString('utf8').split('\r\n\r\n')[1]);
}

test('approval denial is written in finally without an error listener', async () => {
  const client = new SidecarClient();
  const { proc, writes } = recordingProcess();
  client.attachProcess(proc);
  client.approvalHandlers.set('req_approval_no_listener', () => {
    throw new Error('private approval failure');
  });

  await client._handleApprovalRequest({
    jsonrpc: '2.0', id: 10000011, method: 'tool.request_approval',
    params: { request_id: 'req_approval_no_listener', tool_call_id: 'call_x', tool_name: 'Write' },
  });

  assert.equal(writes.length, 1);
  assert.deepEqual(decode(writes[0]).result, { approved: false });
});

test('oversized electron tool result becomes one bounded bridge error response', async () => {
  const logs = [];
  const client = new SidecarClient({
    logger: (level, event, fields) => logs.push({ level, event, fields }),
  });
  const { proc, writes } = recordingProcess();
  client.attachProcess(proc);
  client.electronToolHandlers.set('req_bridge_oversized', () => ({
    output: 's'.repeat(10 * 1024 * 1024 + 16),
  }));

  await client._handleElectronToolExecuteRequest({
    jsonrpc: '2.0', id: 10000013, method: 'tool.execute_electron',
    params: { request_id: 'req_bridge_oversized', tool_name: 'future_tool', tool_call_id: 'call_big' },
  });

  assert.equal(writes.length, 1);
  const response = decode(writes[0]);
  assert.equal(response.error.data.reason, 'response_too_large');
  assert.equal(response.error.data.code, 'CMP-TOOL-0008');
  assert.equal(JSON.stringify(response).includes('s'.repeat(1000)), false);
  assert.equal(logs.some((entry) => entry.event === 'sidecar.electron_tool_response_too_large'), true);
});

test('oversized electron tool failure becomes one bounded redacted bridge error response', async () => {
  const client = new SidecarClient();
  const { proc, writes } = recordingProcess();
  client.attachProcess(proc);
  client.electronToolHandlers.set('req_bridge_error', () => {
    throw new Error(`token=ghp_abcdefghijklmnop ${'x'.repeat(10 * 1024 * 1024)}`);
  });

  await client._handleElectronToolExecuteRequest({
    jsonrpc: '2.0', id: 10000014, method: 'tool.execute_electron',
    params: { request_id: 'req_bridge_error', tool_name: 'future_tool', tool_call_id: 'call_error' },
  });

  assert.equal(writes.length, 1);
  const response = decode(writes[0]);
  assert.equal(response.error.data.code, 'CMP-TOOL-0008');
  assert.match(response.error.message, /\[redacted\]/);
  assert.equal(response.error.message.includes('ghp_abcdefghijklmnop'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(response), 'utf8') < 10 * 1024 * 1024);
});

test('plugin host reverse request uses the request-scoped fixed handler', async () => {
  const client = new SidecarClient();
  const { proc, writes } = recordingProcess();
  client.attachProcess(proc);
  client.pluginHostHandlers.set('req_plugin_host', async (params) => ({ ok: true, operation: params.operation }));
  await client._handlePluginHostRequest({
    jsonrpc: '2.0', id: 10000015, method: 'plugin.host',
    params: { request_id: 'req_plugin_host', operation: 'start' },
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(decode(writes[0]).result, { ok: true, operation: 'start' });
});
