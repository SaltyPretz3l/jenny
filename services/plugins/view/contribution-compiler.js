'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const { validate } = require('../contracts/generated-plugin-contracts');
const { STAGE7_LIMITS } = require('./stage7-budgets');

const VIEW_KINDS = Object.freeze(['setup_scene', 'panel', 'artifact_renderer']);
const VIEW_KIND_SET = new Set(VIEW_KINDS);
const PROVIDER_KIND = 'provider_descriptor';
const OFFICIAL_PUBLISHER_ID = 'jenny-official';
const BUILTIN_ARTIFACT_KINDS = new Set(['html', 'image', 'markdown', 'mermaid', 'text']);
const PROVIDER_BRIDGE_OPERATIONS = new Set([
  'provider_auth_status', 'provider_auth_start', 'provider_auth_cancel',
  'provider_auth_sign_out', 'provider_activate',
]);

function fail(reason, detail = null) { return { ok: false, reason, detail }; }

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0')) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && !normalized.startsWith('../') && normalized !== '..'
    && !path.posix.isAbsolute(normalized);
}

function parseContributionContent(text, contractName) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (_error) { return fail('content_json_invalid'); }
  const checked = validate(contractName, parsed);
  return checked.ok ? { ok: true, value: checked.value } : fail('content_contract_invalid', checked.error);
}

function validateViewSemantics(content, contribution, authority = {}) {
  if (content.view_kind !== contribution.kind) return fail('view_kind_mismatch');
  if (!isSafeRelativePath(content.entry_path)) return fail('view_entry_path_unsafe');
  const byPath = new Map();
  let totalBytes = 0;
  for (const asset of content.assets) {
    if (!isSafeRelativePath(asset.path)) return fail('view_asset_path_unsafe', { path: asset.path });
    totalBytes += asset.bytes;
    if (asset.bytes > STAGE7_LIMITS.asset_bytes || totalBytes > STAGE7_LIMITS.view_bytes) {
      return fail('view_asset_budget_exceeded');
    }
    byPath.set(asset.path, asset);
  }
  const entry = byPath.get(content.entry_path);
  if (!entry || entry.sha256 !== content.entry_sha256 || entry.media_type !== 'text/html') {
    return fail('view_entry_asset_mismatch');
  }
  const operations = new Set(content.allowed_bridge_operations);
  if (operations.size !== content.allowed_bridge_operations.length) return fail('view_bridge_operation_duplicate');
  const topics = new Set(content.allowed_event_topics);
  if (topics.size !== content.allowed_event_topics.length) return fail('view_event_topic_duplicate');
  if (content.view_kind === 'artifact_renderer') {
    if (content.artifact_kinds.length === 0) return fail('artifact_kind_missing');
    for (const kind of content.artifact_kinds) {
      const [namespace] = kind.split(':');
      if (namespace !== contribution.plugin_id || BUILTIN_ARTIFACT_KINDS.has(kind)) {
        return fail('artifact_kind_not_namespaced');
      }
    }
  } else if (content.artifact_kinds.length > 0) return fail('artifact_kind_not_allowed');
  if (content.view_kind === 'setup_scene' && !content.provider_ref) return fail('setup_provider_ref_missing');
  if (content.view_kind !== 'setup_scene' && content.provider_ref) return fail('provider_ref_not_allowed');
  const usesProviderBridge = [...operations].some((operation) => PROVIDER_BRIDGE_OPERATIONS.has(operation))
    || topics.has('provider_auth_changed');
  if (usesProviderBridge && content.view_kind !== 'setup_scene') {
    return fail('provider_bridge_setup_scene_required');
  }
  if (usesProviderBridge && (authority.publisherId !== OFFICIAL_PUBLISHER_ID
    || !authority.officialKeyId || authority.publisherKeyId !== authority.officialKeyId)) {
    return fail('provider_bridge_not_official_current_key');
  }
  return { ok: true, totalBytes };
}

function compileStage7Contributions({ manifest, contentTexts, artifactDigest, publisherKeyId, officialKeyId }) {
  if (manifest?.manifest_schema_version !== 5 || !Array.isArray(manifest.contributions)) {
    return fail('stage7_manifest_required');
  }
  const textById = new Map((contentTexts || []).map((item) => [item.contribution_id, item.content_json]));
  const views = [];
  const providers = [];
  let pluginViewBytes = 0;
  for (const contribution of manifest.contributions) {
    const authority = {
      publisher_id: manifest.publisher_id,
      plugin_id: manifest.plugin_id,
      contribution_id: contribution.contribution_id,
      artifact_digest: artifactDigest,
      content_digest: contribution.content_sha256,
    };
    if (VIEW_KIND_SET.has(contribution.kind)) {
      const parsed = parseContributionContent(textById.get(contribution.contribution_id), 'PluginViewContentV5');
      if (!parsed.ok) return parsed;
      const semantic = validateViewSemantics(
        parsed.value,
        { ...contribution, plugin_id: manifest.plugin_id },
        { publisherId: manifest.publisher_id, publisherKeyId, officialKeyId },
      );
      if (!semantic.ok) return semantic;
      pluginViewBytes += semantic.totalBytes;
      if (pluginViewBytes > STAGE7_LIMITS.plugin_view_bytes) return fail('plugin_view_budget_exceeded');
      views.push(Object.freeze({ ...authority, kind: contribution.kind, content: parsed.value }));
      continue;
    }
    if (contribution.kind === PROVIDER_KIND) {
      if (manifest.publisher_id !== OFFICIAL_PUBLISHER_ID || !officialKeyId || publisherKeyId !== officialKeyId) {
        return fail('provider_descriptor_not_official_current_key');
      }
      const text = textById.get(contribution.contribution_id);
      const parsed = parseContributionContent(text, 'PluginProviderDescriptorV5');
      if (!parsed.ok) return parsed;
      if (parsed.value.core_adapters.length !== 2
        || new Set(parsed.value.core_adapters).size !== 2) return fail('provider_core_adapters_incomplete');
      if (createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
        !== contribution.content_sha256) return fail('provider_content_digest_mismatch');
      providers.push(Object.freeze({ ...authority, descriptor: parsed.value, content_json: text }));
    }
  }
  return { ok: true, views: Object.freeze(views), providers: Object.freeze(providers) };
}

module.exports = {
  VIEW_KINDS,
  PROVIDER_KIND,
  OFFICIAL_PUBLISHER_ID,
  isSafeRelativePath,
  compileStage7Contributions,
};
