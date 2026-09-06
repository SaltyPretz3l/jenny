const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_CATALOG_BYTES,
  MAX_CATALOG_MODELS,
  ModelCatalogService,
} = require('../services/model-catalog-service');

const BUNDLED = JSON.stringify({
  catalogVersion: 1,
  updatedAt: '2026-06-13',
  source: 'bundled-default',
  models: [
    {
      tier: 'daily', modelId: 'gemma4:12b', displayName: 'Gemma 4 12B', params: '12B',
      quant: 'Q5_K_XL', vramRequiredMb: 13000, ramRequiredMb: 16000, contextLength: 32768,
      downloadSizeMb: 9800, pullTag: 'gemma4:12b',
    },
  ],
});

function catalog(version, extra = {}) {
  return JSON.stringify({
    catalogVersion: version,
    updatedAt: `v${version}`,
    source: 'remote',
    models: [
      {
      tier: 'daily', modelId: `m:${version}`, displayName: `Model ${version}`, params: '12B',
      quant: 'Q5', vramRequiredMb: 13000, ramRequiredMb: 16000, contextLength: 32768,
      downloadSizeMb: 9800, pullTag: `m:${version}`,
      },
    ],
    ...extra,
  });
}

function makeFs(files = {}) {
  const store = { ...files };
  return {
    store,
    readFileSync(p) {
      if (Object.prototype.hasOwnProperty.call(store, p)) {
        return store[p];
      }
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
    writeFileSync(p, content) {
      store[p] = content;
    },
  };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => body };
}

function makeService(opts = {}) {
  return new ModelCatalogService({
    bundledPath: '/bundled.json',
    cachePath: '/cache.json',
    remoteUrl: 'https://example.test/catalog.json',
    fsImpl: makeFs({ '/bundled.json': BUNDLED, ...(opts.files || {}) }),
    fetchImpl: opts.fetchImpl,
    nowProvider: opts.nowProvider || (() => 0),
    throttleMs: opts.throttleMs == null ? 1000 : opts.throttleMs,
    logger: () => {},
    ...(opts.fsImpl ? { fsImpl: opts.fsImpl } : {}),
  });
}

test('getCatalog falls back to bundled when no cache exists', () => {
  const svc = makeService();
  const result = svc.getCatalog();
  assert.equal(result.catalogVersion, 1);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].pullTag, 'gemma4:12b');
  assert.equal(result.models[0].downloadSizeMb, 9800);
});

test('getCatalog prefers a valid userData cache over the bundled default', () => {
  const svc = makeService({ files: { '/cache.json': catalog(5) } });
  const result = svc.getCatalog();
  assert.equal(result.catalogVersion, 5);
  assert.equal(result.models[0].pullTag, 'm:5');
});

test('validate rejects malformed catalogs', () => {
  const svc = makeService();
  assert.equal(svc.validate(null), null);
  assert.equal(svc.validate({}), null);
  assert.equal(svc.validate({ catalogVersion: 0, models: [] }), null);
  assert.equal(svc.validate({ catalogVersion: 2, models: [] }), null); // no usable entries
  assert.equal(svc.validate({ catalogVersion: 2, models: [{ params: '12B' }] }), null); // no pullTag
  const ok = svc.validate(JSON.parse(catalog(3)));
  assert.equal(ok.catalogVersion, 3);
  assert.equal(ok.models.length, 1);
});

test('refresh accepts a higher-version remote and writes the cache', async () => {
  const fs = makeFs({ '/bundled.json': BUNDLED });
  const svc = new ModelCatalogService({
    bundledPath: '/bundled.json',
    cachePath: '/cache.json',
    remoteUrl: 'https://example.test/catalog.json',
    fsImpl: fs,
    fetchImpl: async () => jsonResponse(catalog(3)),
    nowProvider: () => 0,
    throttleMs: 1000,
    logger: () => {},
  });
  const result = await svc.refresh();
  assert.equal(result.catalogVersion, 3);
  assert.equal(svc.getCatalog().catalogVersion, 3);
  assert.ok(fs.store['/cache.json'], 'cache file should be written');
  assert.equal(JSON.parse(fs.store['/cache.json']).catalogVersion, 3);
});

test('refresh rejects a lower-version remote and keeps the current catalog', async () => {
  const svc = makeService({
    files: { '/cache.json': catalog(5) },
    fetchImpl: async () => jsonResponse(catalog(2)),
  });
  const result = await svc.refresh();
  assert.equal(result.catalogVersion, 5);
  assert.equal(svc.getCatalog().catalogVersion, 5);
});

test('refresh rejects malformed remote payloads and keeps the current catalog', async () => {
  const svc = makeService({ fetchImpl: async () => jsonResponse('{ not valid json') });
  const result = await svc.refresh();
  assert.equal(result.catalogVersion, 1); // bundled default retained
});

test('refresh tolerates network failure (offline) and keeps the current catalog', async () => {
  const svc = makeService({
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  const result = await svc.refresh();
  assert.equal(result.catalogVersion, 1);
});

test('refresh throttles repeat fetches within the window', async () => {
  let calls = 0;
  let now = 0;
  const svc = makeService({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(catalog(2));
    },
    nowProvider: () => now,
    throttleMs: 1000,
  });
  await svc.refresh();
  assert.equal(calls, 1);
  now = 500; // within throttle window
  await svc.refresh();
  assert.equal(calls, 1, 'should not refetch within throttle window');
  now = 2000; // past throttle window
  await svc.refresh();
  assert.equal(calls, 2, 'should refetch after throttle window elapses');
});

test('refresh metadata throttles a second service construction within the window', async () => {
  const fs = makeFs({ '/bundled.json': BUNDLED });
  let calls = 0;
  const createService = (now) => new ModelCatalogService({
    bundledPath: '/bundled.json',
    cachePath: '/cache.json',
    remoteUrl: 'https://example.test/catalog.json',
    fsImpl: fs,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(catalog(2));
    },
    nowProvider: () => now,
    throttleMs: 1000,
    logger: () => {},
  });

  await createService(100).refresh();
  await createService(500).refresh();

  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(fs.store['/cache.json.meta.json']), {
    last_fetched_at: 100,
    etag: null,
  });
});

test('F1: a persisted etag is ignored when the cache file is missing', async () => {
  // Reproduces the finding: cache deleted (or truncated) but .meta.json
  // survives with a still-looking-valid etag. Trusting it would let a 304
  // silently hand back the bundled catalog forever.
  let requestOptions = null;
  const svc = makeService({
    files: {
      // Deliberately no '/cache.json' -- only the stale meta survives.
      '/cache.json.meta.json': JSON.stringify({ last_fetched_at: 0, etag: '"stale-etag"' }),
    },
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return jsonResponse(catalog(2));
    },
    nowProvider: () => 2000,
  });

  assert.equal(svc._etag, null, 'etag must not be trusted without a valid backing cache');

  const result = await svc.refresh();

  assert.equal(requestOptions.headers, undefined, 'no If-None-Match should be sent without a valid cache');
  assert.equal(result.catalogVersion, 2, 'refresh must actually re-fetch, not 304 against a phantom cache');
});

test('F1: a persisted etag is trusted when the cache file is valid', async () => {
  let requestOptions = null;
  const svc = makeService({
    files: {
      '/cache.json': catalog(5),
      '/cache.json.meta.json': JSON.stringify({ last_fetched_at: 0, etag: '"catalog-v5"' }),
    },
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return jsonResponse(catalog(5));
    },
    nowProvider: () => 2000,
  });

  assert.equal(svc._etag, '"catalog-v5"');

  await svc.refresh();

  assert.equal(requestOptions.headers['If-None-Match'], '"catalog-v5"');
});

test('F2: a future last_fetched_at does not permanently disable refresh', async () => {
  let calls = 0;
  const svc = makeService({
    files: {
      '/cache.json': catalog(5),
      '/cache.json.meta.json': JSON.stringify({ last_fetched_at: 999_999_999_999, etag: null }),
    },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(catalog(6));
    },
    nowProvider: () => 1000, // now is far in the past relative to the bogus stamp
    throttleMs: 1000,
  });

  assert.equal(svc._lastFetchedAt, Number.NEGATIVE_INFINITY, 'a future stamp must be discarded, not trusted');

  const result = await svc.refresh();

  assert.equal(calls, 1, 'refresh must not be permanently throttled by a future timestamp');
  assert.equal(result.catalogVersion, 6);
});

test('F3: an oversized response etag is bounded before being persisted', async () => {
  const fs = makeFs({ '/bundled.json': BUNDLED });
  const hugeEtag = `"${'x'.repeat(2_000_000)}"`;
  const svc = new ModelCatalogService({
    bundledPath: '/bundled.json',
    cachePath: '/cache.json',
    remoteUrl: 'https://example.test/catalog.json',
    fsImpl: fs,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'etag' ? hugeEtag : null) },
      text: async () => catalog(2),
    }),
    nowProvider: () => 0,
    throttleMs: 1000,
    logger: () => {},
  });

  await svc.refresh();

  const persistedMeta = JSON.parse(fs.store['/cache.json.meta.json']);
  assert.ok(
    persistedMeta.etag.length <= 256,
    `persisted etag should be bounded, got ${persistedMeta.etag.length} chars`
  );
  assert.ok(
    Buffer.byteLength(fs.store['/cache.json.meta.json'], 'utf8') < 1024,
    'meta.json must stay small even for a huge response etag'
  );
});

test('F3: a poisoned response etag does not brick future refreshes', async () => {
  const fs = makeFs({ '/bundled.json': BUNDLED });
  const poisonedEtag = 'good\r\nX-Injected: evil';
  let fetchCalls = 0;
  const makeSvc = () => new ModelCatalogService({
    bundledPath: '/bundled.json',
    cachePath: '/cache.json',
    remoteUrl: 'https://example.test/catalog.json',
    fsImpl: fs,
    fetchImpl: async (_url, options) => {
      const etagHeader = options?.headers?.['If-None-Match'];
      if (typeof etagHeader === 'string' && /[\r\n]/.test(etagHeader)) {
        // Mirrors undici throwing synchronously on an invalid header value --
        // the request never actually reaches the network.
        throw new TypeError(`invalid header value: ${JSON.stringify(etagHeader)}`);
      }
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'etag' ? poisonedEtag : null) },
        text: async () => catalog(2),
      };
    },
    nowProvider: () => 0,
    throttleMs: 0,
    logger: () => {},
  });

  await makeSvc().refresh(); // persists the poisoned etag if unsanitized
  await makeSvc().refresh(); // a fresh construction re-reads the persisted meta

  assert.equal(fetchCalls, 2, 'the second refresh must reach the network, not throw on a poisoned stored etag');
});

test('F6: _writeCache distinguishes "no cachePath configured" from a real write failure', async () => {
  let now = 0;
  let requestOptions = null;
  const svc = new ModelCatalogService({
    bundledPath: '/bundled.json',
    // No cachePath -- a caller that intentionally runs without a userData cache.
    remoteUrl: 'https://example.test/catalog.json',
    fsImpl: makeFs({ '/bundled.json': BUNDLED }),
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name === 'etag' ? '"v2-etag"' : null) },
        text: async () => catalog(2),
      };
    },
    nowProvider: () => now,
    throttleMs: 1000,
    logger: () => {},
  });

  await svc.refresh();
  assert.equal(svc._etag, '"v2-etag"', 'a successful 200 must update the in-memory etag even with no cachePath');

  now = 2000; // past the throttle window
  await svc.refresh();
  assert.equal(requestOptions.headers['If-None-Match'], '"v2-etag"');
});

test('refresh sends a stored etag as If-None-Match', async () => {
  let requestOptions = null;
  const svc = makeService({
    files: {
      // The cache the etag validates must exist: a stored etag is only trusted
      // when its backing catalog still loads, so an etag-only fixture would be
      // testing the absence of that guard rather than the If-None-Match wiring.
      '/cache.json': catalog(2),
      '/cache.json.meta.json': JSON.stringify({ last_fetched_at: 0, etag: '"catalog-v2"' }),
    },
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return jsonResponse(catalog(2));
    },
    nowProvider: () => 2000,
  });

  await svc.refresh();

  assert.equal(requestOptions.headers['If-None-Match'], '"catalog-v2"');
});

test('refresh treats 304 as success, preserves cache, and restamps metadata', async () => {
  const cachedCatalog = catalog(5);
  const fs = makeFs({
    '/bundled.json': BUNDLED,
    '/cache.json': cachedCatalog,
    '/cache.json.meta.json': JSON.stringify({ last_fetched_at: 0, etag: '"catalog-v5"' }),
  });
  const logEvents = [];
  const svc = new ModelCatalogService({
    bundledPath: '/bundled.json',
    cachePath: '/cache.json',
    remoteUrl: 'https://example.test/catalog.json',
    fsImpl: fs,
    fetchImpl: async () => ({
      ok: false,
      status: 304,
      headers: { get: () => null },
    }),
    nowProvider: () => 2000,
    throttleMs: 1000,
    logger: (level, event, data) => logEvents.push({ level, event, data }),
  });

  const result = await svc.refresh();

  assert.equal(result.catalogVersion, 5);
  assert.equal(fs.store['/cache.json'], cachedCatalog);
  assert.deepEqual(JSON.parse(fs.store['/cache.json.meta.json']), {
    last_fetched_at: 2000,
    etag: '"catalog-v5"',
  });
  // Pre-fix, a 304 is `ok: false` and falls into the generic HTTP-error path
  // (which also preserves the cache unchanged), so without this assertion
  // the test passes vacuously on the wrong branch.
  assert.ok(
    logEvents.some((entry) => entry.event === 'model_catalog.not_modified'),
    'the not_modified path should be logged, not the generic http-error path'
  );
  assert.ok(
    !logEvents.some((entry) => entry.event === 'model_catalog.refresh_http_error'),
    'a 304 must never be logged as a generic HTTP error'
  );
});

test('malformed refresh metadata falls back to refresh allowed', async () => {
  const now = 1_000_000;
  const shapes = [
    { name: 'unparsable json', raw: '{not-json' },
    { name: 'array instead of object', raw: JSON.stringify([1, 2, 3]) },
    { name: 'negative last_fetched_at', raw: JSON.stringify({ last_fetched_at: -5, etag: null }) },
    { name: 'future last_fetched_at', raw: JSON.stringify({ last_fetched_at: now + 60_000, etag: null }) },
    { name: 'non-string etag', raw: JSON.stringify({ last_fetched_at: 0, etag: 42 }) },
    { name: 'oversized etag', raw: JSON.stringify({ last_fetched_at: 0, etag: 'x'.repeat(2000) }) },
    { name: 'etag with control character', raw: JSON.stringify({ last_fetched_at: 0, etag: 'abc\r\ndef' }) },
  ];

  for (const { name, raw } of shapes) {
    let calls = 0;
    const svc = makeService({
      files: {
        // A valid backing cache in every case, so F1's cache-validity gate
        // doesn't mask what this table is actually exercising (metadata
        // shape validation), and so the etag-shape rows below can actually
        // reach sanitizeEtag() instead of being nulled out by cacheUsable.
        '/cache.json': catalog(5),
        '/cache.json.meta.json': raw,
      },
      nowProvider: () => now,
      fetchImpl: async (_url, options) => {
        const etagHeader = options?.headers?.['If-None-Match'];
        const hasControlChar = typeof etagHeader === 'string'
          && Array.from(etagHeader).some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127);
        if (hasControlChar) {
          // Mirrors undici throwing synchronously on an invalid header value
          // -- without sanitization this would happen on every future
          // refresh, since the poisoned etag is never cleared (F3).
          throw new TypeError('invalid header value');
        }
        calls += 1;
        return jsonResponse(catalog(2));
      },
    });

    await svc.refresh();

    assert.equal(calls, 1, `expected refresh to reach the network for: ${name}`);
    assert.ok(
      svc._etag === null || (typeof svc._etag === 'string' && svc._etag.length <= 256),
      `persisted etag must stay bounded/sanitized for: ${name}`
    );
  }
});

test('refresh({force:true}) bypasses the throttle', async () => {
  let calls = 0;
  const svc = makeService({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(catalog(2));
    },
    nowProvider: () => 0,
    throttleMs: 1000,
  });
  await svc.refresh();
  await svc.refresh({ force: true });
  assert.equal(calls, 2);
});

test('getMeta surfaces version/updatedAt/source of the active catalog', () => {
  const svc = makeService({ files: { '/cache.json': catalog(7) } });
  const meta = svc.getMeta();
  assert.equal(meta.version, 7);
  assert.equal(meta.updatedAt, 'v7');
  assert.equal(meta.source, 'remote');
});

test('validate preserves preferred: true and defaults it false when absent', () => {
  const svc = makeService();
  const withPreferred = svc.validate({
    catalogVersion: 6,
    models: [
      {
        tier: 'coder', modelId: 'ornith:9b-q8_0', displayName: 'Ornith 1.0 9B (coder)',
        params: '9B', quant: 'Q8_0', vramRequiredMb: 12000, ramRequiredMb: 14000,
        contextLength: 49152, pullTag: 'ornith:9b-q8_0', preferred: true,
      },
      {
        tier: 'daily', modelId: 'gemma4:12b', displayName: 'Gemma 4 12B', params: '12B',
        quant: 'Q6', vramRequiredMb: 13000, ramRequiredMb: 16000, contextLength: 32768,
        pullTag: 'gemma4:12b',
      },
    ],
  });
  assert.equal(withPreferred.models[0].preferred, true);
  assert.equal(withPreferred.models[1].preferred, false); // absent -> defaults false
});

test('validate bounds remote catalog fields and rejects unsafe pull tags', () => {
  const svc = makeService();
  const rawModels = Array.from({ length: MAX_CATALOG_MODELS + 20 }, (_, index) => ({
    modelId: `model:${index}`,
    pullTag: index === 0 ? 'unsafe tag' : `model:${index}`,
    displayName: 'x'.repeat(400),
    downloadSizeMb: index === 1 ? Number.POSITIVE_INFINITY : 10 ** 20,
  }));
  const result = svc.validate({ catalogVersion: 7, models: rawModels });

  assert.equal(result.models.length, MAX_CATALOG_MODELS - 1);
  assert.equal(result.models[0].downloadSizeMb, 0);
  assert.equal(result.models[1].downloadSizeMb, 2_147_483_647);
  assert.equal(result.models[0].displayName.length, 256);
});

test('refresh rejects oversized remote payloads without replacing the catalog', async () => {
  const svc = makeService({
    fetchImpl: async () => jsonResponse('x'.repeat(MAX_CATALOG_BYTES + 1)),
  });

  const result = await svc.refresh();

  assert.equal(result.catalogVersion, 1);
});
