'use strict';

const crypto = require('node:crypto');
const semver = require('semver');
const { PUBLISHER_ID_RE, PLUGIN_ID_RE } = require('../identity/authority-id');

const SOURCE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const TARGET_PATH_RE = /^(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^\0]{1,1024}$/;
const MAX_TARGET_BYTES = 1024 * 1024 * 1024;

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed, required) {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.includes(key));
}

function validRemoteUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      && !parsed.search && !parsed.hash;
  } catch (_error) { return false; }
}

function validatePinnedRoot(value, expectedFingerprint) {
  if (typeof value !== 'string' || value.length > 1398104
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  try {
    const bytes = Buffer.from(value, 'base64');
    const root = JSON.parse(bytes.toString('utf8'));
    const type = String(root?.signed?._type || root?.signed?.type || '').toLowerCase();
    return bytes.length > 0 && type === 'root'
      && crypto.createHash('sha256').update(bytes).digest('hex') === expectedFingerprint;
  } catch (_error) { return false; }
}

function validateCatalogSource(value) {
  if (!plainObject(value) || value.catalog_source_schema_version !== 1
    || !SOURCE_ID_RE.test(String(value.source_id || ''))
    || !['remote', 'offline_mirror'].includes(value.kind)
    || typeof value.display_name !== 'string' || !value.display_name.trim()
    || value.display_name.length > 128 || !SHA256_RE.test(String(value.root_fingerprint || ''))) {
    return { ok: false, reason: 'catalog_source_invalid' };
  }
  const common = ['catalog_source_schema_version', 'source_id', 'kind', 'display_name',
    'root_fingerprint', 'pinned_root_base64'];
  if (!validatePinnedRoot(value.pinned_root_base64, value.root_fingerprint)) {
    return { ok: false, reason: 'catalog_root_invalid' };
  }
  if (value.kind === 'remote') {
    const allowed = [...common, 'metadata_base_url', 'target_base_url'];
    if (!exactKeys(value, allowed, allowed)
      || !validRemoteUrl(value.metadata_base_url) || !validRemoteUrl(value.target_base_url)) {
      return { ok: false, reason: 'remote_catalog_source_invalid' };
    }
  } else if (!exactKeys(value, [...common, 'real_root'], [...common, 'real_root'])
    || typeof value.real_root !== 'string' || value.real_root.length > 4096) {
    return { ok: false, reason: 'offline_catalog_source_invalid' };
  }
  return { ok: true, value: { ...value, display_name: value.display_name.trim() } };
}

function validateCatalogEntry(value) {
  const keys = ['catalog_entry_schema_version', 'source_id', 'publisher_id', 'plugin_id',
    'display_name', 'version', 'summary', 'package_size_bytes', 'package_sha256', 'target_path'];
  if (!plainObject(value) || !exactKeys(value, keys, keys)
    || value.catalog_entry_schema_version !== 1
    || !SOURCE_ID_RE.test(String(value.source_id || ''))
    || !PUBLISHER_ID_RE.test(String(value.publisher_id || ''))
    || !PLUGIN_ID_RE.test(String(value.plugin_id || ''))
    || typeof value.display_name !== 'string' || !value.display_name.trim()
    || value.display_name.length > 128 || typeof value.summary !== 'string'
    || value.summary.length > 512 || !semver.valid(value.version)
    || !Number.isSafeInteger(value.package_size_bytes) || value.package_size_bytes < 1
    || value.package_size_bytes > MAX_TARGET_BYTES
    || !SHA256_RE.test(String(value.package_sha256 || ''))
    || !TARGET_PATH_RE.test(String(value.target_path || ''))) {
    return { ok: false, reason: 'catalog_entry_invalid' };
  }
  return { ok: true, value: { ...value, display_name: value.display_name.trim() } };
}

function catalogEntryFromTarget(sourceId, targetPath, target) {
  const custom = plainObject(target?.custom) ? target.custom : {};
  const hashes = plainObject(target?.hashes) ? target.hashes : {};
  return validateCatalogEntry({
    catalog_entry_schema_version: 1,
    source_id: sourceId,
    publisher_id: custom.publisher_id,
    plugin_id: custom.plugin_id,
    display_name: custom.display_name,
    version: custom.version,
    summary: custom.summary || '',
    package_size_bytes: target?.length,
    package_sha256: hashes.sha256,
    target_path: targetPath,
  });
}

function publicCatalogEntry(entry) {
  return {
    source_id: entry.source_id, publisher_id: entry.publisher_id, plugin_id: entry.plugin_id,
    display_name: entry.display_name, version: entry.version, summary: entry.summary,
    package_size_bytes: entry.package_size_bytes, package_sha256: entry.package_sha256,
  };
}

module.exports = {
  MAX_TARGET_BYTES, SOURCE_ID_RE, catalogEntryFromTarget, publicCatalogEntry,
  validateCatalogSource,
};
