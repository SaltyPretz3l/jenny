'use strict';

// A15-F2: a sidecar that exits while image_generate is rendering rejects the
// chat request; the render it started must be cancelled and settled before the
// failed terminal, and a publication that raced the loss keeps its receipt.

const test = require('node:test');
const assert = require('node:assert/strict');

const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const { SIDECAR_ERROR_CODES } = require('../services/backend/error-codes');
const { buildManagedChatRequest, createManagedChatServiceStub } = require('./helpers/managed-sidecar-chat-lifecycle-helpers');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

function processExit() {
  return Object.assign(new Error('Sidecar process exited (code=1 signal=none).'), {
    error_code: SIDECAR_ERROR_CODES.PROCESS_EXIT, category: 'process_exit', retryable: true,
  });
}

// The fake sidecar starts an image render over the reverse bridge, then exits.
function exitingSidecar(service, order) {
  let bridgeResponse = null;
  service.sidecarClient = {
    connected: true,
    async chatSend(params, options = {}) {
      bridgeResponse = Promise.resolve(options.onElectronToolRequest({
        request_id: params.request_id, session_id: params.session_id, tool_name: 'image_generate',
        tool_call_id: 'call_image_1', arguments: { prompt: 'a lighthouse' },
      }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('sidecar_exit');
      throw processExit();
    },
  };
  return { response: () => bridgeResponse };
}

test('a sidecar exit mid-render aborts the image tool and awaits its cleanup before the failed terminal', async () => {
  const service = createManagedChatServiceStub();
  const order = [];
  let renderSignal = null;
  let published = false;
  service.toolExecutor = {
    async executePreApproved({ toolName }, context) {
      assert.equal(toolName, 'image_generate');
      renderSignal = context.abortSignal;
      // The render runs until it is cancelled; the deadline stands in for a finished picture.
      const cancelled = await new Promise((resolve) => {
        const deadline = setTimeout(() => resolve(false), 1500);
        context.abortSignal.addEventListener('abort', () => { clearTimeout(deadline); resolve(true); }, { once: true });
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('render_settled');
      if (!cancelled) published = true;
      return cancelled
        ? { content: 'Image generation was cancelled.', isError: true, metadata: { error_code: 'image_cancelled' } }
        : { content: 'Generated.', isError: false, metadata: {} };
    },
  };
  exitingSidecar(service, order);
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_image_bridge_exit', prompt: 'Draw a lighthouse',
  }));
  const controller = service.activeStreams.get(stream.streamId);
  const originalEmit = service.emit;
  service.emit = (eventName, payload) => {
    originalEmit(eventName, payload);
    if (eventName === 'chat-stream' && ['error', 'done'].includes(payload?.type)) order.push('terminal');
  };
  await controller._pendingPromise;

  assert.ok(renderSignal, 'the render started');
  assert.equal(renderSignal.aborted, true, 'losing the sidecar cancels the render');
  assert.equal(published, false, 'no artifact is published for the failed turn');
  assert.deepEqual(order, ['sidecar_exit', 'render_settled', 'terminal'],
    'the render settles before terminal teardown');
});

test('a render that published as the sidecar exited still records its tool result', async () => {
  const service = createManagedChatServiceStub();
  const order = [];
  service.toolExecutor = {
    async executePreApproved(_call, context) {
      // Publication was already underway: the abort arrives too late to stop it.
      await new Promise((resolve) => setTimeout(resolve, 40));
      order.push(context.abortSignal.aborted ? 'published_after_abort' : 'published');
      return { content: 'Generated a 2x2 image.', isError: false, metadata: {
        generatedArtifacts: [{ artifact_id: 'art_image_1', artifact_kind: 'image', title: 'lighthouse',
          file_name: 'lighthouse.png', display_path: 'artifacts/lighthouse.png' }] } };
    },
  };
  exitingSidecar(service, order);
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_image_bridge_receipt', prompt: 'Draw a lighthouse',
  }));
  await service.activeStreams.get(stream.streamId)._pendingPromise;

  assert.deepEqual(order, ['sidecar_exit', 'published_after_abort']);
  const receipt = service.sessionMessages.find((message) => message?.tool_result?.call_id === 'call_image_1');
  assert.ok(receipt, 'the tool result is persisted');
  assert.equal(receipt.tool_result.is_error, false);
  assert.deepEqual(receipt.tool_result.generated_artifacts.map((entry) => entry.artifact_id), ['art_image_1'],
    'the published image keeps its conversation receipt');
});

// The real transport: a SidecarClient attached to a recording process.
const { EventEmitter } = require('node:events');
const { Readable, Writable } = require('node:stream');
const { SidecarClient } = require('../services/backend/sidecar-client');
const { encodeFrame } = require('../services/backend/sidecar-client-transport-codec');

async function until(read) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never held');
}

async function publishThenLoseTransport({ notify }) {
  const service = createManagedChatServiceStub();
  const writes = [];
  const proc = new EventEmitter();
  proc.stdout = new Readable({ read() {} });
  proc.stdin = new Writable({ write(chunk, _encoding, done) { writes.push(Buffer.from(chunk)); done(); } });
  const frames = () => writes.map((chunk) => JSON.parse(chunk.toString('utf8').split('\r\n\r\n')[1]));
  const client = new SidecarClient();
  client.attachProcess(proc);
  service.sidecarClient = client;
  const order = [];
  service.toolExecutor = {
    async executePreApproved() {
      order.push('artifact_published');
      return { content: 'Generated a 2x2 image.', isError: false, metadata: {
        generatedArtifacts: [{ artifact_id: 'art_image_race', artifact_kind: 'image', title: 'lighthouse',
          file_name: 'lighthouse.png', display_path: 'artifacts/lighthouse.png' }] } };
    },
  };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: `session_image_receipt_${notify ? 'notified' : 'lost'}`, prompt: 'Draw a lighthouse',
  }));
  const send = await until(() => frames().find((message) => message.method === 'chat.send'));
  const { request_id: requestId, session_id: sessionId } = send.params;
  const call = { request_id: requestId, session_id: sessionId, tool_name: 'image_generate',
    tool_call_id: 'call_image_race', arguments: { prompt: 'a lighthouse' } };
  proc.stdout.push(encodeFrame({ jsonrpc: '2.0', id: 9001, method: 'tool.execute_electron', params: call }).frame);
  const reply = await until(() => frames().find((message) => message.id === 9001));
  order.push('bridge_reply_written');
  if (notify) {
    proc.stdout.push(encodeFrame({ jsonrpc: '2.0', method: 'tool.result', params: {
      ...reply.result, request_id: requestId, tool_call_id: call.tool_call_id, tool_input: call.arguments } }).frame);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  order.push('process_exit');
  proc.emit('exit', 1, null);
  await service.activeStreams.get(stream.streamId)?._pendingPromise;
  return { order, receipts: service.sessionMessages.filter((message) => message?.tool_result?.call_id === 'call_image_race') };
}

test('a publication whose bridge reply was written but whose tool.result never arrived keeps exactly one receipt', async () => {
  const { order, receipts } = await publishThenLoseTransport({ notify: false });
  assert.deepEqual(order, ['artifact_published', 'bridge_reply_written', 'process_exit']);
  assert.equal(receipts.length, 1, 'the published image keeps its conversation receipt');
  assert.deepEqual(receipts[0].tool_result.generated_artifacts.map((entry) => entry.artifact_id), ['art_image_race']);
});

test('a publication whose tool.result did arrive before the transport was lost keeps exactly one receipt', async () => {
  const { order, receipts } = await publishThenLoseTransport({ notify: true });
  assert.deepEqual(order, ['artifact_published', 'bridge_reply_written', 'process_exit']);
  assert.equal(receipts.length, 1, 'the normal notification and the loss path never both persist');
});
