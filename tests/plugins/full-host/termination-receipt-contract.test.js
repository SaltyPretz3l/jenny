'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { validate } = require(
  '../../../services/plugins/contracts/generated-plugin-contracts'
);

function receipt(extra = {}) {
  return {
    receipt_schema_version: 6,
    receipt_id: 'receipt-1',
    attempt_id: 'attempt-1',
    attempt_sequence: 1,
    publisher_id: 'publisher',
    plugin_id: 'plugin',
    contribution_id: 'host',
    active_generation_id: 'generation-1',
    commit_epoch: 2,
    session_id: 'session-1',
    session_epoch: 3,
    process_instance_id: 'process-1',
    known: true,
    reaped: true,
    contained: true,
    tree_empty: true,
    escalated: true,
    surviving_process_count: 0,
    containment_profile: 'windows_job_supervised_v1',
    completed_at: '2026-09-10T00:00:00Z',
    ...extra,
  };
}

test('V6 termination receipts accept explicit output-reader proof', () => {
  const result = validate('PluginFullHostTerminationReceiptV6', receipt({
    output_readers_terminated: true,
  }));
  assert.equal(result.ok, true, result.error?.reason);
  assert.equal(result.value.output_readers_terminated, true);
});

test('older V6 receipts remain readable without manufacturing reader proof', () => {
  const result = validate('PluginFullHostTerminationReceiptV6', receipt());
  assert.equal(result.ok, true, result.error?.reason);
  assert.equal(Object.hasOwn(result.value, 'output_readers_terminated'), false);
});
