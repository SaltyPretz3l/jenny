const toolManifest = require('./tools/tool-manifest.json');
const { normalizeString } = require('../renderer/shared/string-utils');
const { isPlainObject } = require('./value-utils');

const TOOL_CONFIG_SCHEMA_VERSION = 2;
const FIELD_TYPES = new Set(['toggle']);
const STORAGE_MODES = new Set(['config']);

function hasOwnField(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function readManifestField(source, keys) {
  for (const key of keys) {
    if (hasOwnField(source, key)) {
      return { present: true, value: source[key] };
    }
  }
  return { present: false, value: undefined };
}

function readStringField(source, keys, { toolName, fieldName, required = false, defaultValue = '' }) {
  const { present, value } = readManifestField(source, keys);
  if (!present || value === null || value === undefined) {
    if (required) {
      throw new Error(`tool manifest entry ${toolName} config_schema ${fieldName} is required`);
    }
    return defaultValue;
  }
  if (typeof value !== 'string') {
    throw new Error(`tool manifest entry ${toolName} config_schema ${fieldName} must be a string`);
  }
  const normalized = value.trim();
  if (required && !normalized) {
    throw new Error(`tool manifest entry ${toolName} config_schema ${fieldName} is required`);
  }
  return normalized || defaultValue;
}

function cloneJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)])
    );
  }
  return value;
}

function snakeCaseKey(key) {
  return normalizeString(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function pascalCaseKey(key) {
  return normalizeString(key)
    .replace(/[_-\s]+(.)?/g, (_match, next) => (next ? next.toUpperCase() : ''))
    .replace(/^./, (first) => first.toUpperCase());
}

function normalizeToolIds(source, fallbackToolName) {
  const { present, value } = readManifestField(source, ['toolIds', 'tool_ids']);
  if (present && value !== null && value !== undefined && !Array.isArray(value)) {
    throw new Error(`tool manifest entry ${fallbackToolName} config_schema tool_ids must be a list`);
  }
  const ids = Array.isArray(value) ? value : [];
  const normalized = [];
  for (const entry of ids) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(
        `tool manifest entry ${fallbackToolName} config_schema tool_ids must contain non-empty strings`
      );
    }
    normalized.push(entry.trim());
  }
  if (!normalized.length) {
    const fallback = normalizeString(fallbackToolName);
    return fallback ? [fallback] : [];
  }
  return [...new Set(normalized)];
}

function normalizeConfigField(rawField, toolName) {
  const source = isPlainObject(rawField) ? rawField : {};
  const key = readStringField(source, ['key'], {
    toolName,
    fieldName: 'key',
    required: true,
  });
  const label = readStringField(source, ['label'], {
    toolName,
    fieldName: 'label',
    required: true,
  });
  const fieldType = readStringField(source, ['fieldType', 'field_type'], {
    toolName,
    fieldName: 'field_type',
    defaultValue: 'toggle',
  });
  const storage = readStringField(source, ['storage'], {
    toolName,
    fieldName: 'storage',
    defaultValue: 'config',
  });
  if (!FIELD_TYPES.has(fieldType)) {
    throw new Error(
      `tool manifest entry ${toolName} config_schema field_type is invalid: ${fieldType}`
    );
  }
  if (!STORAGE_MODES.has(storage)) {
    throw new Error(
      `tool manifest entry ${toolName} config_schema storage is invalid: ${storage}`
    );
  }
  const defaultValue = Object.prototype.hasOwnProperty.call(source, 'default')
    ? cloneJsonValue(source.default)
    : false;
  if (fieldType === 'toggle' && typeof defaultValue !== 'boolean') {
    throw new Error(`tool manifest entry ${toolName} config_schema default must be a bool`);
  }
  const helpText = readStringField(source, ['helpText', 'help_text'], {
    toolName,
    fieldName: 'help_text',
  });
  const configFlag = readStringField(source, ['configFlag', 'config_flag'], {
    toolName,
    fieldName: 'config_flag',
  });
  return {
    key,
    label,
    fieldType,
    storage,
    default: defaultValue,
    helpText,
    configFlag,
    toolIds: normalizeToolIds(source, toolName),
  };
}

function fieldConflictSignature(field) {
  return JSON.stringify({
    label: field.label,
    fieldType: field.fieldType,
    storage: field.storage,
    default: field.default,
    helpText: field.helpText,
    configFlag: field.configFlag,
  });
}

function mergeDuplicateField(existing, next) {
  if (fieldConflictSignature(existing) !== fieldConflictSignature(next)) {
    throw new Error(`tool config field ${next.key} has conflicting definitions`);
  }
  return {
    ...existing,
    toolIds: [...new Set([...(existing.toolIds || []), ...(next.toolIds || [])])],
  };
}

function readToolConfigSchema(tool, index) {
  if (!isPlainObject(tool)) {
    throw new Error(`tool manifest entry ${index} must be an object`);
  }
  const toolName = normalizeString(tool.name) || `entry ${index}`;
  if (!hasOwnField(tool, 'config_schema')) {
    return { toolName, configSchema: null };
  }
  if (!Array.isArray(tool.config_schema)) {
    throw new Error(`tool manifest entry ${toolName} config_schema must be a list`);
  }
  return { toolName, configSchema: tool.config_schema };
}

function buildToolConfigFieldsFromManifest(manifest = toolManifest) {
  const tools = Array.isArray(manifest?.tools) ? manifest.tools : [];
  const fieldsByKey = new Map();
  for (const [index, tool] of tools.entries()) {
    const { toolName, configSchema } = readToolConfigSchema(tool, index);
    if (!configSchema) {
      continue;
    }
    for (const rawField of configSchema) {
      const field = normalizeConfigField(rawField, toolName);
      const existing = fieldsByKey.get(field.key);
      fieldsByKey.set(field.key, existing ? mergeDuplicateField(existing, field) : field);
    }
  }
  return [...fieldsByKey.values()];
}

const TOOL_CONFIG_FIELDS = Object.freeze(
  buildToolConfigFieldsFromManifest().map((field) => Object.freeze({
    ...field,
    toolIds: Object.freeze([...field.toolIds]),
  }))
);
const TOOL_SETTING_KEYS = Object.freeze(TOOL_CONFIG_FIELDS.map((field) => field.key));
const DEFAULT_TOOL_SETTINGS = Object.freeze(getToolConfigDefaults(TOOL_CONFIG_FIELDS));

function getToolConfigFields() {
  return TOOL_CONFIG_FIELDS;
}

function getToolConfigDefaults(fields = TOOL_CONFIG_FIELDS) {
  const defaults = {};
  for (const field of Array.isArray(fields) ? fields : []) {
    const key = normalizeString(field?.key);
    if (!key) {
      continue;
    }
    defaults[key] = cloneJsonValue(field.default);
  }
  return defaults;
}

function settingAliases(key) {
  const normalized = normalizeString(key);
  const snake = snakeCaseKey(normalized);
  const sourceAliases = [normalized, `${normalized}Enabled`, `${snake}_enabled`];
  if (snake !== normalized) {
    sourceAliases.splice(1, 0, snake);
  }
  return {
    source: sourceAliases,
    legacy: [`tools${pascalCaseKey(normalized)}Enabled`, `tools_${snake}_enabled`],
  };
}

function readBooleanSetting(source, keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }
    return source[key] === true;
  }
  return null;
}

function normalizeToolSettings(value = {}, legacyState = {}, fields = TOOL_CONFIG_FIELDS) {
  const source = isPlainObject(value) ? value : {};
  const legacy = isPlainObject(legacyState) ? legacyState : {};
  const normalized = {};
  for (const field of Array.isArray(fields) ? fields : []) {
    const key = normalizeString(field?.key);
    if (!key || normalizeString(field?.fieldType) !== 'toggle') {
      continue;
    }
    const aliases = settingAliases(key);
    const sourceValue = readBooleanSetting(source, aliases.source);
    if (sourceValue !== null) {
      normalized[key] = sourceValue;
      continue;
    }
    const legacyValue = readBooleanSetting(legacy, aliases.legacy);
    normalized[key] = legacyValue !== null ? legacyValue : field.default === true;
  }
  return normalized;
}

module.exports = {
  DEFAULT_TOOL_SETTINGS,
  TOOL_CONFIG_SCHEMA_VERSION,
  TOOL_SETTING_KEYS,
  buildToolConfigFieldsFromManifest,
  getToolConfigDefaults,
  getToolConfigFields,
  normalizeToolSettings,
};
