'use strict';

// Level 4 of the API-provider limits chain (row 78 P2): the vendored models.dev
// snapshot (config/api-provider-catalog.json, MIT, refreshed per release by
// scripts/release/refresh_api_provider_catalog.py). Rows are keyed by preset
// id and matched on the exact model id; custom endpoints have no catalog. The
// file is re-validated on load because a damaged copy must degrade to "no
// catalog", never to wrong limits or prices.

const fs = require('fs');
const path = require('path');

const DEFAULT_CATALOG_PATH = path.join(__dirname, '..', '..', 'config', 'api-provider-catalog.json');
const MAX_TOKENS = 10_000_000;
const MAX_PRICE_PER_MTOK = 10_000;
const PRICE_FIELDS = ['input', 'output', 'cache_read', 'cache_write'];

const positiveInt = (value) => (Number.isInteger(value) && value > 0 && value <= MAX_TOKENS ? value : undefined);
const price = (value) => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_PRICE_PER_MTOK ? value : undefined
);

function normalizeCost(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const cost = {};
  for (const field of PRICE_FIELDS) {
    const value = price(raw[field]);
    if (value !== undefined) cost[field] = value;
  }
  return cost.input !== undefined && cost.output !== undefined ? cost : null;
}

// camelCase like the preset and discovery rows the limits chain reads.
function normalizeRow(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 200) return null;
  const contextLength = positiveInt(raw.context_length);
  if (!contextLength) return null;
  const row = { id: raw.id, contextLength };
  const maxOutputTokens = positiveInt(raw.max_output_tokens);
  if (maxOutputTokens) row.maxOutputTokens = Math.min(maxOutputTokens, contextLength);
  for (const key of ['tools', 'vision', 'reasoning']) {
    if (typeof raw[key] === 'boolean') row[key] = raw[key];
  }
  const cost = normalizeCost(raw.cost_per_mtok_usd);
  if (cost) row.costPerMtokUsd = cost;
  return row;
}

function parseCatalog(text) {
  const parsed = JSON.parse(text);
  if (!parsed || parsed.schema_version !== 1 || !parsed.providers || typeof parsed.providers !== 'object') {
    throw new Error('api-provider catalog: unsupported shape');
  }
  const providers = new Map();
  for (const [presetId, rows] of Object.entries(parsed.providers)) {
    const byId = new Map();
    for (const raw of Array.isArray(rows) ? rows : []) {
      const row = normalizeRow(raw);
      if (row && !byId.has(row.id)) byId.set(row.id, Object.freeze(row));
    }
    providers.set(presetId, byId);
  }
  return providers;
}

function createApiProviderCatalog({ catalogPath = DEFAULT_CATALOG_PATH, readFileSync = fs.readFileSync } = {}) {
  let providers = null;
  function load() {
    if (providers) return providers;
    try {
      providers = parseCatalog(readFileSync(catalogPath, 'utf8'));
    } catch (_error) {
      providers = new Map();
    }
    return providers;
  }
  return {
    // The row for an exact preset/model id pair, or null.
    lookup(presetId, modelId) {
      if (typeof presetId !== 'string' || typeof modelId !== 'string') return null;
      return load().get(presetId)?.get(modelId) || null;
    },
    size() {
      let count = 0;
      for (const rows of load().values()) count += rows.size;
      return count;
    },
  };
}

let defaultCatalog = null;
function defaultApiProviderCatalog() {
  if (!defaultCatalog) defaultCatalog = createApiProviderCatalog();
  return defaultCatalog;
}

module.exports = { createApiProviderCatalog, defaultApiProviderCatalog, parseCatalog };
