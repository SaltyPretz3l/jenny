'use strict';

// Normalizer and pure helpers for the `apiProviders` shell-config block
// (row 78). The config is user-editable JSON, so every field is re-checked
// here and anything invalid is dropped rather than repaired into something
// that looks trusted. The async DNS check for plain-http endpoints belongs to
// the writer; this module only shape-checks.

const { parseProviderEndpoint } = require('./api-provider-endpoint');
const {
  API_PROVIDER_TRANSPORT_AUTH,
  API_PROVIDER_TRANSPORTS,
  getApiProviderPreset,
} = require('./api-provider-presets');

const MAX_INSTANCES = 16;
const MAX_DISCOVERED_ROWS = 256;
const MAX_ENABLED_MODELS = 64;
const MAX_MODEL_ID_CHARS = 200;
const MAX_URL_CHARS = 2048;
const MAX_LABEL_CHARS = 64;
const MAX_HEADER_VALUE_CHARS = 256;
const MAX_LIMIT_TOKENS = 10_000_000;
const INSTANCE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
// Mirrors RESERVED_PROVIDER_IDS in sidecar/ai/engines/provider_descriptor_v6.py.
const RESERVED_INSTANCE_IDS = Object.freeze([
  'anthropic', 'openai', 'gemini', 'chatgpt', 'codex-cli', 'ollama', 'vllm',
  'openai-compatible', 'mock', 'replay', 'api-provider',
]);
const TOKEN_LIMIT_FIELDS = Object.freeze(['max_tokens', 'max_completion_tokens']);
const HEADER_ALLOWLIST = Object.freeze({ 'http-referer': 'HTTP-Referer', 'x-title': 'X-Title' });
const API_PROVIDER_MODEL_PREFIX = 'api-provider/';
// eslint-disable-next-line no-control-regex -- refusing control characters is the point.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ERROR_CODE_RE = /^[a-z][a-z_]{0,39}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function positiveLimit(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_LIMIT_TOKENS ? value : undefined;
}

function boundedText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max && !CONTROL_RE.test(text) ? text : null;
}

function validModelId(value) {
  return boundedText(value, MAX_MODEL_ID_CHARS);
}

function isoOrNull(value) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
}

// Discovery rows carry only the closed field set; anything else is never copied.
function normalizeDiscoveryRow(raw) {
  if (!isObject(raw)) return null;
  const id = validModelId(raw.id);
  if (!id) return null;
  const row = { id };
  const contextLength = positiveLimit(raw.contextLength);
  const maxOutputTokens = positiveLimit(raw.maxOutputTokens);
  if (contextLength) row.contextLength = contextLength;
  if (maxOutputTokens) row.maxOutputTokens = maxOutputTokens;
  for (const key of ['tools', 'vision', 'reasoning']) {
    if (typeof raw[key] === 'boolean') row[key] = raw[key];
  }
  return row;
}

function normalizeHeaders(raw) {
  const headers = [];
  const seen = new Set();
  for (const row of Array.isArray(raw) ? raw : []) {
    const lookup = String(isObject(row) ? row.name : '').trim().toLowerCase();
    // Own keys only: `constructor` or `__proto__` must not resolve through the prototype.
    const name = Object.hasOwn(HEADER_ALLOWLIST, lookup) ? HEADER_ALLOWLIST[lookup] : '';
    const value = boundedText(isObject(row) ? row.value : null, MAX_HEADER_VALUE_CHARS);
    if (!name || seen.has(name) || !value || /[{}]/.test(value)) continue;
    seen.add(name);
    headers.push({ name, value });
  }
  return headers;
}

function normalizePin(raw) {
  const pin = {};
  if (!isObject(raw)) return pin;
  const contextLength = positiveLimit(raw.contextLength);
  const maxOutputTokens = positiveLimit(raw.maxOutputTokens);
  if (contextLength) pin.contextLength = contextLength;
  if (maxOutputTokens && (!contextLength || maxOutputTokens <= contextLength)) pin.maxOutputTokens = maxOutputTokens;
  return pin;
}

function normalizeModels(raw) {
  const models = [];
  const seen = new Set();
  let enabledCount = 0;
  for (const row of Array.isArray(raw) ? raw : []) {
    const id = isObject(row) ? validModelId(row.id) : null;
    if (!id || seen.has(id)) continue;
    if (models.length >= MAX_DISCOVERED_ROWS) break;
    seen.add(id);
    const enabled = row.enabled === true && enabledCount < MAX_ENABLED_MODELS;
    if (enabled) enabledCount += 1;
    models.push({ id, enabled, pin: normalizePin(row.pin) });
  }
  return models;
}

function normalizeDiscoveryError(raw) {
  if (!isObject(raw) || typeof raw.code !== 'string' || !ERROR_CODE_RE.test(raw.code)) return null;
  const error = { code: raw.code };
  if (Number.isInteger(raw.status) && raw.status >= 100 && raw.status <= 599) error.status = raw.status;
  return error;
}

function normalizeDiscovery(raw) {
  const source = isObject(raw) ? raw : {};
  const rows = [];
  const seen = new Set();
  for (const candidate of Array.isArray(source.rows) ? source.rows : []) {
    const row = normalizeDiscoveryRow(candidate);
    if (!row || seen.has(row.id)) continue;
    if (rows.length >= MAX_DISCOVERED_ROWS) break;
    seen.add(row.id);
    rows.push(row);
  }
  return { fetchedAt: isoOrNull(source.fetchedAt), rows, error: normalizeDiscoveryError(source.error) };
}

function presetConnection(preset) {
  return {
    endpoint: preset.endpoint,
    transport: preset.transport,
    authProfile: preset.authProfile,
    tokenLimitField: preset.tokenLimitField,
    headers: preset.headers.map((header) => ({ ...header })),
  };
}

function customConnection(raw) {
  let endpoint;
  try {
    endpoint = parseProviderEndpoint(raw.endpoint).normalized;
  } catch (_error) {
    return null;
  }
  const tokenLimitField = raw.tokenLimitField === undefined ? 'max_tokens' : raw.tokenLimitField;
  if (!API_PROVIDER_TRANSPORTS.includes(raw.transport)
    || !API_PROVIDER_TRANSPORT_AUTH[raw.transport].includes(raw.authProfile)
    || !TOKEN_LIMIT_FIELDS.includes(tokenLimitField)) return null;
  return {
    endpoint,
    transport: raw.transport,
    authProfile: raw.authProfile,
    tokenLimitField,
    headers: normalizeHeaders(raw.headers),
  };
}

function normalizeInstance(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string') return null;
  if (!INSTANCE_ID_RE.test(raw.id) || RESERVED_INSTANCE_IDS.includes(raw.id)) return null;
  const isCustom = raw.presetId === null || raw.presetId === undefined || raw.presetId === 'custom';
  const preset = isCustom ? null : getApiProviderPreset(raw.presetId);
  if (!isCustom && !preset) return null;
  const label = boundedText(raw.label, MAX_LABEL_CHARS) || (preset && preset.label);
  const connection = preset ? presetConnection(preset) : customConnection(raw);
  if (!label || !connection) return null;
  return {
    id: raw.id,
    presetId: preset ? preset.id : null,
    label,
    ...connection,
    models: normalizeModels(raw.models),
    discovery: normalizeDiscovery(raw.discovery),
    noticeAcknowledgedAt: isoOrNull(raw.noticeAcknowledgedAt),
  };
}

function enabledModels(instance) {
  return (instance && Array.isArray(instance.models) ? instance.models : []).filter((model) => model.enabled);
}

function findInstance(config, id) {
  const list = config && Array.isArray(config.instances) ? config.instances : [];
  return list.find((instance) => instance.id === id) || null;
}

function normalizeLastSelected(raw, config) {
  if (!isObject(raw)) return null;
  const instance = findInstance(config, raw.instanceId);
  if (!instance || !enabledModels(instance).some((model) => model.id === raw.modelId)) return null;
  return { instanceId: instance.id, modelId: raw.modelId };
}

function normalizeApiProvidersConfig(raw) {
  const source = isObject(raw) ? raw : {};
  const instances = [];
  const seen = new Set();
  for (const candidate of Array.isArray(source.instances) ? source.instances : []) {
    const instance = normalizeInstance(candidate);
    if (!instance || seen.has(instance.id)) continue;
    if (instances.length >= MAX_INSTANCES) break;
    seen.add(instance.id);
    instances.push(instance);
  }
  const config = { instances, lastSelected: null };
  config.lastSelected = normalizeLastSelected(source.lastSelected, config);
  return config;
}

function generateInstanceId(base, existingIds = []) {
  const taken = new Set([...existingIds, ...RESERVED_INSTANCE_IDS]);
  let slug = String(base || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '');
  slug = slug.slice(0, 28).replace(/-+$/, '');
  if (slug.length < 2) slug = 'provider';
  let candidate = slug;
  for (let n = 2; taken.has(candidate); n += 1) {
    const suffix = `-${n}`;
    candidate = slug.slice(0, 31 - suffix.length).replace(/-+$/, '') + suffix;
  }
  return candidate;
}

function namespacedModelId(instanceId, modelId) {
  return `${API_PROVIDER_MODEL_PREFIX}${instanceId}/${modelId}`;
}

// The model id may itself contain '/', so only the first segment is the instance.
function parseNamespacedModelId(value) {
  if (typeof value !== 'string' || !value.startsWith(API_PROVIDER_MODEL_PREFIX)) return null;
  const rest = value.slice(API_PROVIDER_MODEL_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const instanceId = rest.slice(0, slash);
  const modelId = rest.slice(slash + 1);
  if (!INSTANCE_ID_RE.test(instanceId) || modelId !== validModelId(modelId)) return null;
  return { instanceId, modelId };
}

function catalogRowToDescriptor(row) {
  return {
    id: row.id,
    context_length: row.contextLength,
    max_output_tokens: row.maxOutputTokens,
    tools: row.tools,
    vision: row.vision,
    reasoning: row.reasoning,
  };
}

function buildProviderDescriptor(instance) {
  const preset = getApiProviderPreset(instance.presetId);
  return {
    descriptor_schema_version: 6,
    provider_id: instance.id,
    label: instance.label,
    endpoint: instance.endpoint,
    transport: instance.transport,
    auth_profile: instance.authProfile,
    token_limit_field: instance.tokenLimitField,
    headers: instance.headers.map((header) => ({ name: header.name, value: header.value })),
    model_catalog: preset ? preset.modelCatalog.map(catalogRowToDescriptor) : [],
  };
}

module.exports = {
  API_PROVIDER_MODEL_PREFIX,
  INSTANCE_ID_RE,
  MAX_DISCOVERED_ROWS,
  MAX_ENABLED_MODELS,
  MAX_INSTANCES,
  MAX_LABEL_CHARS,
  MAX_LIMIT_TOKENS,
  MAX_MODEL_ID_CHARS,
  MAX_URL_CHARS,
  RESERVED_INSTANCE_IDS,
  buildProviderDescriptor,
  enabledModels,
  findInstance,
  generateInstanceId,
  namespacedModelId,
  normalizeApiProvidersConfig,
  normalizeDiscoveryRow,
  normalizeHeaders,
  parseNamespacedModelId,
  positiveLimit,
  validModelId,
};
