'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { fingerprintOperation, redactedOperationRecord } = require('../../../services/plugins/distribution/distribution-operation');
test('operation fingerprint binds client id without retaining a raw locator in recovery records', () => {
  const request = { operation_schema_version: 1, client_request_id: 'request_1', operation: { kind: 'install', source_kind: 'https_url', source_locator: 'https://example.test/plugin.zip', target: { publisher_id: 'acme', plugin_id: 'widget' } } };
  const result = fingerprintOperation(request); assert.equal(result.ok, true);
  const record = redactedOperationRecord({ operationId: 'op1', fingerprint: result.fingerprint, request, now: '2026-08-04T00:00:00Z', candidateGenerationId: 'g_op1' });
  assert.equal(JSON.stringify(record).includes('example.test'), false);
});
test('invalid operation results never echo the rejected locator', () => {
  const result = fingerprintOperation({ operation_schema_version: 1, client_request_id: 'bad', operation: {
    kind: 'install', source_kind: 'https_url', source_locator: 'https://user:secret@example.test/plugin.zip' } });
  assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('secret'), false);
});
