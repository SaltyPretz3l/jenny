'use strict';

const crypto = require('node:crypto');
const { validate } = require('../contracts/generated-plugin-contracts');
const { compileJsonSchema } = require('../remote-mcp/json-schema-validator');

const RESTRICTED_KINDS = Object.freeze(['restricted_transform', 'restricted_formatter', 'restricted_renderer', 'restricted_compute']);
const RESTRICTED_KIND_SET = new Set(RESTRICTED_KINDS);
const ABI_WORLD = 'jenny:plugin/restricted-host@1.0.0';

function fail(reason, detail = null) { return { ok: false, reason, detail }; }
function parseSchema(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? { ok: true, value } : fail('restricted_schema_not_object');
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
  const compiledInput = compileJsonSchema(input.value);
  const compiledOutput = compileJsonSchema(output.value);
  if (!compiledInput.ok || !compiledOutput.ok) {
    return fail(compiledInput.reason || compiledOutput.reason);
  }
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
  return {
    ok: true,
    value,
    input_schema: input.value,
    output_schema: output.value,
    compiled_input_schema: compiledInput,
    compiled_output_schema: compiledOutput,
  };
}

function dynamicToolName(item) {
  return `plugin:${item.publisher_id}:${item.plugin_id}:${item.contribution_id}`;
}

function compileRestrictedContributions({ manifest, contents, componentBytesByDigest, authority, abiDigest, protocolDigest } = {}) {
  if (manifest?.manifest_schema_version !== 4 || !Array.isArray(contents) || manifest.contributions.length !== 1) {
    return fail('restricted_package_shape_unsupported');
  }
  const descriptors = [];
  for (const contribution of manifest.contributions) {
    if (!RESTRICTED_KIND_SET.has(contribution.kind)) return fail('restricted_contribution_kind_unsupported');
    const content = contents.find((item) => item.contribution_id === contribution.contribution_id);
    const checked = validateRestrictedContent(content, { manifest, contribution });
    if (!checked.ok) return checked;
    const bytes = componentBytesByDigest?.get(contribution.component_sha256);
    if (!Buffer.isBuffer(bytes) || crypto.createHash('sha256').update(bytes).digest('hex') !== contribution.component_sha256) {
      return fail('restricted_component_digest_mismatch');
    }
    descriptors.push(Object.freeze({
      publisher_id: manifest.publisher_id, plugin_id: manifest.plugin_id,
      contribution_id: contribution.contribution_id, display_name: contribution.name,
      kind: contribution.kind, namespaced_name: dynamicToolName({ ...manifest, ...contribution }),
      description: checked.value.payload.description, input_schema_json: checked.value.payload.input_schema_json,
      output_schema_json: checked.value.payload.output_schema_json, timeout_ms: checked.value.payload.timeout_ms,
      network_origins: Object.freeze([...checked.value.payload.network_origins]),
      compiled_input_schema: checked.compiled_input_schema,
      compiled_output_schema: checked.compiled_output_schema,
      capabilities: Object.freeze([...checked.value.payload.capabilities]), artifact_digest: authority.artifact_digest,
      component_digest: contribution.component_sha256, content_digest: contribution.content_sha256,
      generation_id: authority.generation_id, commit_epoch: authority.commit_epoch,
      lifecycle_epoch: authority.lifecycle_epoch, policy_revision: authority.policy_revision,
      workspace_incarnation_id: authority.workspace_incarnation_id, abi_digest: abiDigest,
      protocol_digest: protocolDigest,
    }));
  }
  return { ok: true, descriptors: Object.freeze(descriptors) };
}

module.exports = {
  RESTRICTED_KINDS, RESTRICTED_KIND_SET, ABI_WORLD, parseSchema,
  validateRestrictedContent, dynamicToolName, compileRestrictedContributions,
};
