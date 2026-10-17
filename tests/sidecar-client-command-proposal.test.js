'use strict';

/* command.execute_proposal at the sidecar client (row 59 checkpoint 3, Batch B):
 * the four reverse-RPC handler maps are keyed by request_id exactly like chat.send,
 * abort and transport timeout send the ordinary chat.cancel (no separate cancel
 * method), and the method has its own 360 s request timeout. */

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { SidecarClient } = require('../services/backend/sidecar-client');
const { commandExecuteProposal, COMMAND_EXECUTE_PROPOSAL_METHOD } = require('../services/backend/sidecar-client-command-proposal');
const { isChatTurnMethod } = require('../services/backend/sidecar-client-request-timeout');
const { resolveRequestTimeoutMs } = require('../services/backend/sidecar-request-timeouts');

const HANDLER_MAPS = ['notificationHandlers', 'approvalHandlers', 'electronToolHandlers', 'runtimeOperationHandlers'];

function createClient(t) {
  const client = new SidecarClient();
  const frames = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.write = (frame, callback) => {
    const text = Buffer.from(frame).toString('utf8');
    frames.push(JSON.parse(text.slice(text.indexOf('\r\n\r\n') + 4)));
    if (typeof callback === 'function') callback();
    return true;
  };
  client.attachProcess(child);
  t.after(() => client.dispose());
  return { client, frames };
}

const handlers = () => ({
  onNotification: () => {},
  onApprovalRequest: () => true,
  onElectronToolRequest: () => ({ output: 'ok' }),
  onRuntimeOperation: () => ({ status: 'granted' }),
});

test('the method is a chat turn method with its own 360 s timeout', () => {
  assert.equal(COMMAND_EXECUTE_PROPOSAL_METHOD, 'command.execute_proposal');
  assert.equal(isChatTurnMethod('chat.send'), true);
  assert.equal(isChatTurnMethod(COMMAND_EXECUTE_PROPOSAL_METHOD), true);
  assert.equal(isChatTurnMethod('models.list'), false);
  assert.equal(resolveRequestTimeoutMs(COMMAND_EXECUTE_PROPOSAL_METHOD), 360_000);
  assert.equal(resolveRequestTimeoutMs('chat.send'), 360_000);
});

test('registers the four handler maps by request_id, sends the method, and retires them on the result', async (t) => {
  const { client, frames } = createClient(t);
  const before = HANDLER_MAPS.map((name) => [...client[name]]);
  const pending = commandExecuteProposal(client, { request_id: 'req_cmd_1', accept_version: '2026-10-15', schema_version: 1 },
    { ...handlers(), timeoutMs: null });
  for (const name of HANDLER_MAPS) {
    assert.equal(typeof client[name].get('req_cmd_1'), 'function', `${name} is registered for the request`);
  }
  assert.equal(frames.length, 1);
  assert.equal(frames[0].method, COMMAND_EXECUTE_PROPOSAL_METHOD);
  assert.equal(frames[0].params.request_id, 'req_cmd_1');
  assert.equal(frames[0].params.schema_version, 1);
  const pendingRequest = [...client.pendingRequests.values()][0];
  assert.equal(pendingRequest.requestKey, 'req_cmd_1');
  client._handleMessage({ jsonrpc: '2.0', id: frames[0].id, result: { status: 'completed' } });
  assert.deepEqual(await pending, { status: 'completed' });
  assert.equal(client.pendingRequests.size, 0);
  HANDLER_MAPS.forEach((name, index) => assert.deepEqual([...client[name]], before[index], `${name} is retired`));
});

test('an unavailable callback registers an inert handler object, like chatSend', async (t) => {
  const { client, frames } = createClient(t);
  const pending = commandExecuteProposal(client, { request_id: 'req_cmd_2' }, { timeoutMs: null });
  assert.deepEqual(client.electronToolHandlers.get('req_cmd_2'), {});
  assert.deepEqual(client.runtimeOperationHandlers.get('req_cmd_2'), {});
  client._handleMessage({ jsonrpc: '2.0', id: frames[0].id, result: {} });
  await pending;
  assert.equal(client.electronToolHandlers.has('req_cmd_2'), false);
});

test('an empty request_id is refused before any frame is written', async (t) => {
  const { client, frames } = createClient(t);
  await assert.rejects(commandExecuteProposal(client, { request_id: '  ' }, handlers()), /requires a non-empty request_id/);
  await assert.rejects(commandExecuteProposal(client, null, handlers()), /requires a non-empty request_id/);
  assert.equal(frames.length, 0);
});

test('abort sends chat.cancel for the command request and retires every handler', async (t) => {
  const { client, frames } = createClient(t);
  const controller = new AbortController();
  const pending = commandExecuteProposal(client, { request_id: 'req_cmd_3', trace_id: 'trace_cmd_3', session_id: 'sess_1' },
    { ...handlers(), signal: controller.signal, timeoutMs: null, drainMs: 0 });
  pending.catch(() => {});
  controller.abort();
  await assert.rejects(pending, (error) => error.category === 'cancelled' && error.error_code === 'CMP-SIDECAR-0002'
    && error.cancelReason === 'user_cancel');
  assert.equal(frames.length, 2);
  assert.equal(frames[1].method, 'chat.cancel');
  assert.equal(frames[1].params.request_id, 'req_cmd_3');
  assert.equal(frames[1].params.session_id, 'sess_1');
  assert.equal(client.pendingRequests.size, 0);
  for (const name of HANDLER_MAPS) assert.equal(client[name].has('req_cmd_3'), false);
});

test('a transport timeout also sends chat.cancel so the sidecar stops the command', async (t) => {
  const { client, frames } = createClient(t);
  const keepAlive = setInterval(() => {}, 1000); // the transport timer is unref'd
  t.after(() => clearInterval(keepAlive));
  const pending = commandExecuteProposal(client, { request_id: 'req_cmd_4', session_id: 'sess_1' },
    { ...handlers(), timeoutMs: 20 });
  await assert.rejects(pending, /command\.execute_proposal timed out after 20ms/);
  assert.equal(frames.at(-1).method, 'chat.cancel');
  assert.equal(frames.at(-1).params.request_id, 'req_cmd_4');
});

test('the method default timeout is armed when the caller supplies none', async (t) => {
  const { client, frames } = createClient(t);
  const pending = commandExecuteProposal(client, { request_id: 'req_cmd_5' }, handlers());
  const pendingRequest = [...client.pendingRequests.values()][0];
  assert.equal(pendingRequest.timeoutMs, 360_000);
  client._handleMessage({ jsonrpc: '2.0', id: frames[0].id, result: {} });
  await pending;
});

test('an answer that arrives during the cancel drain resolves with the sidecar outcome', async (t) => {
  const { client, frames } = createClient(t);
  const controller = new AbortController();
  const pending = commandExecuteProposal(client, { request_id: 'req_cmd_6', trace_id: 'trace_cmd_6', session_id: 'sess_1' },
    { ...handlers(), signal: controller.signal, timeoutMs: null, drainMs: 5_000 });
  controller.abort();
  assert.equal(frames.length, 2, 'chat.cancel goes out at once');
  assert.equal(frames[1].method, 'chat.cancel');
  assert.equal(frames[1].params.request_id, 'req_cmd_6');
  assert.equal(client.pendingRequests.size, 1, 'the request stays open for the drain');
  assert.equal(client._isCancelledRequestKey('req_cmd_6'), true, 'a late approval request is refused');
  const answer = { status: 'cancelled', command_outcome: { schema_version: 1, status: 'cancelled', exit_code: null, cleanup: 'confirmed' } };
  client._handleMessage({ jsonrpc: '2.0', id: frames[0].id, result: answer });
  assert.deepEqual(await pending, answer);
  assert.equal(frames.length, 2, 'no second chat.cancel');
  for (const name of HANDLER_MAPS) assert.equal(client[name].has('req_cmd_6'), false);
});

test('a sidecar that never answers is rejected as an abort once the drain runs out', async (t) => {
  const { client, frames } = createClient(t);
  const controller = new AbortController();
  const pending = commandExecuteProposal(client, { request_id: 'req_cmd_7', session_id: 'sess_1' },
    { ...handlers(), signal: controller.signal, timeoutMs: null, drainMs: 20 });
  pending.catch(() => {});
  controller.abort();
  await assert.rejects(pending, (error) => error.category === 'cancelled');
  assert.equal(frames.filter((frame) => frame.method === 'chat.cancel').length, 1);
  assert.equal(client.pendingRequests.size, 0);
});
