'use strict';

const crypto = require('node:crypto');
const { validate } = require('../contracts/generated-plugin-contracts');
const { stableStringify } = require('../package/canonical-metadata');
const { bindingDigest, writeRemoteMcpBinding } = require('../store/remote-mcp-binding-store');
const { compileJsonSchema } = require('./json-schema-validator');

const MAX_CONTRIBUTIONS = 64;
const MAX_PAGES = 8;
const REMOTE_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function boundedDescription(value) {
  const source = [...String(value || '')].map((character) => {
    const code = character.codePointAt(0);
    const forbidden = code <= 0x1f || code === 0x7f
      || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    return forbidden ? ' ' : character;
  }).join('');
  let output = '';
  for (const character of source) {
    if (Buffer.byteLength(output + character, 'utf8') > 1024) break;
    output += character;
  }
  return output;
}

function namespacedName(binding, kind, remoteName) {
  const suffix = sha256([binding.publisher_id, binding.plugin_id, binding.contribution_id,
    kind, remoteName].join('\0')).slice(0, 12);
  const prefix = `plugin:${binding.plugin_id}:${binding.contribution_id}:${kind}:`;
  const remaining = Math.max(1, 192 - Buffer.byteLength(prefix, 'utf8') - suffix.length - 1);
  return `${prefix}${remoteName.slice(0, remaining)}:${suffix}`;
}

function promptSchema(prompt) {
  const properties = {};
  const required = [];
  if (!Array.isArray(prompt.arguments) || prompt.arguments.length > 32) return null;
  for (const argument of prompt.arguments) {
    if (!argument || !REMOTE_NAME.test(argument.name || '') || Object.hasOwn(properties, argument.name)) return null;
    properties[argument.name] = { type: 'string', ...(argument.description
      ? { description: boundedDescription(argument.description) } : {}) };
    if (argument.required === true) required.push(argument.name);
  }
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
    properties, required, additionalProperties: false };
}

function contributionFromRemote(binding, kind, item) {
  if (!item || !REMOTE_NAME.test(item.name || '')) return { ok: false, reason: 'remote_name_invalid' };
  let schema;
  let target;
  if (kind === 'tool') schema = item.inputSchema;
  else if (kind === 'prompt') { schema = promptSchema(item); target = { name: item.name }; }
  else {
    if (typeof item.uri !== 'string' || Buffer.byteLength(item.uri, 'utf8') > 2048) {
      return { ok: false, reason: 'remote_resource_invalid' };
    }
    schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
      properties: {}, additionalProperties: false };
    target = { uri: item.uri };
  }
  const compiled = compileJsonSchema(schema);
  if (!compiled.ok) return compiled;
  const schemaDigest = sha256(compiled.schema_json);
  return {
    ok: true,
    contribution: {
      kind, remote_name: item.name,
      namespaced_name: namespacedName(binding, kind, item.name),
      description: boundedDescription(item.description),
      schema_digest: schemaDigest, schema_json: compiled.schema_json,
    },
    compiled_schema: compiled,
    target,
  };
}

async function listAll(transport, method, resultKey) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await transport.call(method, cursor ? { cursor } : {}, { purpose: 'remote_mcp_discovery' });
    if (!result.ok) return result;
    const pageRows = result.result?.[resultKey];
    if (!Array.isArray(pageRows)) return { ok: false, reason: 'remote_list_invalid' };
    rows.push(...pageRows);
    if (rows.length > MAX_CONTRIBUTIONS) return { ok: false, reason: 'remote_contribution_limit_exceeded' };
    cursor = result.result?.nextCursor || null;
    if (!cursor) return { ok: true, rows };
    if (typeof cursor !== 'string' || Buffer.byteLength(cursor, 'utf8') > 1024) {
      return { ok: false, reason: 'remote_cursor_invalid' };
    }
  }
  return { ok: false, reason: 'remote_page_limit_exceeded' };
}

async function compileRemoteDescriptor({ transport, bindingDraft, facade, baseDir = '', diagnostics }) {
  const draft = validate('PluginRemoteMcpBindingV1', bindingDraft);
  if (!draft.ok) return { ok: false, reason: 'remote_binding_draft_invalid' };
  bindingDraft = draft.value;
  const negotiated = await transport.negotiate();
  if (!negotiated.ok) return negotiated;
  const classes = [
    ['tools', 'tools/list', 'tools', 'tool'],
    ['resources', 'resources/list', 'resources', 'resource'],
    ['prompts', 'prompts/list', 'prompts', 'prompt'],
  ];
  const contributions = [];
  const compiledSchemas = new Map();
  const targets = new Map();
  const rejected = [];
  for (const [feature, method, resultKey, kind] of classes) {
    if (!bindingDraft.feature_classes.includes(feature)) continue;
    const listed = await listAll(transport, method, resultKey);
    if (!listed.ok) return listed;
    for (const item of listed.rows) {
      const compiled = contributionFromRemote(bindingDraft, kind, item);
      if (!compiled.ok) {
        rejected.push({ kind, reason: compiled.reason });
        diagnostics?.emit('WARN', 'plugins.remote_mcp.contribution_rejected', {
          descriptor_digest: bindingDraft.descriptor_digest, kind, reason: compiled.reason,
        });
        continue;
      }
      contributions.push(compiled.contribution);
      compiledSchemas.set(compiled.contribution.namespaced_name, compiled.compiled_schema);
      if (compiled.target) targets.set(compiled.contribution.namespaced_name, compiled.target);
    }
  }
  contributions.sort((left, right) => left.namespaced_name.localeCompare(right.namespaced_name));
  if (contributions.length > MAX_CONTRIBUTIONS) {
    return { ok: false, reason: 'remote_contribution_limit_exceeded' };
  }
  const schemaDigest = sha256(stableStringify(contributions.map((item) => ({
    kind: item.kind, namespaced_name: item.namespaced_name, schema_digest: item.schema_digest,
  }))));
  const binding = { ...bindingDraft, schema_digest: schemaDigest, binding_digest: '0'.repeat(64) };
  binding.binding_digest = bindingDigest(binding);
  const stored = await writeRemoteMcpBinding(facade, baseDir, binding);
  if (!stored.ok) return stored;
  return {
    ok: true, binding: stored.binding,
    runtime_binding: {
      publisher_id: binding.publisher_id, plugin_id: binding.plugin_id,
      contribution_id: binding.contribution_id, binding_digest: binding.binding_digest,
      descriptor_digest: binding.descriptor_digest, artifact_digest: binding.artifact_digest,
      endpoint_origin_digest: binding.endpoint_origin_digest,
      negotiated_protocol: negotiated.protocol, auth_profile_ref: binding.auth_profile_ref,
      contributions,
    },
    compiled_schemas: compiledSchemas, targets, rejected,
  };
}

module.exports = {
  MAX_CONTRIBUTIONS,
  MAX_PAGES,
  boundedDescription,
  namespacedName,
  promptSchema,
  contributionFromRemote,
  listAll,
  compileRemoteDescriptor,
};
