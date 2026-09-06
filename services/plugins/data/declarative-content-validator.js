'use strict';

const { validate } = require('../contracts/generated-plugin-contracts');

const CONTRACT_NAME = 'PluginDeclarativeContentV1';
const CONTRACT_NAME_V2 = 'PluginDeclarativeContentV2';
const MAX_ITEM_CONTEXT_BYTES = 16 * 1024;
const MAX_WORKFLOW_DEPTH = 16;
const MAX_WORKFLOW_FAN_OUT = 4;
const MAX_WORKFLOW_TIMEOUT_MS = 5 * 60 * 1000;
const SAFE_THEME_TOKEN = /^(?:color|surface|text|border|spacing|radius|font|motion)\.[a-z0-9_.-]{1,56}$/;
const SAFE_THEME_VALUE = /^[-A-Za-z0-9#._% +]{1,200}$/;
const SENSITIVE_SETTING_KEY = /(?:secret|token|password|credential|api[_-]?key|auth)/i;
const STAGE4B_THEME_TOKENS = Object.freeze([
  'surface.chat', 'surface.message_user', 'surface.message_assistant', 'surface.tool',
  'text.primary', 'text.muted', 'text.link', 'border.default', 'border.focus',
  'color.accent', 'color.accent_text',
]);
const STAGE4B_THEME_TOKEN_SET = new Set(STAGE4B_THEME_TOKENS);

function fail(reason, path = '') {
  return { ok: false, reason, path };
}

function validateSettings(fields) {
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (SENSITIVE_SETTING_KEY.test(field.key)) return fail('secret_setting_key_rejected', `payload.fields[${index}].key`);
    if (field.type === 'string' && Buffer.byteLength(field.default, 'utf8') > field.max_length) {
      return fail('string_default_exceeds_max_length', `payload.fields[${index}].default`);
    }
    if (field.type === 'integer') {
      if (field.minimum > field.maximum) return fail('integer_bounds_reversed', `payload.fields[${index}]`);
      if (field.default < field.minimum || field.default > field.maximum) {
        return fail('integer_default_out_of_range', `payload.fields[${index}].default`);
      }
    }
    if (field.type === 'enum') {
      if (new Set(field.values).size !== field.values.length) {
        return fail('enum_values_duplicate', `payload.fields[${index}].values`);
      }
      if (!field.values.includes(field.default)) {
        return fail('enum_default_not_declared', `payload.fields[${index}].default`);
      }
    }
  }
  return { ok: true };
}

function validateWorkflow(payload, { version = 1 } = {}) {
  if (payload.total_timeout_ms > MAX_WORKFLOW_TIMEOUT_MS) return fail('workflow_timeout_exceeded', 'payload.total_timeout_ms');
  if (payload.nodes.length === 0) return fail('workflow_nodes_empty', 'payload.nodes');
  // A tool_id is an inert signed reference at Stage 3, never an authority or
  // an admission decision. Stage 4B must resolve it against a Jenny-owned
  // canonical descriptor carrying a positive `workflow_eligible` declaration
  // (default false), bind that descriptor/version into the compiled snapshot,
  // and re-resolve/recheck it at dispatch before the ordinary permission
  // lattice runs. Name/family denylists cannot prove that a builtin such as a
  // shell tool has no network, lifecycle, MCP, hook, or evaluator effects.
  const nodes = new Map(payload.nodes.map((node) => [node.node_id, node]));
  if (!nodes.has(payload.entry_node_id)) return fail('workflow_entry_missing', 'payload.entry_node_id');

  const adjacency = new Map([...nodes.keys()].map((id) => [id, []]));
  const indegree = new Map([...nodes.keys()].map((id) => [id, 0]));
  for (let index = 0; index < payload.edges.length; index += 1) {
    const edge = payload.edges[index];
    if (!nodes.has(edge.from_node_id) || !nodes.has(edge.to_node_id)) {
      return fail('workflow_edge_target_missing', `payload.edges[${index}]`);
    }
    if (edge.from_node_id === edge.to_node_id) return fail('workflow_self_cycle', `payload.edges[${index}]`);
    const outgoing = adjacency.get(edge.from_node_id);
    outgoing.push(edge.to_node_id);
    if (outgoing.length > MAX_WORKFLOW_FAN_OUT) return fail('workflow_fan_out_exceeded', `payload.edges[${index}]`);
    indegree.set(edge.to_node_id, indegree.get(edge.to_node_id) + 1);
  }

  const queue = [...nodes.keys()].filter((id) => indegree.get(id) === 0);
  let visitedCount = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visitedCount += 1;
    for (const target of adjacency.get(id)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }
  if (visitedCount !== nodes.size) return fail('workflow_cycle_rejected', 'payload.edges');

  const depth = new Map([[payload.entry_node_id, 1]]);
  const pending = [payload.entry_node_id];
  while (pending.length > 0) {
    const id = pending.shift();
    const nextDepth = depth.get(id) + 1;
    for (const target of adjacency.get(id)) {
      if (nextDepth > MAX_WORKFLOW_DEPTH) return fail('workflow_depth_exceeded', 'payload.edges');
      if ((depth.get(target) || 0) < nextDepth) {
        depth.set(target, nextDepth);
        pending.push(target);
      }
    }
  }
  if (depth.size !== nodes.size) return fail('workflow_unreachable_node', 'payload.nodes');
  if (version === 2) {
    const terminals = [...nodes.keys()].filter((id) => adjacency.get(id).length === 0);
    if (terminals.length !== 1) return fail('workflow_terminal_count_invalid', 'payload.nodes');
    const ancestors = new Map([...nodes.keys()].map((id) => [id, new Set()]));
    const ordered = [...depth.keys()].sort((a, b) => (depth.get(a) - depth.get(b))
      || Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const id of ordered) {
      for (const target of adjacency.get(id)) {
        const targetAncestors = ancestors.get(target);
        targetAncestors.add(id);
        for (const ancestor of ancestors.get(id)) targetAncestors.add(ancestor);
      }
    }
    for (let index = 0; index < payload.nodes.length; index += 1) {
      const node = payload.nodes[index];
      for (const binding of node.bindings) {
        if (binding.value.source === 'node_output'
          && !ancestors.get(node.node_id).has(binding.value.node_id)) {
          return fail('workflow_node_output_not_ancestor', `payload.nodes[${index}].bindings`);
        }
      }
    }
  }
  return { ok: true };
}

function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrast(a, b) {
  const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (bright + 0.05) / (dark + 0.05);
}

function validateStage4BTheme(tokens) {
  const values = new Map(tokens.map((row) => [row.token, row.value]));
  if (values.size !== STAGE4B_THEME_TOKENS.length
    || [...values.keys()].some((token) => !STAGE4B_THEME_TOKEN_SET.has(token))) {
    return fail('theme_token_set_incomplete', 'payload.tokens');
  }
  const textPairs = [
    ['text.primary', 'surface.chat'], ['text.primary', 'surface.message_user'],
    ['text.primary', 'surface.message_assistant'], ['text.primary', 'surface.tool'],
    ['text.muted', 'surface.chat'], ['text.link', 'surface.chat'],
    ['color.accent_text', 'color.accent'],
  ];
  if (textPairs.some(([foreground, background]) => contrast(values.get(foreground), values.get(background)) < 4.5)) {
    return fail('theme_text_contrast_insufficient', 'payload.tokens');
  }
  const nonTextPairs = [
    ['border.default', 'surface.chat'], ['border.default', 'surface.message_user'],
    ['border.default', 'surface.tool'], ['border.focus', 'surface.chat'],
    ['color.accent', 'surface.chat'],
  ];
  if (nonTextPairs.some(([foreground, background]) => contrast(values.get(foreground), values.get(background)) < 3)) {
    return fail('theme_non_text_contrast_insufficient', 'payload.tokens');
  }
  return { ok: true };
}

function validateDeclarativeContent(value, { expectedAuthority = null, expectedKind = null } = {}) {
  const version = value && value.content_schema_version;
  const contractName = version === 2 ? CONTRACT_NAME_V2 : CONTRACT_NAME;
  const structural = validate(contractName, value);
  if (!structural.ok) return fail(`contract_${structural.error.code}`, structural.error.path);
  const content = structural.value;
  const kind = content.payload.kind;
  if (expectedKind && kind !== expectedKind) return fail('manifest_kind_mismatch', 'payload.kind');
  if (expectedAuthority) {
    for (const key of ['publisher_id', 'plugin_id', 'contribution_id']) {
      if (content[key] !== expectedAuthority[key]) return fail('manifest_authority_mismatch', key);
    }
  }

  if (kind === 'skill') {
    if (Buffer.byteLength(content.payload.instructions, 'utf8') > MAX_ITEM_CONTEXT_BYTES) {
      return fail('skill_context_budget_exceeded', 'payload.instructions');
    }
  } else if (kind === 'prompt') {
    if (Buffer.byteLength(content.payload.template, 'utf8') > MAX_ITEM_CONTEXT_BYTES) {
      return fail('prompt_context_budget_exceeded', 'payload.template');
    }
    if (version === 2) {
      const declared = new Set(content.payload.placeholders);
      const seen = new Set([...content.payload.template.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)]
        .map((match) => match[1]));
      if (declared.size !== content.payload.placeholders.length
        || declared.size !== seen.size || [...declared].some((name) => !seen.has(name))) {
        return fail('prompt_placeholder_declaration_mismatch', 'payload.placeholders');
      }
    }
  } else if (kind === 'theme') {
    for (let index = 0; index < content.payload.tokens.length; index += 1) {
      const row = content.payload.tokens[index];
      if (!SAFE_THEME_TOKEN.test(row.token)) return fail('theme_token_not_host_owned', `payload.tokens[${index}].token`);
      if (!SAFE_THEME_VALUE.test(row.value)) return fail('theme_value_unsafe', `payload.tokens[${index}].value`);
    }
    if (version === 2) {
      const theme = validateStage4BTheme(content.payload.tokens);
      if (!theme.ok) return theme;
    }
  } else if (kind === 'settings_schema') {
    const settings = validateSettings(content.payload.fields);
    if (!settings.ok) return settings;
  } else if (kind === 'workflow') {
    const workflow = validateWorkflow(content.payload, { version });
    if (!workflow.ok) return workflow;
  }
  return { ok: true, value: content };
}

module.exports = {
  CONTRACT_NAME,
  CONTRACT_NAME_V2,
  MAX_ITEM_CONTEXT_BYTES,
  validateDeclarativeContent,
};
