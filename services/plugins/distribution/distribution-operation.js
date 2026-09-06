'use strict';

const crypto = require('node:crypto');
const { validate } = require('../contracts/generated-plugin-contracts');
const { stableStringify } = require('../package/canonical-metadata');
const { digest } = require('./source-intake');

function validateDistributionOperation(request) {
  const result = validate('PluginDistributionOperationV1', request);
  return result.ok ? { ok: true, value: result.value } : { ok: false, reason: 'distribution_operation_invalid' };
}
function fingerprintOperation(request) {
  const checked = validateDistributionOperation(request); if (!checked.ok) return checked;
  const operation = { ...checked.value.operation };
  if (typeof operation.source_locator === 'string') operation.source_locator = { digest: digest(operation.source_locator) };
  const material = { client_request_id: checked.value.client_request_id, operation };
  return { ok: true, fingerprint: crypto.createHash('sha256').update(stableStringify(material), 'utf8').digest('hex'), value: checked.value };
}
function redactedOperationRecord({ operationId, fingerprint, request, now, candidateGenerationId }) {
  return {
    operation_record_schema_version: 1, operation_id: operationId, request_fingerprint: fingerprint,
    operation_kind: request.operation.kind, phase: 'pending', sequence: 0,
    candidate_generation_id: candidateGenerationId, created_at: now, updated_at: now,
  };
}
module.exports = { fingerprintOperation, redactedOperationRecord };
