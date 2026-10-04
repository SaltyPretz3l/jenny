'use strict';

// The restricted (Wasm) tier is retired and executes nothing. Packages that
// declare its four contribution kinds can still be installed on disk from an
// earlier release, and every install reverifies every installed package, so
// the kind list and the content check used during package verification stay.

const { validate } = require('../contracts/generated-plugin-contracts');

const RESTRICTED_KINDS = Object.freeze([
  'restricted_transform', 'restricted_formatter', 'restricted_renderer', 'restricted_compute',
]);
const RESTRICTED_KIND_SET = new Set(RESTRICTED_KINDS);
const ABI_WORLD = 'jenny:plugin/restricted-host@1.0.0';

function fail(reason, detail = null) { return { ok: false, reason, detail }; }

function parseSchema(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ok: true, value }
      : fail('restricted_schema_not_object');
  } catch (_error) { return fail('restricted_schema_json_invalid'); }
}

function validateRestrictedContent(content, { manifest, contribution } = {}) {
  const checked = validate('PluginRestrictedContentV4', content);
  if (!checked.ok) return fail('restricted_content_invalid', checked.error);
  const value = checked.value;
  if (!manifest || !contribution || value.publisher_id !== manifest.publisher_id
    || value.plugin_id !== manifest.plugin_id || value.contribution_id !== contribution.contribution_id
    || value.payload.kind !== contribution.kind || contribution.abi_world !== ABI_WORLD) {
    return fail('restricted_content_authority_mismatch');
  }
  const input = parseSchema(value.payload.input_schema_json);
  const output = parseSchema(value.payload.output_schema_json);
  if (!input.ok || !output.ok) return fail(input.reason || output.reason);
  const permissions = new Set(manifest.requested_permissions || []);
  if (value.payload.capabilities.includes('network.request') && !permissions.has('network.restricted_runtime')) {
    return fail('restricted_network_permission_missing');
  }
  if (value.payload.capabilities.includes('network.request')
    !== (value.payload.network_origins.length === 1)) {
    return fail('restricted_network_origin_mismatch');
  }
  if (value.payload.capabilities.includes('secret.use_handle') && !permissions.has('secret.brokered_use')) {
    return fail('restricted_secret_permission_missing');
  }
  return { ok: true, value, input_schema: input.value, output_schema: output.value };
}

module.exports = {
  RESTRICTED_KINDS, RESTRICTED_KIND_SET, ABI_WORLD, validateRestrictedContent,
};
