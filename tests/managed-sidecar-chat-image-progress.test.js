'use strict';

// A running image_generate reports its progress through the bridge as live-only
// tool_progress events on the turn's session and stream; a cancelled render
// reports nothing further.

const test = require('node:test');
const assert = require('node:assert/strict');

const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const { SIDECAR_ERROR_CODES } = require('../services/backend/error-codes');
const { buildManagedChatRequest, createManagedChatServiceStub } = require('./helpers/managed-sidecar-chat-lifecycle-helpers');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

test('image render progress reaches the chat stream with the turn identity until the render is cancelled', async () => {
  const service = createManagedChatServiceStub();
  const progress = [];
  const originalEmit = service.emit;
  service.emit = (eventName, payload) => {
    if (eventName === 'chat-stream' && payload?.type === 'tool_progress') progress.push(payload);
    return originalEmit.call(service, eventName, payload);
  };
  let reportAfterAbort = null;
  service.toolExecutor = {
    async executePreApproved({ toolName }, context) {
      assert.equal(toolName, 'image_generate');
      context.onProgress({ phase: 'load' });
      context.onProgress({ phase: 'sample', step: 2, steps: 20, preview: 'data:image/png;base64,QUFB' });
      await new Promise((resolve) => context.abortSignal.addEventListener('abort', resolve, { once: true }));
      reportAfterAbort = () => context.onProgress({ phase: 'decode' });
      reportAfterAbort();
      return { content: 'Image generation was cancelled.', isError: true, metadata: { error_code: 'image_cancelled' } };
    },
  };
  service.sidecarClient = {
    connected: true,
    async chatSend(params, options = {}) {
      void options.onElectronToolRequest({ request_id: params.request_id, session_id: params.session_id,
        tool_name: 'image_generate', tool_call_id: 'call_image_1', arguments: { prompt: 'a lighthouse' } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw Object.assign(new Error('Sidecar process exited (code=1 signal=none).'), {
        error_code: SIDECAR_ERROR_CODES.PROCESS_EXIT, category: 'process_exit', retryable: true,
      });
    },
  };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_image_progress', prompt: 'Draw a lighthouse',
  }));
  await service.activeStreams.get(stream.streamId)._pendingPromise;

  assert.ok(reportAfterAbort, 'the render was cancelled');
  assert.deepEqual(progress.map(({ type, sessionId, streamId, callId, toolName, phase, step, steps }) => ({
    type, sessionId, streamId, callId, toolName, phase, step, steps })), [
    { type: 'tool_progress', sessionId: 'session_image_progress', streamId: stream.streamId, callId: 'call_image_1',
      toolName: 'image_generate', phase: 'load', step: undefined, steps: undefined },
    { type: 'tool_progress', sessionId: 'session_image_progress', streamId: stream.streamId, callId: 'call_image_1',
      toolName: 'image_generate', phase: 'sample', step: 2, steps: 20 },
  ]);
  assert.equal(progress[1].preview, 'data:image/png;base64,QUFB');
});
