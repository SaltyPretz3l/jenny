const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OfflineIntelligenceService,
} = require('../../services/offline-intelligence-service');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');
const {
  waitForChatStreamEvent,
  createManagedService,
} = require('../helpers/managed-sidecar-runtime-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createOfflineConfig(preferredLocalModel) {
  return {
    getState() {
      return {
        offlineIntelligence: {
          mode: 'local_only',
          preferredLocalModel: String(preferredLocalModel || ''),
        },
      };
    },
  };
}

test('managed sidecar force-local mode rejects sends without a Model Library selection', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-offline-missing-model-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  service.offlineIntelligenceService = new OfflineIntelligenceService({
    configService: createOfflineConfig(''),
    backendService: service,
  });

  await service.start();
  await assert.rejects(
    () => service.startChatStream({
      prompt: 'Work fully offline.',
      preferredModel: 'mock-v1',
    }),
    /model selected in Model Library/i
  );

  await service.stop();
});

test('managed sidecar local-only mode uses the selected local model without mutating stored session preference', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-offline-preferred-model-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  service.offlineIntelligenceService = new OfflineIntelligenceService({
    configService: createOfflineConfig('qwen3.5:9b'),
    backendService: service,
  });

  await service.start();
  const created = await service.createSession({
    title: 'Stored Preference Session',
    preferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
    },
  });
  const completed = waitForChatStreamEvent(
    service,
    (event) => event.type === 'complete'
  );

  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Use the local model for this turn.',
    preferredModel: 'mock-v1',
  });
  await completed;

  assert.equal(service.currentModel, 'qwen3.5:9b');
  const sessions = await service.listSessions();
  const persistedSession = sessions.data.find((session) => session.id === created.data.id);
  assert.ok(persistedSession);
  assert.equal(persistedSession.preferred_model, 'mock-v1');

  await service.stop();
});

test('managed sidecar local-only mode blocks image attachments when the selected local model lacks vision support', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-offline-no-vision-'));
  trackDirectory(userDataPath);
  const imagePath = path.join(userDataPath, 'capture.png');
  fs.writeFileSync(imagePath, 'fake-image');

  const service = createManagedService(userDataPath);
  service.offlineIntelligenceService = new OfflineIntelligenceService({
    configService: createOfflineConfig('qwen3.5:9b'),
    backendService: service,
  });

  await service.start();
  await assert.rejects(
    () => service.startChatStream({
      prompt: 'Describe the screenshot.',
      attachments: [{
        id: 'image_1',
        kind: 'image',
        displayName: 'capture.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        width: 640,
        height: 360,
        assetPath: imagePath,
        sourceKind: 'capture',
      }],
    }),
    /does not appear to support vision/i
  );

  await service.stop();
});
