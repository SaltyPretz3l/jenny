"use strict";
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { stableJson } = require('../session-runtime/contracts');
const MAX_BYTES = 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fail() { throw new Error('runtime_approval_inputs_invalid'); }
function decode(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_BYTES / 3) * 4) fail();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 2 || bytes.length > MAX_BYTES || bytes.toString('base64') !== value) fail();
  return bytes;
}
function readApprovalInputs(value) {
  const bytes = decode(value);
  const bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!bundle || Object.keys(bundle).sort().join(',') !== 'inputs,schema_version'
    || bundle.schema_version !== 1 || !Array.isArray(bundle.inputs)
    || !bundle.inputs.length || bundle.inputs.length > 256
    || !Buffer.from(stableJson(bundle)).equals(bytes)) fail();
  return { bytes, inputs: bundle.inputs.map(entry => {
    if (!entry || Object.keys(entry).sort().join(',') !== 'frozen_input_bytes,frozen_input_sha256') fail();
    const leaf = decode(entry.frozen_input_bytes);
    if (sha(leaf) !== entry.frozen_input_sha256) fail();
    return { bytes: entry.frozen_input_bytes,
      input: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(leaf)) };
  }) };
}
function normalizeApprovalInputs(value, { calls, firstBytes, scope, normalizeInput, normalizeBytes }) {
  const bundle = readApprovalInputs(value);
  if (bundle.inputs.length !== calls.length || bundle.inputs[0].bytes !== firstBytes) fail();
  for (const [index, entry] of bundle.inputs.entries()) {
    const input = normalizeInput(entry.input, calls[index]);
    normalizeBytes(entry.bytes, input);
    if (!isDeepStrictEqual(input.visible_tool_arguments, calls[index].arguments)
      || ['session_id', 'logical_turn_id', 'authority_revision', 'project_id', 'root_id', 'root_revision']
        .some(key => input.execution_context_payload[key] !== scope[key])
      || [input.effective_tool_arguments, input.execution_context_payload]
        .some(item => Object.hasOwn(item, '_jenny_change_set_id'))) fail();
  }
  return value;
}
function assertApprovalInputProgress(previous, current, pendingCalls) {
  const before = previous.approvalInputsBytes ? readApprovalInputs(previous.approvalInputsBytes).inputs
    .map(entry => entry.input) : [previous.frozenFirstInput];
  const after = current.approvalInputsBytes ? readApprovalInputs(current.approvalInputsBytes).inputs
    .map(entry => entry.input) : [current.frozenFirstInput];
  for (const old of before) {
    const next = after.find(input => input?.call_id === old?.call_id);
    if (!next) {
      if (pendingCalls.some(call => call.call_id === old?.call_id)) fail();
      continue;
    }
    const normalize = input => ({ ...input, execution_context_payload: {
      ...input.execution_context_payload, authority_revision: null } });
    if (stableJson(normalize(old)) !== stableJson(normalize(next))) fail();
  }
}
module.exports = { normalizeApprovalInputs, readApprovalInputs, assertApprovalInputProgress };
