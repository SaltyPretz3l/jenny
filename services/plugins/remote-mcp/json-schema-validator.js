'use strict';

const Ajv2020 = require('ajv/dist/2020').default;
const { stableStringify } = require('../package/canonical-metadata');

const LIMITS = Object.freeze({ max_bytes: 64 * 1024, max_depth: 16, max_nodes: 4096,
  max_keys: 128, max_array_items: 256, max_pattern_bytes: 256 });
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const LOCAL_REF = /^#(?:\/.*)?$/;

function isSafePattern(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > LIMITS.max_pattern_bytes) return false;
  // Remote schemas are untrusted. Reject constructs that are difficult to bound
  // in JavaScript's backtracking RegExp implementation.
  return !/(\\[1-9]|\\k<|\(\?[=!<]|\([^)]*[+*][^)]*\)\s*(?:[+*]|\{))/.test(value);
}

function utf8Size(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch (_error) { return Infinity; }
}

function inspectStructure(value, limits = LIMITS, visitor = null) {
  if (utf8Size(value) > limits.max_bytes) return { ok: false, reason: 'schema_byte_limit_exceeded' };
  const stack = [{ value, depth: 0, path: [] }];
  const seen = new Set();
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > limits.max_nodes) return { ok: false, reason: 'schema_node_limit_exceeded' };
    if (current.depth > limits.max_depth) return { ok: false, reason: 'schema_depth_limit_exceeded' };
    if (visitor) {
      const result = visitor(current.value, current.path);
      if (result && !result.ok) return result;
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) return { ok: false, reason: 'schema_cycle_detected' };
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      if (current.value.length > limits.max_array_items) return { ok: false, reason: 'schema_array_limit_exceeded' };
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1,
          path: [...current.path, String(index)] });
      }
    } else {
      const entries = Object.entries(current.value);
      if (entries.length > limits.max_keys) return { ok: false, reason: 'schema_key_limit_exceeded' };
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        stack.push({ value: entries[index][1], depth: current.depth + 1,
          path: [...current.path, entries[index][0]] });
      }
    }
  }
  return { ok: true, nodes };
}

function schemaSecurityVisitor(value, path) {
  const key = path[path.length - 1];
  if (['$ref', '$dynamicRef'].includes(key)
    && (typeof value !== 'string' || !LOCAL_REF.test(value))) {
    return { ok: false, reason: 'external_schema_ref_blocked' };
  }
  if (key === '$id') return { ok: false, reason: 'schema_id_blocked' };
  if (key === 'pattern' && !isSafePattern(value)) {
    return { ok: false, reason: 'schema_pattern_invalid' };
  }
  if (key === 'patternProperties'
    && (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((pattern) => !isSafePattern(pattern)))) {
    return { ok: false, reason: 'schema_pattern_invalid' };
  }
  return null;
}

function collectHeaderAnnotations(schema) {
  const annotations = [];
  const names = new Set();
  let invalid = null;
  function walk(node, path, staticallyReachable) {
    if (invalid || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, path, false);
      return;
    }
    if (Object.hasOwn(node, 'x-mcp-header')) {
      const name = node['x-mcp-header'];
      const primitive = ['string', 'integer', 'boolean'].includes(node.type);
      const key = String(name || '').toLowerCase();
      if (!staticallyReachable || typeof name !== 'string' || !HEADER_TOKEN.test(name)
        || !primitive || names.has(key)) {
        invalid = { ok: false, reason: 'mcp_header_annotation_invalid' };
        return;
      }
      names.add(key);
      annotations.push({ name, path: [...path], type: node.type });
    }
    for (const [keyword, value] of Object.entries(node)) {
      if (keyword === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [property, child] of Object.entries(value)) walk(child, [...path, property], staticallyReachable);
      } else if (value && typeof value === 'object' && keyword !== 'properties') {
        walk(value, path, false);
      }
    }
  }
  walk(schema, [], true);
  return invalid || { ok: true, annotations };
}

function compileJsonSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, reason: 'schema_not_object' };
  }
  const inspected = inspectStructure(schema, LIMITS, schemaSecurityVisitor);
  if (!inspected.ok) return inspected;
  const headers = collectHeaderAnnotations(schema);
  if (!headers.ok) return headers;
  let validate;
  try {
    const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false,
      allowUnionTypes: false, code: { optimize: 0 } });
    ajv.addKeyword({ keyword: 'x-mcp-header', schemaType: 'string', valid: true });
    validate = ajv.compile(schema);
  } catch (_error) { return { ok: false, reason: 'schema_compile_failed' }; }
  return { ok: true, schema, schema_json: stableStringify(schema),
    validate, header_annotations: headers.annotations };
}

function validateSchemaInstance(compiled, instance) {
  const inspected = inspectStructure(instance, LIMITS);
  if (!inspected.ok) return { ok: false, reason: inspected.reason.replace(/^schema_/, 'argument_') };
  let valid;
  try { valid = compiled.validate(instance) === true; } catch (_error) { valid = false; }
  return valid ? { ok: true } : { ok: false, reason: 'arguments_schema_invalid' };
}

function encodeHeaderValue(value) {
  const text = typeof value === 'boolean' ? String(value)
    : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : String(value);
  const safe = /^[\x20-\x7E]*$/.test(text) && text.trim() === text
    && !(text.startsWith('=?base64?') && text.endsWith('?='));
  return safe ? text : `=?base64?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function extractMcpHeaders(compiled, instance) {
  const headers = {};
  for (const annotation of compiled.header_annotations || []) {
    let value = instance;
    for (const key of annotation.path) value = value?.[key];
    if (value === undefined || value === null) continue;
    if ((annotation.type === 'integer' && !Number.isSafeInteger(value))
      || (annotation.type === 'boolean' && typeof value !== 'boolean')
      || (annotation.type === 'string' && typeof value !== 'string')) {
      return { ok: false, reason: 'mcp_header_argument_invalid' };
    }
    headers[`Mcp-Param-${annotation.name}`] = encodeHeaderValue(value);
  }
  return { ok: true, headers };
}

module.exports = {
  LIMITS,
  isSafePattern,
  inspectStructure,
  collectHeaderAnnotations,
  compileJsonSchema,
  validateSchemaInstance,
  encodeHeaderValue,
  extractMcpHeaders,
};
