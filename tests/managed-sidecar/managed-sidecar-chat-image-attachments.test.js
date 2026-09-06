'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  startManagedSidecarChatStream,
} = require('../../services/backend/managed-sidecar-chat');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
} = require('../helpers/managed-sidecar-chat-lifecycle-helpers');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('../helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

for (const { engineType, modelId, featureFlags, expectedMode, flagState } of [
  { engineType: 'openai-compatible', modelId: 'C:/models/vision.gguf', expectedMode: 'assist', flagState: 'absent' },
  { engineType: 'chatgpt', modelId: 'gpt-5.2', featureFlags: { vision_unified_turn: true }, expectedMode: 'assist', flagState: 'on' },
  { engineType: 'openai-compatible', modelId: 'C:/models/vision.gguf', featureFlags: { vision_unified_turn: false }, expectedMode: 'chat', flagState: 'off' },
]) {
  test(`image attachment reaches chat.send in ${expectedMode} mode with unified flag ${flagState}`, async () => {
    const service = createManagedChatServiceStub({ featureFlags });
    const tempDir = createTrackedTempDir(`jenny-managed-${engineType}-image-`);
    const realImagePath = path.join(tempDir, 'capture.png');
    fs.writeFileSync(realImagePath, Buffer.from('image-bytes'));
    service.attachmentAssetStore = {
      resolveManagedAssetRealPath() {
        return realImagePath;
      },
    };
    service._resolveModel = async () => modelId;
    let chatSendCount = 0;
    let chatSendParams = null;
    service.sidecarClient = {
      async chatSend(params, options = {}) {
        chatSendCount += 1;
        chatSendParams = params;
        options.onNotification({ method: 'chat.token', params: { delta: 'Seen.' } });
        options.onNotification({ method: 'chat.done', params: {} });
        return { status: 'completed' };
      },
    };

    const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
      sessionId: `session_${engineType}_image`,
      prompt: 'Describe this image',
      runtimePreferredModel: modelId,
      attachments: [{
        id: `att_${engineType}_image`,
        kind: 'image',
        assetPath: path.join(tempDir, 'logical.png'),
        displayName: 'capture.png',
        mimeType: 'image/png',
      }],
    }));
    const controller = service.activeStreams.get(stream.streamId);
    assert.ok(controller, 'active stream controller must exist before settle');
    await controller._pendingPromise;

    assert.equal(chatSendCount, 1);
    assert.equal(chatSendParams.attachments.length, 1);
    assert.equal(chatSendParams.attachments[0].kind, 'image');
    assert.equal(chatSendParams.mode, expectedMode);
  });
}
