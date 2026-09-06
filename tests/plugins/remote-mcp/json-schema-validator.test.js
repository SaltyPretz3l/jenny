'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  compileJsonSchema,
  validateSchemaInstance,
  extractMcpHeaders,
} = require('../../../services/plugins/remote-mcp/json-schema-validator');

test('draft 2020-12 schemas validate arguments and extract required MCP headers', () => {
  const compiled = compileJsonSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
    properties: { region: { type: 'string', 'x-mcp-header': 'Region' },
      count: { type: 'integer' } }, required: ['region'], additionalProperties: false,
  });
  assert.equal(compiled.ok, true);
  assert.equal(validateSchemaInstance(compiled, { region: 'us-east1', count: 2 }).ok, true);
  assert.equal(validateSchemaInstance(compiled, { region: 'x', extra: true }).reason,
    'arguments_schema_invalid');
  assert.deepEqual(extractMcpHeaders(compiled, { region: '世界' }).headers,
    { 'Mcp-Param-Region': `=?base64?${Buffer.from('世界').toString('base64')}?=` });
});

test('schema bombs, external refs, ids, and unreachable header annotations fail closed', () => {
  assert.equal(compileJsonSchema({ $ref: 'https://attacker.test/schema' }).reason,
    'external_schema_ref_blocked');
  assert.equal(compileJsonSchema({ $id: 'https://attacker.test/schema', type: 'object' }).reason,
    'schema_id_blocked');
  let nested = { type: 'string' };
  for (let index = 0; index < 20; index += 1) nested = { type: 'object', properties: { x: nested } };
  assert.equal(compileJsonSchema(nested).reason, 'schema_depth_limit_exceeded');
  assert.equal(compileJsonSchema({ type: 'object', anyOf: [{ type: 'string',
    'x-mcp-header': 'Bad' }] }).reason, 'mcp_header_annotation_invalid');
  assert.equal(compileJsonSchema({ type: 'string', pattern: '(a+)+$' }).reason,
    'schema_pattern_invalid');
  assert.equal(compileJsonSchema({ type: 'string', pattern: '(?=a)a' }).reason,
    'schema_pattern_invalid');
});

test('duplicate or non-primitive x-mcp-header annotations are rejected', () => {
  assert.equal(compileJsonSchema({ type: 'object', properties: {
    first: { type: 'string', 'x-mcp-header': 'Region' },
    second: { type: 'string', 'x-mcp-header': 'region' },
  } }).reason, 'mcp_header_annotation_invalid');
  assert.equal(compileJsonSchema({ type: 'object', properties: {
    value: { type: 'number', 'x-mcp-header': 'Value' },
  } }).reason, 'mcp_header_annotation_invalid');
});

test('safe patternProperties keys compile while unsafe patterns remain rejected', () => {
  assert.equal(compileJsonSchema({
    type: 'object',
    patternProperties: { '^x': { type: 'string' } },
  }).ok, true);
  assert.equal(compileJsonSchema({
    type: 'object',
    patternProperties: { '(a+)+$': { type: 'string' } },
  }).reason, 'schema_pattern_invalid');
});
