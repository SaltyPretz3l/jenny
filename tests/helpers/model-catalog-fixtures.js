'use strict';

// Shared fixtures for the model catalog service tests.
const { ModelCatalogService } = require('../../services/model-catalog-service');

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
  return { ok, status, body: new Response(body).body };
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

module.exports = { BUNDLED, catalog, jsonResponse, makeFs, makeService };
