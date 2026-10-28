'use strict';

// Model-listing discovery for user API-key providers (row 78). The parser reads
// a CLOSED list of known fields so an unknown or hostile row can never smuggle
// data into stored config. The fetch helper never throws for network or HTTP
// failures and never returns the key, the URL, headers or any response text:
// callers surface only `{ code, status? }`.

const { MAX_DISCOVERED_ROWS, normalizeDiscoveryRow, normalizeHeaders } = require('./api-provider-config');
const { validateProviderEndpoint } = require('./api-provider-endpoint');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
// eslint-disable-next-line no-control-regex -- refusing control characters is the point.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const CONTEXT_PATHS = [
  ['context_length'], ['context_window'], ['max_context_length'], ['max_model_len'],
  ['top_provider', 'context_length'],
];
const OUTPUT_PATHS = [
  ['max_completion_tokens'], ['max_output_tokens'], ['top_provider', 'max_completion_tokens'],
];

function pathValue(source, path) {
  return path.reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), source);
}

function firstLimit(source, paths) {
  for (const path of paths) {
    const value = pathValue(source, path);
    if (Number.isInteger(value) && value > 0 && value <= 10_000_000) return value;
  }
  return undefined;
}

const includesAny = (list, names) => Array.isArray(list) && names.some((name) => list.includes(name));

function rowFlags(raw) {
  const flags = {};
  if (includesAny(raw.supported_parameters, ['tools'])
    || pathValue(raw, ['capabilities', 'function_calling']) === true
    || raw.supports_tools === true) flags.tools = true;
  if (includesAny(pathValue(raw, ['architecture', 'input_modalities']), ['image'])
    || pathValue(raw, ['capabilities', 'vision']) === true
    || raw.supports_image_input === true) flags.vision = true;
  if (includesAny(raw.supported_parameters, ['reasoning', 'include_reasoning'])) flags.reasoning = true;
  return flags;
}

function parseRow(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  return normalizeDiscoveryRow({
    id: raw.id.replace(/^models\//, ''),
    contextLength: firstLimit(raw, CONTEXT_PATHS),
    maxOutputTokens: firstLimit(raw, OUTPUT_PATHS),
    ...rowFlags(raw),
  });
}

function listingEntries(body) {
  if (Array.isArray(body)) return body;
  return body && typeof body === 'object' && Array.isArray(body.data) ? body.data : null;
}

// Every shipped transport lists `{ data: [{ id, ... }] }`; `transport` is kept for a later shape.
function parseModelListing(_transport, body) {
  const rows = [];
  const seen = new Set();
  for (const entry of listingEntries(body) || []) {
    const row = parseRow(entry);
    if (!row || seen.has(row.id)) continue;
    if (rows.length >= MAX_DISCOVERED_ROWS) break;
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

const failure = (code, status) => ({ ok: false, error: status === undefined ? { code } : { code, status } });

function classifyStatus(status) {
  if (status >= 300 && status < 400) return 'redirect_refused';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'http_error';
}

function classifyFetchError(error, signal) {
  if (signal.aborted || error?.name === 'AbortError') return 'timeout';
  const text = `${error?.message || ''} ${error?.cause?.message || ''}`;
  return error instanceof TypeError && /redirect/i.test(text) ? 'redirect_refused' : 'network_error';
}

// The Messages API refuses its model listing without a version header.
const ANTHROPIC_VERSION = '2026-10-21';

function requestHeaders({ transport, authProfile, apiKey, headers }) {
  const extra = Object.fromEntries(normalizeHeaders(headers).map((row) => [row.name, row.value]));
  const result = { Accept: 'application/json', ...extra };
  if (transport === 'anthropic_messages_v1') result['anthropic-version'] = ANTHROPIC_VERSION;
  if (authProfile === 'api_key_bearer') result.Authorization = `Bearer ${apiKey}`;
  if (authProfile === 'api_key_header') result['x-api-key'] = apiKey;
  return result;
}

function keyProblem(authProfile, apiKey) {
  if (authProfile === 'none') return null;
  if (authProfile !== 'api_key_bearer' && authProfile !== 'api_key_header') return 'invalid_request';
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  return !key || CONTROL_RE.test(key) ? 'key_missing' : null;
}

// Reads the body incrementally so an oversized response is cut off, not buffered.
async function readCappedText(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true };
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    return Buffer.byteLength(text) > maxBytes ? { tooLarge: true } : { text };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(Buffer.from(value));
  }
  return { text: Buffer.concat(chunks).toString('utf8') };
}

async function readListing(response, maxBytes) {
  const body = await readCappedText(response, maxBytes);
  if (body.tooLarge) return failure('too_large');
  let parsed;
  try {
    parsed = JSON.parse(body.text);
  } catch (_error) {
    return failure('invalid_response');
  }
  if (!listingEntries(parsed)) return failure('invalid_response');
  return { ok: true, parsed };
}

async function requestListing(url, init, { fetchImpl, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      // The error body is never read: release the connection instead.
      await response.body?.cancel?.().catch(() => {});
      return failure(classifyStatus(response.status), response.status);
    }
    return await readListing(response, maxBytes);
  } catch (error) {
    return failure(classifyFetchError(error, controller.signal));
  } finally {
    clearTimeout(timer);
  }
}

async function fetchModelListing({
  endpoint,
  transport,
  authProfile,
  apiKey,
  headers = [],
  fetchImpl = globalThis.fetch,
  lookup,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  let base;
  try {
    base = await validateProviderEndpoint(endpoint, { lookup });
  } catch (_error) {
    return failure('invalid_endpoint');
  }
  const problem = keyProblem(authProfile, apiKey);
  if (problem) return failure(problem);
  const init = {
    method: 'GET',
    redirect: 'error',
    headers: requestHeaders({ transport, authProfile, apiKey: typeof apiKey === 'string' ? apiKey.trim() : '', headers }),
  };
  // Anthropic pages its listing (default 20 rows); one request at its maximum page size.
  const url = transport === 'anthropic_messages_v1' ? `${base}/models?limit=1000` : `${base}/models`;
  const result = await requestListing(url, init, { fetchImpl, timeoutMs, maxBytes });
  if (!result.ok) return result;
  return { ok: true, rows: parseModelListing(transport, result.parsed), fetchedAt: new Date().toISOString() };
}

module.exports = { fetchModelListing, parseModelListing };
