'use strict';

// services/semantic-catalog-service.js: the idle-gated pump that lets the
// sidecar catalog knowledge folders only while the main model is unused.
// Every collaborator is injected (clock, timers, backend, embedder manager,
// sidecar client); nothing spawns a process or touches the network.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATES,
  STEP_MAX_CHUNKS,
  SemanticCatalogService,
  isMainModelBusy,
} = require('../services/semantic-catalog-service');

const QUIET_MS = 30_000;
const POLL_MS = 2_000;
const RESCAN_MS = 600_000;
const RETRY_MS = 60_000;

function createHarness(overrides = {}) {
  const clock = { now: 1_000_000 };
  const scheduled = [];
  const requests = [];
  const refreshes = [];
  const logs = [];
  const manager = {
    starts: [],
    stops: 0,
    syncStops: 0,
    resets: 0,
    failNext: null,
    async ensureRunning(spec) {
      this.starts.push(spec);
      if (this.failNext) {
        const error = this.failNext;
        this.failNext = null;
        throw error;
      }
      return { baseUrl: 'http://127.0.0.1:50123/v1', apiKey: 'k'.repeat(32), modelKey: 'abcdef0123456789' };
    },
    async stop() { this.stops += 1; return { confirmed: true }; },
    stopSync() { this.syncStops += 1; },
    reset() { this.resets += 1; },
    getApiKey() { return 'k'.repeat(32); },
    getState() { return { status: 'ready', lastError: null }; },
  };
  const responses = [];
  const backend = {
    activeStreams: new Map(),
    sessionRuntime: { hasPendingOrAdmittedWork: () => false },
    exclusiveGpuCoordinator: { getState: () => ({ state: 'chat_resident', leaseId: null }) },
    _modelLifecycle: { state: 'ready' },
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    sidecarClient: {
      connected: true,
      async request(method, params) {
        requests.push({ method, params });
        return responses.length ? responses.shift() : { more: false, counts: { documents: 1 } };
      },
    },
  };
  const state = {
    flag: true,
    settings: { enabled: true, modelPath: 'C:\\models\\embeddinggemma.gguf', profileId: '', device: 'cpu', dims: 0 },
    roots: ['C:\\notes'],
    resolved: {
      ok: true,
      name: 'embeddinggemma',
      profileId: 'embeddinggemma',
      dims: 256,
      queryTemplate: 'task: search result | query: {text}',
      documentTemplate: 'title: {title} | text: {text}',
    },
  };
  const service = new SemanticCatalogService({
    userDataPath: 'C:\\userData',
    getBackend: () => backend,
    getSettings: () => state.settings,
    isFeatureEnabled: () => state.flag,
    embeddingManager: manager,
    resolveModel: () => state.resolved,
    listRootPaths: () => state.roots,
    refreshSidecarConfig: async (reason) => { refreshes.push({ reason, config: service.getSidecarConfig() }); },
    logger: (level, event, details) => logs.push({ level, event, details }),
    setTimeoutImpl: (fn, ms) => { const handle = { fn, ms, unref() {} }; scheduled.push(handle); return handle; },
    clearTimeoutImpl: (handle) => { handle.cleared = true; },
    now: () => clock.now,
    quietMs: QUIET_MS,
    pollMs: POLL_MS,
    rescanMs: RESCAN_MS,
    retryMs: RETRY_MS,
    ...overrides,
  });
  const lastDelay = () => scheduled.filter((handle) => !handle.cleared).at(-1)?.ms;
  return { backend, clock, logs, manager, refreshes, requests, responses, scheduled, service, state, lastDelay };
}

async function tickAfterQuiet(harness) {
  harness.clock.now += QUIET_MS;
  await harness.service._tick();
}

test('isMainModelBusy counts every main-model and GPU signal, and treats unknown state as busy', () => {
  const idle = {
    activeStreams: new Map(),
    sessionRuntime: { hasPendingOrAdmittedWork: () => false },
    exclusiveGpuCoordinator: { getState: () => ({ state: 'chat_resident' }) },
    _modelLifecycle: { state: 'ready' },
  };
  const none = () => 0;
  assert.equal(isMainModelBusy(idle, { pendingInference: none }), false);
  assert.equal(isMainModelBusy(null, { pendingInference: none }), true);
  assert.equal(isMainModelBusy({ ...idle, activeStreams: new Map([['s', {}]]) }, { pendingInference: none }), true);
  assert.equal(isMainModelBusy({ ...idle, sessionRuntime: { hasPendingOrAdmittedWork: () => true } }, { pendingInference: none }), true);
  assert.equal(isMainModelBusy({ ...idle, sessionRuntime: { hasPendingOrAdmittedWork: () => { throw new Error('x'); } } }, { pendingInference: none }), true);
  assert.equal(isMainModelBusy(idle, { pendingInference: () => 1 }), true);
  assert.equal(isMainModelBusy({ ...idle, exclusiveGpuCoordinator: { getState: () => ({ state: 'privileged_resident' }) } }, { pendingInference: none }), true);
  assert.equal(isMainModelBusy({ ...idle, exclusiveGpuCoordinator: { getState: () => ({ state: 'transitioning' }) } }, { pendingInference: none }), true);
  assert.equal(isMainModelBusy({ ...idle, _modelLifecycle: { state: 'loading' } }, { pendingInference: none }), true);
  assert.equal(isMainModelBusy({ ...idle, _modelLifecycle: { state: 'acquiring' } }, { pendingInference: none }), true);
});

test('flag off or toggle off keeps the catalog off and issues no step', async () => {
  const harness = createHarness();
  harness.state.flag = false;
  await tickAfterQuiet(harness);
  assert.equal(harness.service.state, STATES.OFF);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.manager.starts.length, 0);

  harness.state.flag = true;
  harness.state.settings = { ...harness.state.settings, enabled: false };
  await harness.service._tick();
  assert.equal(harness.service.state, STATES.OFF);
  assert.equal(harness.requests.length, 0);
});

test('no model chosen waits without starting the embedder', async () => {
  const harness = createHarness();
  harness.state.settings = { ...harness.state.settings, modelPath: '' };
  await tickAfterQuiet(harness);
  assert.equal(harness.service.state, STATES.WAITING_MODEL);
  assert.equal(harness.manager.starts.length, 0);
  assert.equal(harness.requests.length, 0);
});

test('nothing runs until the main model has been quiet for the full quiet period', async () => {
  const harness = createHarness();
  await harness.service._tick();
  assert.equal(harness.service.state, STATES.IDLE_WAIT);
  assert.equal(harness.manager.starts.length, 0);

  harness.clock.now += QUIET_MS - 1;
  await harness.service._tick();
  assert.equal(harness.manager.starts.length, 0);
  assert.equal(harness.lastDelay(), 1);

  harness.backend.activeStreams.set('turn', {});
  harness.clock.now += 10;
  await harness.service._tick();
  assert.equal(harness.lastDelay(), POLL_MS);
  harness.backend.activeStreams.clear();
  harness.clock.now += QUIET_MS - 1;
  await harness.service._tick();
  assert.equal(harness.requests.length, 0, 'a turn restarts the quiet period');
});

test('after the quiet period it starts the embedder, publishes the config once and pumps steps', async () => {
  const harness = createHarness();
  harness.responses.push({ more: true, counts: { documents: 5, pending: 4 }, step: { embedded: 16, elapsed_ms: 900 } });
  await tickAfterQuiet(harness);

  assert.deepEqual(harness.manager.starts, [{ modelPath: 'C:\\models\\embeddinggemma.gguf', device: 'cpu' }]);
  assert.equal(harness.refreshes.length, 1);
  assert.deepEqual(harness.refreshes[0].config.semantic_catalog, {
    enabled: true,
    db_path: require('node:path').join('C:\\userData', 'semantic-catalog.db'),
    base_url: 'http://127.0.0.1:50123/v1',
    model_key: 'abcdef0123456789:embeddinggemma:256',
    query_template: 'task: search result | query: {text}',
    document_template: 'title: {title} | text: {text}',
    dims: 256,
  });
  assert.deepEqual(harness.service.getSidecarSecrets(), { semantic_catalog_api_key: 'k'.repeat(32) });

  assert.equal(harness.requests.length, 1);
  const [first] = harness.requests;
  assert.equal(first.method, 'catalog.index_step');
  assert.ok(first.params.accept_version);
  assert.deepEqual(first.params.roots, [{ path: 'C:\\notes' }]);
  assert.equal(first.params.budget.max_chunks, STEP_MAX_CHUNKS);
  assert.equal(first.params.rescan, true);
  assert.equal(harness.service.state, STATES.INDEXING);
  assert.ok(harness.lastDelay() < 1_000, 'the next step follows promptly');

  await harness.service._tick();
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[1].params.rescan, false, 'unchanged roots do not rescan every step');
  assert.equal(harness.refreshes.length, 1, 'an unchanged embedder does not republish');
  assert.equal(harness.service.state, STATES.CAUGHT_UP);
  harness.clock.now += QUIET_MS * 4;
  await harness.service._tick();
  assert.equal(harness.requests.length, 2, 'caught up issues no step before the rescan interval');
  assert.equal(harness.service.state, STATES.CAUGHT_UP);
});

test('caught up keeps tracking busy, so a due rescan still waits for a full quiet period', async () => {
  const harness = createHarness();
  harness.responses.push({ more: false, counts: {} }, { more: false, counts: {} });
  await tickAfterQuiet(harness);
  assert.equal(harness.service.state, STATES.CAUGHT_UP);
  harness.clock.now += RESCAN_MS - 1_000;
  harness.backend.activeStreams.set('turn', {});
  await harness.service._tick();
  assert.equal(harness.service.state, STATES.CAUGHT_UP, 'a chat while caught up does not read as paused');
  harness.backend.activeStreams.clear();
  harness.clock.now += 2_000;
  await harness.service._tick();
  assert.equal(harness.requests.length, 1, 'the rescan is due but the chat ended only a second ago');
  harness.clock.now += QUIET_MS;
  await harness.service._tick();
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[1].params.rescan, true);
});

test('a change during an in-flight tick is re-evaluated right after it, not dropped', async () => {
  const harness = createHarness();
  let release;
  harness.backend.sidecarClient.request = (method, params) => {
    harness.requests.push({ method, params });
    return new Promise((resolve) => { release = () => resolve({ more: false, counts: {} }); });
  };
  harness.clock.now += QUIET_MS;
  const inFlight = harness.service._tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.requests.length, 1);
  harness.state.settings = { ...harness.state.settings, enabled: false };
  harness.service.notifyChanged('settings');
  release();
  await inFlight;
  assert.equal(harness.lastDelay(), 0, 'the turned-off setting is evaluated immediately');
  await harness.service._tick();
  assert.equal(harness.service.state, STATES.OFF);
  assert.equal(harness.manager.stops, 1);
});

test('a work start while the engine starts stops the step from being issued', async () => {
  const harness = createHarness();
  const ensure = harness.manager.ensureRunning.bind(harness.manager);
  harness.manager.ensureRunning = async (spec) => {
    harness.backend.activeStreams.set('turn', {});
    return ensure(spec);
  };
  await tickAfterQuiet(harness);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.service.state, STATES.PAUSED_BUSY);
});

test('a turn that starts and ends inside the engine start still restarts the quiet wait', async () => {
  const harness = createHarness();
  const ensure = harness.manager.ensureRunning.bind(harness.manager);
  harness.manager.ensureRunning = async (spec) => {
    harness.backend.activeStreams.set('turn', {});
    harness.clock.now += 1_000;
    const sampler = harness.scheduled.filter((handle) => !handle.cleared).at(-1);
    sampler.fn(); // the busy sample taken while the engine was starting
    harness.backend.activeStreams.clear();
    harness.clock.now += 1_000;
    return ensure(spec);
  };
  await tickAfterQuiet(harness);
  assert.equal(harness.requests.length, 0, 'no step right after a turn the start overlapped');
  assert.equal(harness.service.state, STATES.PAUSED_BUSY);
  assert.ok(harness.lastDelay() > 0 && harness.lastDelay() <= POLL_MS);

  harness.manager.ensureRunning = ensure;
  harness.clock.now += QUIET_MS;
  await harness.service._tick();
  assert.equal(harness.requests.length, 1, 'the step follows a full quiet period');
});

test('a turn inside an index step restarts the quiet wait for either more value', async () => {
  for (const more of [true, false]) {
    const harness = createHarness();
    let release;
    harness.responses.push(new Promise((resolve) => { release = resolve; }));
    harness.clock.now += QUIET_MS;
    const inFlight = harness.service._tick();
    for (let i = 0; i < 20 && harness.requests.length === 0; i += 1) await Promise.resolve();
    assert.equal(harness.requests.length, 1);

    harness.backend.activeStreams.set('turn', {});
    harness.clock.now += 250;
    const busyAt = harness.clock.now;
    const sampler = harness.scheduled.filter((handle) => !handle.cleared).at(-1);
    if (sampler) sampler.cleared = true;
    sampler?.fn();
    harness.backend.activeStreams.clear();
    harness.clock.now += 250;
    release({ more, counts: {} });
    await inFlight;
    assert.equal(harness.service.state, STATES.PAUSED_BUSY);
    assert.equal(harness.service.lastBusyAt, busyAt);
    assert.ok(harness.scheduled.filter((handle) => handle.ms === 250).every((handle) => handle.cleared));

    harness.clock.now = busyAt + QUIET_MS - 1;
    await harness.service._tick();
    assert.equal(harness.requests.length, 1, 'no second step before the renewed quiet period');
    assert.equal(harness.service.state, STATES.PAUSED_BUSY);
    assert.equal(harness.lastDelay(), 1);
    harness.clock.now += 1;
    await harness.service._tick();
    assert.equal(harness.requests.length, more ? 2 : 1);
    assert.equal(harness.service.state, STATES.CAUGHT_UP);
    assert.equal(harness.service.lastRootsKey, harness.state.roots.join('\n'));
  }
});

test('failed disabled config withdrawal retries while off or waiting for a model', async () => {
  for (const waitingModel of [false, true]) {
    const harness = createHarness();
    await harness.service._ensureEngine(harness.state.settings);
    assert.ok(harness.service.publishedConfigKey && harness.service.publishedConfigKey !== 'disabled');
    harness.service.refreshSidecarConfig = async () => { throw new Error('initialize failed'); };
    harness.state.settings = { ...harness.state.settings, ...(waitingModel ? { modelPath: '' } : { enabled: false }) };
    await harness.service._tick();
    assert.equal(harness.service.state, waitingModel ? STATES.WAITING_MODEL : STATES.OFF);
    assert.ok(harness.service.timer, 'a failed withdrawal must leave a retry timer');
    assert.equal(harness.lastDelay(), RETRY_MS);

    harness.service.refreshSidecarConfig = async (reason) => {
      harness.refreshes.push({ reason, config: harness.service.getSidecarConfig() });
    };
    harness.clock.now += RETRY_MS;
    harness.service.timer.fn();
    for (let i = 0; i < 20 && harness.service.ticking; i += 1) await Promise.resolve();
    assert.equal(harness.service.ticking, false);
    assert.equal(harness.service.publishedConfigKey, 'disabled');
    assert.deepEqual(harness.refreshes.at(-1).config, { semantic_catalog: { enabled: false } });
    assert.equal(harness.manager.stops, 1);
    assert.equal(harness.manager.starts.length, 1);
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.service.timer, null, 'successful withdrawal disarms the retry');
  }
});

test('a failed config refresh is retried rather than remembered as applied', async () => {
  let fail = true;
  const harness = createHarness({
    refreshSidecarConfig: async () => { if (fail) throw new Error('initialize failed'); },
  });
  harness.responses.push({ available: false }, { more: false, counts: {} });
  await tickAfterQuiet(harness);
  assert.ok(harness.logs.some((entry) => entry.event === 'semantic_catalog.config_refresh_failed'));
  fail = false;
  let refreshed = 0;
  harness.service.refreshSidecarConfig = async () => { refreshed += 1; };
  await harness.service._tick();
  assert.equal(refreshed, 1);
});

test('a turn that starts between steps pauses the pump at the step boundary', async () => {
  const harness = createHarness();
  harness.responses.push({ more: true, counts: {} });
  await tickAfterQuiet(harness);
  assert.equal(harness.requests.length, 1);

  harness.backend.activeStreams.set('turn', {});
  await harness.service._tick();
  assert.equal(harness.requests.length, 1, 'no step is issued while the main model is busy');
  assert.equal(harness.service.state, STATES.PAUSED_BUSY);
  assert.ok(harness.logs.some((entry) => entry.event === 'semantic_catalog.paused'));
  assert.equal(harness.manager.stops, 0, 'the embedder stays up for query embeds during the turn');

  harness.backend.activeStreams.clear();
  harness.clock.now += 1_000;
  await harness.service._tick();
  assert.equal(harness.requests.length, 1, 'resuming waits for a fresh quiet period');
  harness.clock.now += QUIET_MS;
  await harness.service._tick();
  assert.equal(harness.requests.length, 2);
});

test('a changed root list or the rescan interval forces a rescan', async () => {
  const harness = createHarness();
  harness.responses.push({ more: false, counts: {} }, { more: false, counts: {} }, { more: false, counts: {} });
  await tickAfterQuiet(harness);
  harness.state.roots = ['C:\\notes', 'D:\\papers'];
  await harness.service._tick();
  assert.equal(harness.requests[1].params.rescan, true);
  harness.clock.now += RESCAN_MS;
  await harness.service._tick();
  assert.equal(harness.requests[2].params.rescan, true);
});

test('a refused model parks the catalog until the settings change', async () => {
  const harness = createHarness();
  harness.state.resolved = { ok: false, reason: 'not_embedding_model' };
  await tickAfterQuiet(harness);
  assert.equal(harness.service.state, STATES.ERROR);
  assert.deepEqual(harness.service.getStatus().lastError, { code: 'embedding_model_refused', reason: 'not_embedding_model' });
  assert.equal(harness.manager.starts.length, 0);

  harness.clock.now += QUIET_MS;
  await harness.service._tick();
  assert.equal(harness.manager.starts.length, 0, 'no retry loop on a refusal');

  harness.service.start();
  harness.state.resolved = { ok: true, name: 'other', profileId: 'none', dims: 0 };
  const before = harness.scheduled.length;
  harness.service.notifyChanged('settings');
  assert.equal(harness.manager.resets, 1);
  assert.equal(harness.scheduled.length, before + 1, 'a settings change re-arms the scheduler');
  await tickAfterQuiet(harness);
  assert.equal(harness.manager.starts.length, 1);
});

test('an embedder that fails to start surfaces a coded error and retries later', async () => {
  const harness = createHarness();
  harness.manager.failNext = new Error('embedder_backoff');
  await tickAfterQuiet(harness);
  assert.equal(harness.service.state, STATES.ERROR);
  assert.equal(harness.service.getStatus().lastError.code, 'embedder_backoff');
  assert.equal(harness.lastDelay(), RETRY_MS);
  assert.equal(harness.requests.length, 0);
  assert.deepEqual(harness.service.getSidecarConfig(), { semantic_catalog: { enabled: false } });

  harness.manager.failNext = new Error('embedding_model_refused:not_embedding_model');
  harness.clock.now += RETRY_MS;
  await harness.service._tick();
  assert.deepEqual(harness.service.getStatus().lastError, { code: 'embedding_model_refused', reason: 'not_embedding_model' },
    'a refusal from the engine keeps its reason for the Settings copy');
});

test('a sidecar without the catalog config applied is retried shortly, not treated as an error', async () => {
  const harness = createHarness();
  harness.responses.push({ available: false, reason: 'CMP-CAT-0002' });
  await tickAfterQuiet(harness);
  assert.notEqual(harness.service.state, STATES.ERROR);
  assert.equal(harness.lastDelay(), 5_000);
});

test('a step error from the sidecar is reported and backs off', async () => {
  const harness = createHarness();
  harness.responses.push({ more: true, counts: {}, error: { code: 'CMP-CAT-0001', message: 'down' } });
  await tickAfterQuiet(harness);
  assert.equal(harness.service.state, STATES.ERROR);
  assert.equal(harness.service.getStatus().lastError.code, 'CMP-CAT-0001');
  assert.equal(harness.lastDelay(), RETRY_MS);
});

test('turning the catalog off stops the embedder and withdraws the sidecar config', async () => {
  const harness = createHarness();
  await tickAfterQuiet(harness);
  assert.equal(harness.refreshes.length, 1);
  harness.state.settings = { ...harness.state.settings, enabled: false };
  harness.service.notifyChanged('settings');
  await harness.service._tick();
  assert.equal(harness.service.state, STATES.OFF);
  assert.equal(harness.manager.stops, 1);
  assert.equal(harness.refreshes.length, 2);
  assert.deepEqual(harness.refreshes[1].config, { semantic_catalog: { enabled: false } });
  assert.deepEqual(harness.service.getSidecarSecrets(), {});
});

test('dispose stops the embedder synchronously and schedules nothing more', async () => {
  const harness = createHarness();
  harness.service.start();
  harness.service.dispose();
  assert.equal(harness.manager.syncStops, 1);
  const before = harness.scheduled.length;
  await harness.service._tick();
  harness.service.notifyChanged('roots');
  assert.equal(harness.scheduled.length, before);
  assert.equal(harness.requests.length, 0);
});

test('getDetailedStatus adds bounded per-folder counts from the sidecar', async () => {
  const harness = createHarness();
  await tickAfterQuiet(harness);
  harness.responses.push({
    available: true,
    size_bytes: 4096,
    roots: [{ path: 'C:\\notes', documents: 840, indexed: 812, pending: 28, failed: 0, skipped: 12,
      skipped_reasons: { pdf_addon_missing: 9, needs_ocr: 3, 'bad key!': 1 }, scan_complete: true }],
  });
  const detailed = await harness.service.getDetailedStatus();
  assert.equal(harness.requests.at(-1).method, 'catalog.status');
  assert.deepEqual(detailed.roots, [{
    path: 'C:\\notes', documents: 840, indexed: 812, pending: 28, failed: 0, skipped: 12,
    skippedReasons: { pdf_addon_missing: 9, needs_ocr: 3 }, scanComplete: true,
  }]);
  assert.equal(detailed.sizeBytes, 4096);
});

test('getDetailedStatus reports a junctioned folder under its registered path', async () => {
  const realpathSync = (value) => (value === 'C:\\Users\\me\\notes' ? 'D:\\Data\\Notes' : value);
  realpathSync.native = realpathSync;
  const harness = createHarness({ fsImpl: { realpathSync } });
  harness.state.roots = ['C:\\Users\\me\\notes'];
  await tickAfterQuiet(harness);
  harness.responses.push({
    available: true,
    roots: [{ path: 'D:\\Data\\Notes\\', indexed: 3, pending: 0, scan_complete: true }],
  });
  const detailed = await harness.service.getDetailedStatus();
  assert.equal(detailed.roots[0].path, 'C:\\Users\\me\\notes');
});

test('rebuild purges through the sidecar while on; delete removes the files while off', async () => {
  const harness = createHarness();
  await tickAfterQuiet(harness);
  harness.responses.push({ ok: true, purged_documents: 3 });
  assert.deepEqual(await harness.service.purge({ rebuild: true }), { ok: true });
  assert.deepEqual(harness.requests.at(-1), { method: 'catalog.purge', params: { accept_version: harness.requests.at(-1).params.accept_version, all: true } });
  assert.equal(harness.lastDelay(), 0, 'a rebuild re-arms the scheduler');

  const removed = [];
  const off = createHarness({ fsImpl: { unlinkSync: (file) => removed.push(file) } });
  off.state.settings = { ...off.state.settings, enabled: false };
  await tickAfterQuiet(off);
  assert.deepEqual(await off.service.purge({ rebuild: false }), { ok: true });
  assert.equal(removed.length, 3);
  assert.ok(removed[0].endsWith('semantic-catalog.db'));
  assert.equal(off.requests.length, 0);

  const busy = createHarness({ fsImpl: { unlinkSync: () => { const error = new Error('busy'); error.code = 'EBUSY'; throw error; } } });
  busy.state.settings = { ...busy.state.settings, enabled: false };
  await tickAfterQuiet(busy);
  assert.deepEqual(await busy.service.purge({ rebuild: false }), { ok: false, reason: 'catalog_in_use' });
});
