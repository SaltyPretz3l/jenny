'use strict';

// Discovery supplements the immutable signed descriptor with metadata only.
const CATALOG_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.159.1';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 128;
const CONTEXT_CEILING = 272000;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function normalizeCatalog(value) {
  if (!value || !Array.isArray(value.models) || value.models.length > MAX_MODELS) {
    throw new Error('catalog_invalid');
  }
  const models = [];
  const seen = new Set();
  for (const row of value.models) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('catalog_invalid');
    if (row.visibility !== 'list') continue;
    const id = row.slug;
    if (typeof id !== 'string' || !SAFE_ID.test(id) || seen.has(id)) throw new Error('catalog_invalid');
    const label = row.display_name;
    if (typeof label !== 'string' || !label.trim() || label.length > 256
        // eslint-disable-next-line no-control-regex -- reject untrusted control characters
        || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(label)) {
      throw new Error('catalog_invalid');
    }
    const levels = row.supported_reasoning_levels;
    if (!Array.isArray(levels) || levels.length > 16) throw new Error('catalog_invalid');
    const efforts = [...new Set(levels.map((item) => item?.effort).filter((effort) => EFFORTS.has(effort)))];
    if (!efforts.length) continue;
    const context = row.context_window;
    if (!Number.isSafeInteger(context) || context <= 0) throw new Error('catalog_invalid');
    seen.add(id);
    models.push({
      id, label: label.trim(), context_length: Math.min(context, CONTEXT_CEILING),
      reasoning_efforts: efforts,
      default_reasoning_effort: efforts.includes(row.default_reasoning_level)
        ? row.default_reasoning_level : efforts[0],
      vision: Array.isArray(row.input_modalities) && row.input_modalities.includes('image'),
    });
  }
  if (!models.length) throw new Error('catalog_empty');
  return models;
}

async function readCatalog(response, signal) {
  if (!response?.ok || response.redirected) {
    Promise.resolve(response?.body?.cancel?.()).catch(() => {});
    throw new Error('catalog_http_failed');
  }
  const declared = Number(response.headers?.get?.('content-length'));
  if (declared > MAX_RESPONSE_BYTES) {
    Promise.resolve(response.body?.cancel?.()).catch(() => {});
    throw new Error('catalog_oversized');
  }
  if (!response.body?.getReader) throw new Error('catalog_body_unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('catalog_timeout');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('catalog_oversized');
      chunks.push(Buffer.from(value));
    }
    return normalizeCatalog(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally {
    signal.removeEventListener('abort', abort);
    Promise.resolve(reader.cancel()).catch(() => {});
  }
}

function createChatgptModelCatalogService({ authService, getAuthority = () => null,
  fetchImpl = global.fetch, now = Date.now, timeoutMs = 5000,
  ttlMs = 15 * 60 * 1000, backoffMs = 60 * 1000, onInvalidated = () => {},
  log = () => {} } = {}) {
  let scope = null;
  let models = null;
  let fetchedAt = 0;
  let nextAttemptAt = 0;
  let flight = null;
  let generation = 0;
  let disposed = false;
  function identity() {
    if (disposed || !authService?.hasCredential?.()) return null;
    const authority = getAuthority();
    if (!authority) return null;
    return JSON.stringify([authority, authService.getAccountId?.() || '',
      authService.getCredentialEpoch?.() || 0]);
  }
  function invalidate() {
    generation += 1;
    flight?.controller.abort();
    flight = null;
    scope = null;
    models = null;
    fetchedAt = 0;
    nextAttemptAt = 0;
    onInvalidated();
  }
  function syncScope() {
    const current = identity();
    if (current !== scope) { invalidate(); scope = current; }
    return current;
  }
  function snapshot() {
    syncScope();
    return { models: models ? structuredClone(models) : null,
      stale: !models || now() < fetchedAt || now() - fetchedAt >= ttlMs,
      source: models ? 'chatgpt_authenticated_catalog' : 'chatgpt_static_catalog' };
  }
  async function refresh() {
    const current = syncScope();
    if (!current || (models && now() >= fetchedAt && now() - fetchedAt < ttlMs)
        || now() < nextAttemptAt) return snapshot();
    if (flight) return flight.promise;
    const tokenGeneration = generation;
    const controller = new AbortController();
    let rejectDeadline;
    const deadline = new Promise((_resolve, reject) => { rejectDeadline = reject; });
    const abort = () => rejectDeadline(new Error('catalog_cancelled'));
    controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const task = (async () => {
      const token = await authService.getAccessToken();
      if (!token || controller.signal.aborted || identity() !== current) throw new Error('catalog_revoked');
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json',
        originator: 'jenny', 'User-Agent': 'jenny' };
      const accountId = authService.getAccountId?.();
      if (accountId) headers['ChatGPT-Account-ID'] = accountId;
      const fetchCatalog = () => fetchImpl(CATALOG_URL, {
        method: 'GET', headers, redirect: 'error', signal: controller.signal,
      });
      let response = await fetchCatalog();
      if (response.status === 401) {
        Promise.resolve(response.body?.cancel?.()).catch(() => {});
        const refreshed = await authService.getAccessToken({ force: true });
        if (!refreshed || controller.signal.aborted || identity() !== current) {
          throw new Error('catalog_revoked');
        }
        headers.Authorization = `Bearer ${refreshed}`;
        response = await fetchCatalog();
      }
      const result = await readCatalog(response, controller.signal);
      if (controller.signal.aborted || generation !== tokenGeneration || identity() !== current) {
        throw new Error('catalog_revoked');
      }
      models = result;
      fetchedAt = now();
      nextAttemptAt = 0;
      log('chatgpt.catalog.updated', { model_count: result.length });
    })();
    const promise = Promise.race([task, deadline]).catch(() => {
      if (generation === tokenGeneration && identity() === current) {
        nextAttemptAt = now() + backoffMs;
        log('chatgpt.catalog.refresh_failed', { reason_code: 'catalog_unavailable' });
      }
    }).finally(() => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abort);
      if (flight?.promise === promise) flight = null;
    }).then(snapshot);
    flight = { controller, promise };
    return promise;
  }
  const unsubscribe = authService?.onStatusChange?.(invalidate);
  return { refresh, snapshot, invalidate,
    dispose() { disposed = true; unsubscribe?.(); invalidate(); } };
}

// B13: the startup restore boots ChatGPT with the saved last model only while
// the catalog lists it. Fetch it first, bounded, so the startup config can
// carry the model. A slow or failed fetch changes nothing: the engine boots
// unloaded as before.
const CHATGPT_CATALOG_PRIME_TIMEOUT_MS = 2500;
async function primeChatgptCatalogForRestore(backendService, catalogService,
  { timeoutMs = CHATGPT_CATALOG_PRIME_TIMEOUT_MS } = {}) {
  const state = backendService?.configService?.getState?.() || {};
  if (typeof catalogService?.refresh !== 'function'
    || state.preferredEngineType !== 'chatgpt' || !state.lastChatgptModel) return false;
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve().then(() => catalogService.refresh()).catch(() => null),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return true;
}

module.exports = { createChatgptModelCatalogService, normalizeCatalog, primeChatgptCatalogForRestore,
  CATALOG_URL, MAX_RESPONSE_BYTES, MAX_MODELS };
