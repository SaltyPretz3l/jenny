'use strict';

const { validate } = require('../contracts/generated-plugin-contracts');
const { canonicalAuthorityTuple } = require('../identity/authority-id');
const { computeCanonicalMetadataDigest } = require('../package/canonical-metadata');
const { pluginSettingsDir } = require('../paths/store-paths');
const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');
const { isValidDigest } = require('./content-store');

function settingsDigest(value) {
  return computeCanonicalMetadataDigest(value);
}

function normalizeValues(fields, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, reason: 'settings_values_not_object' };
  }
  const known = new Map(fields.map((field) => [field.key, field]));
  if (Object.keys(values).some((key) => !known.has(key))) return { ok: false, reason: 'settings_key_unknown' };
  const normalized = [];
  for (const field of fields) {
    const value = Object.hasOwn(values, field.key) ? values[field.key] : field.default;
    const storageType = field.type === 'enum' ? 'string' : field.type;
    if (storageType === 'boolean' && typeof value !== 'boolean') return { ok: false, reason: 'settings_type_mismatch' };
    if (storageType === 'integer' && (!Number.isInteger(value) || value < field.minimum || value > field.maximum)) {
      return { ok: false, reason: 'settings_integer_out_of_range' };
    }
    if (storageType === 'string' && (typeof value !== 'string'
      || Buffer.byteLength(value, 'utf8') > (field.max_length ?? 64))) {
      return { ok: false, reason: 'settings_string_out_of_range' };
    }
    if (field.type === 'enum' && !field.values.includes(value)) return { ok: false, reason: 'settings_enum_invalid' };
    normalized.push({ type: storageType, key: field.key, value });
  }
  return { ok: true, values: normalized };
}

async function writeSettingsState(facade, baseDir, {
  publisherId, pluginId, contributionId, schemaDigest, revision, fields, values, now,
}) {
  const authority = canonicalAuthorityTuple({ publisherId, pluginId, contributionId });
  if (!authority.ok) {
    return { ok: false, reason: 'settings_authority_invalid' };
  }
  const normalized = normalizeValues(fields, values);
  if (!normalized.ok) return normalized;
  const candidate = {
    settings_state_schema_version: 2,
    publisher_id: publisherId,
    plugin_id: pluginId,
    contribution_id: contributionId,
    schema_digest: schemaDigest,
    revision,
    updated_at: now,
    values: normalized.values,
  };
  const checked = validate('PluginSettingsStateV2', candidate);
  if (!checked.ok) return { ok: false, reason: 'settings_state_invalid', detail: checked.error };
  const digest = settingsDigest(checked.value);
  const dirPath = pluginSettingsDir(baseDir, publisherId, pluginId);
  const fileName = `${digest}.json`;
  const existing = await readJsonFile(facade, joinPath(dirPath, fileName));
  if (existing.status === 'corrupted') return { ok: false, reason: 'settings_state_corrupted' };
  if (existing.status === 'missing') await writeJsonFileAtomic(facade, dirPath, fileName, checked.value);
  else if (settingsDigest(existing.value) !== digest) return { ok: false, reason: 'settings_state_digest_mismatch' };
  return { ok: true, digest, revision, state: checked.value };
}

async function readSettingsState(facade, baseDir, {
  publisherId, pluginId, contributionId, digest,
}) {
  if (!isValidDigest(digest)) return { ok: false, reason: 'settings_digest_invalid' };
  const filePath = joinPath(pluginSettingsDir(baseDir, publisherId, pluginId), `${digest}.json`);
  const read = await readJsonFile(facade, filePath);
  if (read.status !== 'ok') return { ok: false, reason: `settings_state_${read.status}` };
  if (settingsDigest(read.value) !== digest) return { ok: false, reason: 'settings_state_digest_mismatch' };
  const checked = validate('PluginSettingsStateV2', read.value);
  if (!checked.ok) return { ok: false, reason: 'settings_state_invalid' };
  if (checked.value.publisher_id !== publisherId || checked.value.plugin_id !== pluginId
    || (contributionId && checked.value.contribution_id !== contributionId)) {
    return { ok: false, reason: 'settings_state_authority_mismatch' };
  }
  return { ok: true, state: checked.value };
}

module.exports = { settingsDigest, normalizeValues, writeSettingsState, readSettingsState };
