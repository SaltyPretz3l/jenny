'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createModelLibrarySource,
  createPullController,
} = require('../renderer/shell/model-library/model-library-sources');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function sourceHarness(overrides = {}) {
  const calls = [];
  const models = {
    async list() {
      calls.push('models.list');
      return {
        data: [{
          id: 'installed:1b',
          size: 42,
          engine_type: 'ollama',
          parameterSize: '1B',
          quantizationLevel: 'Q4_K_M',
          digest: 'sha256:abc',
        }],
      };
    },
    async listOllamaTags() {
      calls.push('models.listOllamaTags');
      return { data: [{ name: 'tag-only:2b', size: 84 }] };
    },
    ...(overrides.models || {}),
  };
  const offline = {
    async getDiagnostics() {
      calls.push('offline.getDiagnostics');
      return {
        modelRecommendations: [{ pullTag: 'recommended:3b' }],
        modelFitEstimates: [{ modelId: 'installed:1b', vramRequiredMb: 2048 }],
        hardwareProfile: { gpu: { type: 'cuda', vram_mb: 12000 } },
        memory: { totalMb: 32000 },
        catalogMeta: { version: 4 },
      };
    },
    ...(overrides.offline || {}),
  };
  const llamaServer = {
    async listLocalGgufs() {
      calls.push('llamaServer.listLocalGgufs');
      return {
        ok: true,
        entries: [{
          tag: ' Gemma4:12B ',
          source: ' library ',
          dir: ' C:\\models ',
          mainGguf: ' main.gguf ',
          drafterGguf: ' draft.gguf ',
          mmproj: ' vision.gguf ',
          sizeBytes: '2048',
        }, { tag: '  ', sizeBytes: 10 }],
      };
    },
    async getStatus() {
      calls.push('llamaServer.getStatus');
      return {
        ok: true,
        state: ' READY ',
        alias: ' Gemma4:12B ',
        port: '8033',
        accelerationMode: ' MTP ',
        reused: true,
      };
    },
    ...(overrides.llamaServer || {}),
  };
  const shell = { models, offline, llamaServer, ...(overrides.shell || {}) };
  const source = createModelLibrarySource({
    windowRef: { jennyShell: shell },
    appendClientLog: () => {},
  });
  return { source, calls };
}

test('model library source isolates every bridge failure and preserves successful sources', async (t) => {
  const cases = [
    {
      name: 'installed',
      overrides: { models: { async list() { throw new Error('list failed'); } } },
      unavailable: 'installed',
      assertOthers(result) {
        assert.equal(result.ollamaTags.length, 1);
        assert.equal(result.recommendations.length, 1);
      },
    },
    {
      name: 'ollama tags',
      overrides: { models: { async listOllamaTags() { throw new Error('tags failed'); } } },
      unavailable: 'ollamaTags',
      assertOthers(result) {
        assert.equal(result.installed.length, 1);
        assert.equal(result.recommendations.length, 1);
      },
    },
    {
      name: 'diagnostics',
      overrides: { offline: { async getDiagnostics() { throw new Error('diag failed'); } } },
      unavailable: 'diagnostics',
      assertOthers(result) {
        assert.equal(result.installed.length, 1);
        assert.equal(result.ollamaTags.length, 1);
        assert.deepEqual(result.fitEstimates, []);
      },
    },
    {
      name: 'local GGUF files',
      overrides: {
        llamaServer: { async listLocalGgufs() { throw new Error('ggufs failed'); } },
      },
      unavailable: 'localGgufs',
      assertOthers(result) {
        assert.equal(result.installed.length, 1);
        assert.equal(result.llamaServer.state, 'ready');
      },
    },
    {
      name: 'llama-server status',
      overrides: { llamaServer: { getStatus: undefined } },
      unavailable: 'llamaServer',
      assertOthers(result) {
        assert.equal(result.ollamaTags.length, 1);
        assert.equal(result.localGgufs.length, 1);
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { source } = sourceHarness(entry.overrides);
      const result = await source.load({ llamaServer: true });
      assert.equal(typeof result.unavailable[entry.unavailable], 'string');
      assert.ok(result.unavailable[entry.unavailable].length > 0);
      entry.assertOthers(result);
    });
  }
});

test('model library source normalizes installed entries and diagnostics fields', async () => {
  const { source } = sourceHarness();
  const result = await source.load({ llamaServer: true });

  assert.deepEqual(result.installed, [{
    id: 'installed:1b',
    size: 42,
    engine_type: 'ollama',
    available: true,
    reason: '',
    parameterSize: '1B',
    quantizationLevel: 'Q4_K_M',
    digest: 'sha256:abc',
  }]);
  assert.deepEqual(result.fitEstimates, [{ modelId: 'installed:1b', vramRequiredMb: 2048 }]);
  assert.deepEqual(result.hardware, { gpu: { type: 'cuda', vram_mb: 12000 } });
  assert.deepEqual(result.memory, { totalMb: 32000 });
  assert.deepEqual(result.catalogMeta, { version: 4 });
  assert.deepEqual(result.localGgufs, [{
    tag: 'Gemma4:12B',
    source: 'library',
    dir: 'C:\\models',
    mainGguf: 'main.gguf',
    drafterGguf: 'draft.gguf',
    sizeBytes: 2048,
  }]);
  assert.deepEqual(result.llamaServer, {
    state: 'ready',
    alias: 'Gemma4:12B',
    port: 8033,
    accelerationMode: 'mtp',
    reused: true,
  });
});

test('model library source treats a missing llamaServer namespace as normal unavailability', async () => {
  const { source } = sourceHarness({ shell: { llamaServer: undefined } });
  const result = await source.load({ llamaServer: true });

  assert.equal(typeof result.unavailable.localGgufs, 'string');
  assert.equal(typeof result.unavailable.llamaServer, 'string');
  assert.deepEqual(result.localGgufs, []);
  assert.equal(result.llamaServer, null);
  assert.equal(result.installed.length, 1);
  assert.equal(result.ollamaTags.length, 1);
  assert.equal(result.recommendations.length, 1);
});

test('model library source reports fail-soft llama-server payloads as unavailable', async () => {
  const { source } = sourceHarness({
    llamaServer: {
      async listLocalGgufs() { return { ok: false, reason: 'scan unavailable' }; },
      async getStatus() { return { ok: false, reason: 'status unavailable' }; },
    },
  });
  const result = await source.load({ llamaServer: true });

  // Reason codes stay internal; the status line gets the human sentence.
  assert.equal(result.unavailable.localGgufs, 'Local GGUF files unavailable.');
  assert.equal(result.unavailable.llamaServer, 'llama-server status unavailable.');
  assert.deepEqual(result.localGgufs, []);
  assert.equal(result.llamaServer, null);
  assert.equal(result.installed.length, 1);
});

// Same-option concurrent loads coalesce, so exercise stale loads across differing source sets.
test('model library source exposes monotonic generations for caller-side stale-load drops', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const { source } = sourceHarness({
    models: {
      list() {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
    },
  });

  const olderPromise = source.load();
  const newerPromise = source.load({ llamaServer: true });
  assert.equal(source.latestGeneration(), 2);
  second.resolve({ data: ['newer'] });
  const newer = await newerPromise;
  first.resolve({ data: ['older'] });
  const older = await olderPromise;

  assert.equal(older.generation, 1);
  assert.equal(newer.generation, 2);
  assert.equal(source.latestGeneration(), 2);
  assert.equal(older.generation === source.latestGeneration(), false);
  assert.deepEqual(newer.installed, [{
    id: 'newer', size: 0, engine_type: '', available: true, reason: '',
  }]);
  assert.deepEqual(older.installed, [{
    id: 'older', size: 0, engine_type: '', available: true, reason: '',
  }]);
});

test('pull controller filters request ids, reports progress and completion transitions, and never loads a model', async (t) => {
  const callLog = [];
  const changes = [];
  let progressListener;
  const setupService = {
    subscribePullProgress(listener) {
      callLog.push('setup.subscribePullProgress');
      progressListener = listener;
      return () => callLog.push('setup.unsubscribePullProgress');
    },
    async startOllamaPull(payload) {
      callLog.push(['setup.startOllamaPull', payload]);
      return { requestId: payload.requestId, status: 'running' };
    },
  };
  let controller;
  controller = createPullController({
    setupService,
    onChange(key) {
      changes.push({ key, pull: controller.getPulls()[key] });
    },
  });
  t.after(() => controller.dispose());

  await controller.start('Gemma4');
  const key = 'gemma4:latest';
  const requestId = controller.getPulls()[key].requestId;
  const beforeForeign = changes.length;
  progressListener({ requestId: 'foreign', status: 'running', percent: 90 });
  assert.equal(changes.length, beforeForeign);

  progressListener({
    requestId,
    status: 'running',
    percent: 35,
    downloadedBytes: 10 * 1024 * 1024,
    totalBytes: 20 * 1024 * 1024,
  });
  assert.equal(controller.getPulls()[key].percent, 35);
  assert.equal(controller.getPulls()[key].bytesText, '10MB / 20MB');
  progressListener({ requestId, status: 'completed', percent: 100 });

  assert.equal(controller.getPulls()[key], undefined);
  assert.ok(changes.some((entry) => entry.pull && entry.pull.status === 'done'));
  assert.deepEqual(callLog.filter((entry) => Array.isArray(entry)).map((entry) => entry[0]), [
    'setup.startOllamaPull',
  ]);
  assert.ok(!callLog.includes('models.load'));
});

test('pull controller keeps an honest visible state when cancellation is refused', async (t) => {
  let progressListener;
  let changeCount = 0;
  const setupService = {
    subscribePullProgress(listener) {
      progressListener = listener;
      return () => {};
    },
    async startOllamaPull(payload) {
      return { requestId: payload.requestId, status: 'running' };
    },
    async cancelOllamaPull() {
      return { cancelled: false, code: 'termination_failed' };
    },
  };
  const controller = createPullController({
    setupService,
    onChange() { changeCount += 1; },
  });
  t.after(() => controller.dispose());

  await controller.start('qwen:7b');
  const requestId = controller.getPulls()['qwen:7b'].requestId;
  progressListener({ requestId, status: 'running', percent: 12 });
  const beforeCancel = changeCount;
  await controller.cancel('QWEN:7B');

  assert.equal(controller.getPulls()['qwen:7b'].status, 'running');
  assert.equal(controller.getPulls()['qwen:7b'].cancelFailed, true);
  assert.equal(changeCount, beforeCancel + 1);
});

test('model library source skips the advisory llama-server reads unless asked', async () => {
  const { source, calls } = sourceHarness();
  const result = await source.load();

  assert.ok(!calls.some((call) => call.startsWith('llamaServer.')), calls.join(','));
  assert.deepEqual(result.localGgufs, []);
  assert.equal(result.llamaServer, null);
  assert.equal('localGgufs' in result.unavailable, false);
  assert.equal('llamaServer' in result.unavailable, false);
  assert.equal(result.installed.length, 1);
});
