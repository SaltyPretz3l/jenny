'use strict';

const { CONFIG_ERROR_CODES } = require('./backend/error-codes');

const PROVIDERS = Object.freeze(['chatgpt', 'codex-cli']);
const EFFORTS = new Set(['', 'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_IDS = {
  chatgpt: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/,
  'codex-cli': /^(?:codex-cli\/)?[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/,
};
const MAX_PREFERRED_MODELS = 16;
const ROUTING_FIELDS = ['defaultModel', 'defaultEffort', 'preferredModels', 'allowedModels', 'maxEffort'];
const CAP_EFFORTS = new Set(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const LIST_FIELDS = ['allowedModels', 'preferredModels'];
// Deliberately not value-utils isPlainObject: its prototype check rejects a patch built in another realm (the jsdom renderer harness).
const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const validModel = (value, provider) => typeof value === 'string' && (value === '' || MODEL_IDS[provider].test(value));

function normalizeSubagentRouting(value) {
  const source = isPlainObject(value) ? value : {};
  return Object.fromEntries(PROVIDERS.map((provider) => {
    const row = isPlainObject(source[provider]) ? source[provider] : {};
    return [provider, {
      defaultModel: validModel(row.defaultModel, provider) ? row.defaultModel : '',
      defaultEffort: EFFORTS.has(row.defaultEffort) ? row.defaultEffort : '',
      maxEffort: CAP_EFFORTS.has(row.maxEffort) ? row.maxEffort : '',
      ...Object.fromEntries(LIST_FIELDS.map((field) => [field,
        [...new Set((Array.isArray(row[field]) ? row[field] : [])
          .filter((id) => validModel(id, provider) && id))].slice(0, MAX_PREFERRED_MODELS)])),
    }];
  }));
}

function applySubagentRoutingPatch(current, patch) {
  const invalid = () => { throw Object.assign(new Error('Subagent routing settings are invalid.'), { code: CONFIG_ERROR_CODES.INVALID }); };
  if (!isPlainObject(patch) || Object.keys(patch).some((key) => !PROVIDERS.includes(key))) invalid();
  const next = normalizeSubagentRouting(current);
  for (const [provider, row] of Object.entries(patch)) {
    if (!isPlainObject(row) || Object.keys(row).some((key) => !ROUTING_FIELDS.includes(key))) invalid();
    if (Object.hasOwn(row, 'defaultModel') && !validModel(row.defaultModel, provider)) invalid();
    if (Object.hasOwn(row, 'defaultEffort') && !EFFORTS.has(row.defaultEffort)) invalid();
    if (Object.hasOwn(row, 'maxEffort') && !CAP_EFFORTS.has(row.maxEffort)) invalid();
    for (const field of LIST_FIELDS) {
      if (Object.hasOwn(row, field) && (!Array.isArray(row[field])
        || row[field].length > MAX_PREFERRED_MODELS || row[field].some((id) => !validModel(id, provider) || !id))) invalid();
    }
    next[provider] = { ...next[provider], ...row };
  }
  return normalizeSubagentRouting(next);
}

module.exports = { PROVIDERS, MAX_PREFERRED_MODELS, normalizeSubagentRouting, applySubagentRoutingPatch };
