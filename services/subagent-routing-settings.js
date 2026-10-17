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
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const validModel = (value, provider) => typeof value === 'string' && (value === '' || MODEL_IDS[provider].test(value));

function normalizeSubagentRouting(value) {
  const source = object(value) ? value : {};
  return Object.fromEntries(PROVIDERS.map((provider) => {
    const row = object(source[provider]) ? source[provider] : {};
    return [provider, {
      defaultModel: validModel(row.defaultModel, provider) ? row.defaultModel : '',
      defaultEffort: typeof row.defaultEffort === 'string' && EFFORTS.has(row.defaultEffort) ? row.defaultEffort : '',
      maxEffort: typeof row.maxEffort === 'string' && CAP_EFFORTS.has(row.maxEffort) ? row.maxEffort : '',
      allowedModels: [...new Set((Array.isArray(row.allowedModels) ? row.allowedModels : [])
        .filter((id) => validModel(id, provider) && id))].slice(0, MAX_PREFERRED_MODELS),
      preferredModels: [...new Set((Array.isArray(row.preferredModels) ? row.preferredModels : [])
        .filter((id) => validModel(id, provider) && id))].slice(0, MAX_PREFERRED_MODELS),
    }];
  }));
}

function applySubagentRoutingPatch(current, patch) {
  const invalid = () => { throw Object.assign(new Error('Subagent routing settings are invalid.'), { code: CONFIG_ERROR_CODES.INVALID }); };
  if (!object(patch) || Object.keys(patch).some((key) => !PROVIDERS.includes(key))) invalid();
  const next = normalizeSubagentRouting(current);
  for (const [provider, row] of Object.entries(patch)) {
    if (!object(row) || Object.keys(row).some((key) => !ROUTING_FIELDS.includes(key))) invalid();
    if (Object.hasOwn(row, 'defaultModel') && !validModel(row.defaultModel, provider)) invalid();
    if (Object.hasOwn(row, 'defaultEffort') && (typeof row.defaultEffort !== 'string' || !EFFORTS.has(row.defaultEffort))) invalid();
    if (Object.hasOwn(row, 'preferredModels') && (!Array.isArray(row.preferredModels)
      || row.preferredModels.length > MAX_PREFERRED_MODELS || row.preferredModels.some((id) => !validModel(id, provider) || !id))) invalid();
    if (Object.hasOwn(row, 'maxEffort') && (typeof row.maxEffort !== 'string' || !CAP_EFFORTS.has(row.maxEffort))) invalid();
    if (Object.hasOwn(row, 'allowedModels') && (!Array.isArray(row.allowedModels)
      || row.allowedModels.length > MAX_PREFERRED_MODELS || row.allowedModels.some((id) => !validModel(id, provider) || !id))) invalid();
    next[provider] = { ...next[provider], ...row };
  }
  return normalizeSubagentRouting(next);
}

module.exports = { PROVIDERS, MAX_PREFERRED_MODELS, normalizeSubagentRouting, applySubagentRoutingPatch };
