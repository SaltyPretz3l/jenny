'use strict';

const { createHash } = require('node:crypto');

const MAX_DYNAMIC_TOOLS = 256;
const MAX_AUTHORITY_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_NAME_CHARS = 256;
const AUTHORITY_FIELDS = Object.freeze([
  'registry_revision',
  'dependency_graph_hash',
  'commit_epoch',
  'active_generation_id',
]);

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cleanText(value, maxChars = MAX_TOOL_NAME_CHARS) {
  const text = typeof value === 'string' ? value.trim() : '';
  // eslint-disable-next-line no-control-regex -- authority tokens reject control bytes.
  return text && text.length <= maxChars && !/[\u0000-\u001f\u007f]/u.test(text) ? text : '';
}

function digestText(value) {
  return /^[0-9a-f]{64}$/u.test(String(value || '')) ? String(value) : '';
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function authorityFingerprint(value) {
  if (!isRecord(value) || (value.mode !== undefined && value.mode !== 'plugin')
    || !Number.isSafeInteger(value.registry_revision) || value.registry_revision < 0
    || !Number.isSafeInteger(value.commit_epoch) || value.commit_epoch < 0
    || !digestText(value.dependency_graph_hash)
    || !cleanText(value.active_generation_id, 64)) return null;
  return Object.freeze({
    mode: 'plugin',
    registry_revision: value.registry_revision,
    dependency_graph_hash: value.dependency_graph_hash,
    commit_epoch: value.commit_epoch,
    active_generation_id: value.active_generation_id,
  });
}

function fingerprintsMatch(left, right) {
  return Boolean(left && right && AUTHORITY_FIELDS.every((field) => left[field] === right[field]));
}

function requiredText(value, label, maxChars = MAX_TOOL_NAME_CHARS) {
  const text = cleanText(value, maxChars);
  if (!text) throw new Error(`Plugin tool ${label} is invalid.`);
  return text;
}

function requiredDigest(value, label) {
  const digest = digestText(value);
  if (!digest) throw new Error(`Plugin tool ${label} is invalid.`);
  return digest;
}

function requiredInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Plugin tool ${label} is invalid.`);
  }
  return value;
}

function policyDescriptor({ name, sideEffecting, sourceKind, identity }) {
  return Object.freeze({
    name,
    side_effecting: sideEffecting,
    read_only: !sideEffecting,
    tool_family: 'other',
    source_kind: sourceKind,
    server_name: 'electron_tool_bridge',
    plan_mode_only: false,
    workspace_required: false,
    capability_identity: Object.freeze(identity),
  });
}

function remoteDescriptors(snapshot) {
  const descriptors = [];
  for (const binding of Array.isArray(snapshot.remote_mcp_bindings)
    ? snapshot.remote_mcp_bindings : []) {
    if (!isRecord(binding)) throw new Error('Remote MCP binding is invalid.');
    for (const contribution of Array.isArray(binding.contributions) ? binding.contributions : []) {
      if (contribution?.kind !== 'tool') continue;
      const name = requiredText(contribution.namespaced_name, 'name');
      descriptors.push(policyDescriptor({ name, sideEffecting: true, sourceKind: 'mcp',
        identity: {
          runtime_kind: 'remote_mcp', name,
          binding_digest: requiredDigest(binding.binding_digest, 'binding digest'),
          descriptor_digest: requiredDigest(binding.descriptor_digest, 'descriptor digest'),
          artifact_digest: requiredDigest(binding.artifact_digest, 'artifact digest'),
          schema_digest: requiredDigest(contribution.schema_digest, 'schema digest'),
          endpoint_origin_digest: requiredDigest(
            binding.endpoint_origin_digest,
            'endpoint identity'
          ),
        } }));
    }
  }
  return descriptors;
}

function restrictedDescriptors(snapshot) {
  return (Array.isArray(snapshot.restricted_contributions)
    ? snapshot.restricted_contributions : []).map((descriptor) => {
    if (!isRecord(descriptor)) throw new Error('Restricted plugin descriptor is invalid.');
    const name = requiredText(descriptor.namespaced_name, 'name');
    const capabilities = Array.isArray(descriptor.capabilities)
      ? descriptor.capabilities.map((item) => requiredText(item, 'capability', 64)).sort() : [];
    const networkOrigins = Array.isArray(descriptor.network_origins)
      ? descriptor.network_origins.map((item) => requiredText(item, 'network origin', 2048)).sort()
      : [];
    if (new Set(capabilities).size !== capabilities.length
      || new Set(networkOrigins).size !== networkOrigins.length
      || descriptor.generation_id !== snapshot.active_generation_id
      || descriptor.commit_epoch !== snapshot.commit_epoch) {
      throw new Error('Restricted plugin capability identity is stale.');
    }
    return policyDescriptor({ name, sideEffecting: true, sourceKind: 'restricted', identity: {
      runtime_kind: 'restricted', name, capabilities, network_origins: networkOrigins,
      artifact_digest: requiredDigest(descriptor.artifact_digest, 'artifact digest'),
      component_digest: requiredDigest(descriptor.component_digest, 'component digest'),
      content_digest: requiredDigest(descriptor.content_digest, 'content digest'),
      generation_id: requiredText(descriptor.generation_id, 'generation', 64),
      commit_epoch: requiredInteger(descriptor.commit_epoch, 'commit epoch'),
      lifecycle_epoch: requiredInteger(descriptor.lifecycle_epoch, 'lifecycle epoch'),
      policy_revision: requiredInteger(descriptor.policy_revision, 'policy revision'),
      workspace_incarnation_id: requiredText(
        descriptor.workspace_incarnation_id,
        'workspace incarnation',
        128
      ),
      abi_digest: requiredDigest(descriptor.abi_digest, 'ABI digest'),
      protocol_digest: requiredDigest(descriptor.protocol_digest, 'protocol digest'),
    } });
  });
}

function nativeDescriptors(snapshot) {
  const descriptors = [];
  for (const binding of Array.isArray(snapshot.native_mcp_bindings)
    ? snapshot.native_mcp_bindings : []) {
    if (!isRecord(binding)) throw new Error('Native MCP binding is invalid.');
    const publisherId = requiredText(binding.publisher_id, 'publisher', 64);
    if (binding.active_generation_id !== snapshot.active_generation_id
      || binding.commit_epoch !== snapshot.commit_epoch) {
      throw new Error('Native MCP binding authority is stale.');
    }
    for (const tool of Array.isArray(binding.tools) ? binding.tools : []) {
      if (!isRecord(tool)) throw new Error('Native MCP tool is invalid.');
      const name = requiredText(tool.namespaced_name, 'name');
      const sideEffecting = publisherId === 'jenny-official'
        ? tool.side_effecting !== false : true;
      descriptors.push(policyDescriptor({ name, sideEffecting,
        sourceKind: 'plugin_native_mcp', identity: {
          runtime_kind: 'native_mcp', name, publisher_id: publisherId,
          plugin_id: requiredText(binding.plugin_id, 'plugin', 64),
          contribution_id: requiredText(binding.contribution_id, 'contribution', 64),
          binding_digest: requiredDigest(binding.binding_digest, 'binding digest'),
          artifact_digest: requiredDigest(binding.artifact_digest, 'artifact digest'),
          executable_digest: requiredDigest(binding.executable_digest, 'executable digest'),
          containment_profile_digest: requiredDigest(
            binding.containment_profile_digest,
            'containment profile'
          ),
          schema_digest: requiredDigest(tool.schema_digest, 'schema digest'),
          active_generation_id: requiredText(binding.active_generation_id, 'generation', 64),
          commit_epoch: requiredInteger(binding.commit_epoch, 'commit epoch'),
        } }));
    }
  }
  return descriptors;
}

function capturePluginToolExecutionAuthority(envelope, expectedAuthority) {
  const snapshot = envelope?.plugin_runtime?.snapshot;
  const expected = authorityFingerprint(expectedAuthority);
  const actual = authorityFingerprint(snapshot);
  if (!snapshot || !expected || !actual || !fingerprintsMatch(expected, actual)) {
    throw new Error('Plugin runtime authority does not match the committed snapshot.');
  }
  const descriptors = [
    ...remoteDescriptors(snapshot),
    ...restrictedDescriptors(snapshot),
    ...nativeDescriptors(snapshot),
  ];
  if (descriptors.length > MAX_DYNAMIC_TOOLS) {
    throw new Error('Plugin tool authority exceeds its descriptor bound.');
  }
  descriptors.sort((left, right) => left.name.localeCompare(right.name));
  for (let index = 1; index < descriptors.length; index += 1) {
    if (descriptors[index - 1].name === descriptors[index].name) {
      throw new Error('Plugin tool authority contains a duplicate name.');
    }
  }
  const serialized = canonicalJson({ authority: actual, descriptors });
  if (Buffer.byteLength(serialized, 'utf8') > MAX_AUTHORITY_BYTES) {
    throw new Error('Plugin tool authority exceeds its encoded size bound.');
  }
  return Object.freeze({
    authority: actual,
    descriptor_digest: createHash('sha256').update(serialized).digest('hex'),
    descriptors: Object.freeze(descriptors),
  });
}

module.exports = {
  MAX_AUTHORITY_BYTES,
  MAX_DYNAMIC_TOOLS,
  authorityFingerprint,
  capturePluginToolExecutionAuthority,
  fingerprintsMatch,
};
