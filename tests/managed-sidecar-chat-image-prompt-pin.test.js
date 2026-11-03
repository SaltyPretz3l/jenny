'use strict';

// Row 91: a /image turn persists its pin on the user row, tells the model the
// prompt is fixed, hands the tool the stored text (not the model's) and draws once.

const test = require('node:test');
const assert = require('node:assert/strict');

const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const { buildManagedChatRequest, createManagedChatServiceStub } = require('./helpers/managed-sidecar-chat-lifecycle-helpers');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

test('a pinned turn draws the stored user text once and refuses a second render', async () => {
  const service = createManagedChatServiceStub();
  const pins = [];
  service.toolExecutor = {
    async executePreApproved({ toolName, input }, context) {
      assert.equal(toolName, 'image_generate');
      pins.push({ pin: context.imagePromptPin, modelPrompt: input.prompt });
      return { content: 'Generated', isError: false, metadata: { result_kind: 'image_generated' } };
    },
  };
  let sentUserContent = '';
  const results = [];
  service.sidecarClient = {
    connected: true,
    async chatSend(params, options = {}) {
      sentUserContent = params.messages.filter((message) => message.role === 'user').at(-1)?.content || '';
      const call = (id) => options.onElectronToolRequest({ request_id: params.request_id, session_id: params.session_id,
        tool_name: 'image_generate', tool_call_id: id, arguments: { prompt: 'a model rewrite' } });
      results.push(await call('call_1'));
      results.push(await call('call_2'));
      options.onNotification({ method: 'chat.token', params: { delta: 'Here it is.' } });
      options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
      return { status: 'completed' };
    },
  };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_image_pin', prompt: 'A lighthouse at dusk, painterly',
    imagePromptPin: { width: 1024, height: 1024, seed: 7 },
  }));
  await service.activeStreams.get(stream.streamId)?._pendingPromise;

  const userRow = service.sessionStore.getSession('session_image_pin').messages.find((row) => row.role === 'user');
  assert.deepEqual(userRow.image_prompt_pin, { width: 1024, height: 1024, seed: 7 });
  assert.match(sentUserContent, /^A lighthouse at dusk, painterly\n\n\[Image request:/);
  assert.equal(pins.length, 1, 'the second call never reached the tool');
  assert.deepEqual(pins[0].pin, { width: 1024, height: 1024, seed: 7, prompt: 'A lighthouse at dusk, painterly' });
  assert.equal(pins[0].modelPrompt, 'a model rewrite');
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, false);
  assert.match(results[1].output, /already drew the user's image/);
  const complete = service.emittedEvents.find((entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'complete');
  assert.equal(complete.payload.imagePromptUndrawn, undefined, 'a drawn turn is not flagged');
});

test('a pinned turn that ends without drawing is flagged on complete so the composer can restore it', async () => {
  const service = createManagedChatServiceStub();
  service.toolExecutor = { async executePreApproved() { throw new Error('the tool was never called'); } };
  service.sidecarClient = {
    connected: true,
    async chatSend(_params, options = {}) {
      options.onNotification({ method: 'chat.token', params: { delta: 'What a lovely idea!' } });
      options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
      return { status: 'completed' };
    },
  };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_image_undrawn', prompt: 'A lighthouse at dusk', imagePromptPin: { width: 1024, height: 1024 },
  }));
  await service.activeStreams.get(stream.streamId)?._pendingPromise;
  const complete = service.emittedEvents.find((entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'complete');
  assert.equal(complete.payload.imagePromptUndrawn, true);
});

test('an unpinned turn hands the tool no pin', async () => {
  const service = createManagedChatServiceStub();
  let seen = 'unset';
  service.toolExecutor = {
    async executePreApproved(_call, context) {
      seen = context.imagePromptPin;
      return { content: 'Generated', isError: false, metadata: {} };
    },
  };
  service.sidecarClient = {
    connected: true,
    async chatSend(params, options = {}) {
      await options.onElectronToolRequest({ request_id: params.request_id, session_id: params.session_id,
        tool_name: 'image_generate', tool_call_id: 'call_1', arguments: { prompt: 'a lighthouse' } });
      return { content: 'Done.', finish_reason: 'stop' };
    },
  };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_image_plain', prompt: 'Draw a lighthouse',
  }));
  await service.activeStreams.get(stream.streamId)?._pendingPromise;
  assert.equal(seen, undefined);
});
