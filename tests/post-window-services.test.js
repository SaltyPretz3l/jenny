'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPostWindowServiceStarters } = require('../services/main/post-window-services');

test('post-window starts run once each, in order, and survive a rejected async start', async () => {
  const calls = [];
  const starters = createPostWindowServiceStarters({
    backendService: { commandSandbox: { start: async () => { calls.push('commandSandbox'); throw new Error('docker'); } } },
    pdfAddon: { start: async () => { calls.push('pdfAddon'); throw new Error('fs'); } },
    imageEngine: { start: () => { calls.push('imageEngine'); } },
    wireSemanticCatalog: () => { calls.push('semanticCatalog'); },
  });
  starters.startPostWindowServices();
  starters.startPostWindowServices();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['pdfAddon', 'imageEngine', 'commandSandbox', 'semanticCatalog']);
});

test('the sidecar idle workers attach to the backend service once', () => {
  const backendService = {};
  const starters = createPostWindowServiceStarters({
    backendService, pdfAddon: {}, imageEngine: {}, wireSemanticCatalog: () => {},
  });
  starters.startSidecarIdleWorkers();
  const workers = [backendService.memoryReflectionScheduler, backendService.conversationIndexPump, backendService.memoryPurgeReconcile];
  try {
    assert.ok(workers.every((worker) => worker && typeof worker.dispose === 'function'));
    starters.startSidecarIdleWorkers();
    assert.deepEqual(
      [backendService.memoryReflectionScheduler, backendService.conversationIndexPump, backendService.memoryPurgeReconcile],
      workers,
    );
  } finally {
    workers.forEach((worker) => worker?.dispose?.());
  }
});
