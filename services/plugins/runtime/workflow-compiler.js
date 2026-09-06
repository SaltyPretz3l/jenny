'use strict';

const toolManifest = require('../../tools/tool-manifest.json');
const {
  compareUtf8Bytes,
  computeCanonicalMetadataDigest,
} = require('../package/canonical-metadata');

const MAX_NODE_OUTPUT_BYTES = 16 * 1024;
const MAX_WORKFLOW_OUTPUT_BYTES = 64 * 1024;

function descriptorPayload(entry) {
  return {
    manifest_version: toolManifest.manifest_version,
    name: entry.name,
    parameters: entry.parameters,
    side_effecting: entry.side_effecting === true,
    read_only: entry.read_only === true,
    workflow_eligible: entry.workflow_eligible === true,
    source_kind: entry.source_kind || '',
    tool_family: entry.tool_family || '',
    owner: entry.owner || '',
    surfaces: Array.isArray(entry.surfaces) ? entry.surfaces : [],
    availability: entry.availability || {},
  };
}

function descriptorDigest(entry) {
  return computeCanonicalMetadataDigest(descriptorPayload(entry));
}

function fail(reason, detail = null) {
  return { ok: false, reason, detail };
}

function schemaType(property) {
  if (!property || !['string', 'integer', 'boolean'].includes(property.type)) return null;
  return property.type;
}

function bindingType(binding, { fields, invocationInputs }) {
  const source = binding.value;
  if (source.source.startsWith('literal_')) return source.source.slice('literal_'.length);
  if (source.source === 'node_output') return 'string';
  if (source.source === 'setting') return fields.get(`${source.settings_contribution_id}:${source.key}`) || null;
  if (source.source === 'invocation_input') return invocationInputs.get(source.key) || null;
  return null;
}

function stableNodeOrder(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const indegree = new Map(nodes.map((node) => [node.node_id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.node_id, []]));
  for (const edge of edges) {
    indegree.set(edge.to_node_id, indegree.get(edge.to_node_id) + 1);
    outgoing.get(edge.from_node_id).push(edge.to_node_id);
  }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([id]) => id)
    .sort(compareUtf8Bytes);
  const ordered = [];
  while (ready.length > 0) {
    const id = ready.shift();
    ordered.push(byId.get(id));
    for (const target of outgoing.get(id)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        ready.push(target);
        ready.sort(compareUtf8Bytes);
      }
    }
  }
  return ordered;
}

function compileWorkflow({ publisherId, pluginId, workflowId, payload, contents, settingsFields, invocationFields }) {
  const contentById = new Map(contents.map((content) => [content.contribution_id, content]));
  const fields = new Map();
  for (const [contributionId, rows] of settingsFields) {
    for (const row of rows) fields.set(`${contributionId}:${row.key}`, row.type === 'enum' ? 'string' : row.type);
  }
  const invocationInputs = new Map(invocationFields.map((field) => [field.key, field.type === 'enum' ? 'string' : field.type]));
  const manifestByName = new Map(toolManifest.tools.map((entry) => [entry.name, entry]));
  const bindings = [];
  for (const node of payload.nodes) {
    let targetTypes;
    if (node.type === 'prompt') {
      const prompt = contentById.get(node.target_contribution_id);
      if (prompt?.payload?.kind !== 'prompt') return fail('workflow_prompt_target_missing', node.node_id);
      targetTypes = new Map(prompt.payload.placeholders.map((name) => [name, 'string']));
      const provided = new Set(node.bindings.map((binding) => binding.target));
      if ([...targetTypes.keys()].some((name) => !provided.has(name))) {
        return fail('workflow_prompt_required_input_missing', node.node_id);
      }
    } else {
      const descriptor = manifestByName.get(node.tool_id);
      if (!descriptor || descriptor.workflow_eligible !== true
        || descriptor.read_only !== true || descriptor.side_effecting !== false) {
        return fail('workflow_tool_not_eligible', node.tool_id);
      }
      const properties = descriptor.parameters?.properties || {};
      const required = descriptor.parameters.required || [];
      if (required.some((name) => schemaType(properties[name]) === null)) {
        return fail('workflow_tool_schema_not_scalar', node.tool_id);
      }
      targetTypes = new Map(Object.entries(properties)
        .map(([name, property]) => [name, schemaType(property)])
        .filter(([, type]) => type !== null));
      const provided = new Set(node.bindings.map((binding) => binding.target));
      if (required.some((name) => !provided.has(name))) {
        return fail('workflow_tool_required_input_missing', node.tool_id);
      }
      bindings.push({
        publisher_id: publisherId, plugin_id: pluginId, workflow_id: workflowId,
        node_id: node.node_id, tool_id: node.tool_id, manifest_version: toolManifest.manifest_version,
        descriptor_sha256: descriptorDigest(descriptor),
      });
    }
    for (const binding of node.bindings) {
      const expected = targetTypes.get(binding.target);
      const actual = bindingType(binding, { fields, invocationInputs });
      if (!expected) return fail('workflow_binding_target_unknown', `${node.node_id}:${binding.target}`);
      if (!actual || actual !== expected) return fail('workflow_binding_type_mismatch', `${node.node_id}:${binding.target}`);
    }
  }
  return {
    ok: true,
    plan: {
      entry_node_id: payload.entry_node_id,
      terminal_node_id: payload.nodes.find((node) => !payload.edges.some((edge) => edge.from_node_id === node.node_id)).node_id,
      total_timeout_ms: payload.total_timeout_ms,
      max_node_output_bytes: MAX_NODE_OUTPUT_BYTES,
      max_workflow_output_bytes: MAX_WORKFLOW_OUTPUT_BYTES,
      nodes: stableNodeOrder(payload.nodes, payload.edges),
      edges: payload.edges,
    },
    tool_bindings: bindings,
  };
}

module.exports = {
  MAX_NODE_OUTPUT_BYTES,
  MAX_WORKFLOW_OUTPUT_BYTES,
  descriptorPayload,
  descriptorDigest,
  compileWorkflow,
};
