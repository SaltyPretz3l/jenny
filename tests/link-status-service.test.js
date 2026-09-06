const { EventEmitter } = require('events');
const assert = require('node:assert/strict');
const test = require('node:test');

const { LinkStatusService } = require('../services/link-status-service');

const BASE_NOW_MS = new Date('2026-06-10T12:00:00.000Z').getTime();

class FakeHomeConfigService extends EventEmitter {
  constructor(links = []) {
    super();
    this._links = links;
  }

  getHomeConfig() {
    return { links: this._links, weather: {} };
  }

  setLinks(links) {
    this._links = links;
    this.emit('changed', {}, { reason: 'home_config_updated' });
  }
}

function tileGroup(tiles) {
  return [{ id: 'group', name: 'Group', tiles }];
}

function createFetchRecorder(handler) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, method: options.method });
      return handler(url, options, calls.length);
    },
  };
}

// Each nowProvider call advances 25ms so responseMs is observable in tests.
function createAdvancingClock(stepMs = 25) {
  let tick = 0;
  return () => new Date(BASE_NOW_MS + stepMs * tick++);
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createService({ links, fetchImpl, configService } = {}) {
  const logs = [];
  const service = new LinkStatusService({
    configService: configService || new FakeHomeConfigService(links || []),
    fetchImpl,
    logger: (level, event, details) => logs.push({ level, event, details }),
    nowProvider: createAdvancingClock(),
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  return { service, logs };
}

test('link status start can defer only the initial refresh while keeping the poll timer', () => {
  const configService = new FakeHomeConfigService();
  const intervals = [];
  const createStartedService = (deferInitialRefresh) => {
    const service = new LinkStatusService({
      configService,
      setIntervalImpl: (callback, intervalMs) => {
        intervals.push({ callback, intervalMs });
        return { unref() {} };
      },
      clearIntervalImpl: () => {},
    });
    let refreshCalls = 0;
    service.refresh = () => { refreshCalls += 1; };
    service.start(deferInitialRefresh ? { deferInitialRefresh: true } : undefined);
    return { service, refreshCalls: () => refreshCalls };
  };

  const deferred = createStartedService(true);
  const immediate = createStartedService(false);

  assert.equal(intervals.length, 2);
  assert.equal(deferred.refreshCalls(), 0);
  assert.equal(immediate.refreshCalls(), 1);
  deferred.service.stop();
  immediate.service.stop();
});

test('link status only ever requests explicit siteMonitor URLs', async () => {
  const { calls, fetchImpl } = createFetchRecorder(() => ({ ok: true, status: 200 }));
  const { service } = createService({
    links: tileGroup([
      { id: 'href-only', name: 'Href Only', href: 'https://example.com/' },
      { id: 'pi', name: 'Pi', href: 'https://pi.local/', siteMonitor: 'https://pi.local/health' },
    ]),
    fetchImpl,
  });

  await service.refresh();

  assert.deepEqual(calls.map((call) => call.url), ['https://pi.local/health']);
  const state = service.getState();
  assert.deepEqual(Object.keys(state.byTileId), ['pi']);
});

test('link status stays idle with no targets and reports an empty map', async () => {
  const { calls, fetchImpl } = createFetchRecorder(() => ({ ok: true, status: 200 }));
  const { service } = createService({ links: [], fetchImpl });

  await service.refresh();

  assert.equal(calls.length, 0);
  assert.deepEqual(service.getState(), { byTileId: {} });
});

test('a HEAD 200 marks the tile up with timing and no duplicate emit on identical status', async () => {
  const { calls, fetchImpl } = createFetchRecorder(() => ({ ok: true, status: 200 }));
  const { service } = createService({
    links: tileGroup([
      { id: 'pi', name: 'Pi', href: 'https://pi.local/', siteMonitor: 'https://pi.local/health' },
    ]),
    fetchImpl,
  });
  const emitted = [];
  service.on('changed', (state) => emitted.push(state));

  await service.refresh();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'HEAD');
  const entry = service.getState().byTileId.pi;
  assert.equal(entry.up, true);
  assert.equal(entry.statusCode, 200);
  assert.equal(entry.responseMs, 25);
  assert.match(entry.checkedAt, /^2026-06-10T12:00:00/);
  assert.equal(entry.error, '');
  assert.equal(emitted.length, 1);

  // Same up/status next poll: responseMs/checkedAt move but no renderer wake.
  await service.refresh();
  assert.equal(emitted.length, 1);
});

test('HEAD 405 falls back to GET and uses the GET status', async () => {
  const { calls, fetchImpl } = createFetchRecorder((_url, options) =>
    options.method === 'HEAD' ? { ok: false, status: 405 } : { ok: true, status: 200 }
  );
  const { service } = createService({
    links: tileGroup([
      { id: 'pi', name: 'Pi', href: 'https://pi.local/', siteMonitor: 'https://pi.local/health' },
    ]),
    fetchImpl,
  });

  await service.refresh();

  assert.deepEqual(calls.map((call) => call.method), ['HEAD', 'GET']);
  const entry = service.getState().byTileId.pi;
  assert.equal(entry.up, true);
  assert.equal(entry.statusCode, 200);
});

test('a thrown HEAD falls back to GET; a non-2xx response marks the tile down', async () => {
  const { calls, fetchImpl } = createFetchRecorder((_url, options) => {
    if (options.method === 'HEAD') {
      throw new Error('socket hang up');
    }
    return { ok: false, status: 503 };
  });
  const { service } = createService({
    links: tileGroup([
      { id: 'pi', name: 'Pi', href: 'https://pi.local/', siteMonitor: 'https://pi.local/health' },
    ]),
    fetchImpl,
  });

  await service.refresh();

  assert.deepEqual(calls.map((call) => call.method), ['HEAD', 'GET']);
  const entry = service.getState().byTileId.pi;
  assert.equal(entry.up, false);
  assert.equal(entry.statusCode, 503);
  assert.equal(entry.error, '');
});

test('both probes failing records the error without marking the service failed', async () => {
  const { fetchImpl } = createFetchRecorder(() => {
    throw new Error('network down');
  });
  const { service, logs } = createService({
    links: tileGroup([
      { id: 'pi', name: 'Pi', href: 'https://pi.local/', siteMonitor: 'https://pi.local/health' },
    ]),
    fetchImpl,
  });

  await service.refresh();

  const entry = service.getState().byTileId.pi;
  assert.equal(entry.up, false);
  assert.equal(entry.statusCode, 0);
  assert.equal(entry.error, 'network down');
  // A down target is data, not a WARN — only refresh-level failures log.
  assert.equal(logs.length, 0);
});

test('home config changes trigger a refresh and stale tiles drop out', async () => {
  const { calls, fetchImpl } = createFetchRecorder(() => ({ ok: true, status: 200 }));
  const configService = new FakeHomeConfigService(
    tileGroup([
      { id: 'pi', name: 'Pi', href: 'https://pi.local/', siteMonitor: 'https://pi.local/health' },
    ])
  );
  const { service } = createService({ configService, fetchImpl });
  service.start();
  await service._refreshPromise;
  assert.deepEqual(Object.keys(service.getState().byTileId), ['pi']);

  configService.setLinks(
    tileGroup([
      { id: 'nas', name: 'NAS', href: 'https://nas.local/', siteMonitor: 'https://nas.local/ping' },
    ])
  );
  await service._refreshPromise;

  assert.deepEqual(Object.keys(service.getState().byTileId), ['nas']);
  assert.equal(calls.at(-1).url, 'https://nas.local/ping');
  service.stop();
});

test('a config change during refresh queues one pass for the latest targets', async () => {
  const oldRequest = createDeferred();
  const configService = new FakeHomeConfigService(
    tileGroup([
      { id: 'old', name: 'Old', href: 'https://old/', siteMonitor: 'https://old/status' },
    ])
  );
  const { calls, fetchImpl } = createFetchRecorder((url) => {
    if (url === 'https://old/status') {
      return oldRequest.promise;
    }
    return { ok: true, status: 200 };
  });
  const { service } = createService({ configService, fetchImpl });

  service.start();
  configService.setLinks(
    tileGroup([
      { id: 'new', name: 'New', href: 'https://new/', siteMonitor: 'https://new/status' },
    ])
  );
  oldRequest.resolve({ ok: true, status: 200 });
  await service._refreshPromise;

  assert.deepEqual(calls.map((call) => call.url), ['https://old/status', 'https://new/status']);
  assert.deepEqual(Object.keys(service.getState().byTileId), ['new']);
  service.stop();
});

test('stop prevents an in-flight refresh from mutating or emitting', async () => {
  const request = createDeferred();
  const { service } = createService({
    links: tileGroup([
      { id: 'old', name: 'Old', href: 'https://old/', siteMonitor: 'https://old/status' },
    ]),
    fetchImpl: () => request.promise,
  });
  const emitted = [];
  service.on('changed', (state) => emitted.push(state));

  service.start();
  const refreshPromise = service._refreshPromise;
  service.stop();
  request.resolve({ ok: true, status: 200 });
  await refreshPromise;

  assert.deepEqual(service.getState(), { byTileId: {} });
  assert.deepEqual(emitted, []);
});
