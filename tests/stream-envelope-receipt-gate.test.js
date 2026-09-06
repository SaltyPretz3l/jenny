const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createStreamEnvelopeReceiptGate,
} = require('../services/stream-envelope-receipt-gate');

function completeProof(gate, streamId = 'stream-proof', epoch = 1) {
  gate.record({ recordType: 'subscription_started', rendererEpoch: epoch, mode: 'envelope' });
  gate.noteSent({ streamId, channel: 'control', eventKind: 'started' });
  gate.noteSent({
    streamId, sequence: 1, channel: 'response', channelSequence: 1,
    eventKind: 'delta', payload: { delta: 'hi' },
  });
  gate.noteSent({
    streamId, sequence: 2, channel: 'control', channelSequence: 1,
    eventKind: 'terminal', payload: { type: 'complete' },
  });
  return {
    recordType: 'terminal_receipt', rendererEpoch: epoch, streamId,
    receivedCount: 3, sequenceStart: 1, sequenceEnd: 2,
    channels: {
      control: { count: 1, sequenceStart: 1, sequenceEnd: 1 },
      response: { count: 1, sequenceStart: 1, sequenceEnd: 1 },
    },
    eventKind: 'terminal', terminalType: 'complete',
  };
}

test('receipt gate promotes only an exact epoch-scoped terminal proof', () => {
  const gate = createStreamEnvelopeReceiptGate();
  const receipt = completeProof(gate);
  assert.equal(gate.isProven(), false);
  assert.deepEqual(gate.record(receipt), {
    ok: true, reason: null, proven: true, renderer_epoch: 1,
  });
  assert.equal(gate.isProven(), true);
});

test('receipt gate rejects mismatches and immediately reopens legacy', () => {
  const gate = createStreamEnvelopeReceiptGate();
  const receipt = completeProof(gate);
  receipt.receivedCount = 2;
  const result = gate.record(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'terminal_receipt_mismatch');
  assert.equal(result.legacy_reopened, true);
  assert.equal(result.rehydrate_required, true);
  assert.equal(gate.isProven(), false);
});

test('receipt gate rejects stale epochs, missing channels, terminal mismatch, and sent gaps', () => {
  for (const mutate of [
    (receipt) => { receipt.rendererEpoch = 99; },
    (receipt) => { delete receipt.channels.response; },
    (receipt) => { receipt.terminalType = 'error'; },
  ]) {
    const gate = createStreamEnvelopeReceiptGate();
    const receipt = completeProof(gate);
    mutate(receipt);
    assert.equal(gate.record(receipt).ok, false);
    assert.equal(gate.isProven(), false);
  }

  const gapGate = createStreamEnvelopeReceiptGate();
  gapGate.record({ recordType: 'subscription_started', rendererEpoch: 3, mode: 'envelope' });
  gapGate.noteSent({ streamId: 'gap', channel: 'control', eventKind: 'started' });
  gapGate.noteSent({ streamId: 'gap', sequence: 2, channel: 'control', channelSequence: 1,
    eventKind: 'terminal', payload: { type: 'complete' } });
  assert.equal(gapGate.record({
    recordType: 'terminal_receipt', rendererEpoch: 3, streamId: 'gap', receivedCount: 2,
    sequenceStart: 2, sequenceEnd: 2,
    channels: { control: { count: 1, sequenceStart: 1, sequenceEnd: 1 } },
    eventKind: 'terminal', terminalType: 'complete',
  }).ok, false);
});

test('new subscription epochs and renderer faults revoke an existing proof', () => {
  const gate = createStreamEnvelopeReceiptGate();
  assert.equal(gate.record(completeProof(gate)).ok, true);
  assert.equal(gate.isProven(), true);
  gate.record({ recordType: 'subscription_started', rendererEpoch: 2, mode: 'envelope' });
  assert.equal(gate.isProven(), false);

  const receipt = completeProof(gate, 'faulted', 3);
  assert.equal(gate.record(receipt).ok, true);
  const fault = gate.record({
    recordType: 'stream_fault', rendererEpoch: 3, streamId: 'faulted', reason: 'sequence_gap',
  });
  assert.equal(fault.ok, false);
  assert.equal(fault.record_accepted, true);
  assert.equal(gate.isProven(), false);
});

test('stale subscriptions and faults cannot replace the active epoch', () => {
  const gate = createStreamEnvelopeReceiptGate();
  gate.record({ recordType: 'subscription_started', rendererEpoch: 5, mode: 'envelope' });
  assert.equal(gate.record({
    recordType: 'subscription_started', rendererEpoch: 4, mode: 'legacy',
  }).reason, 'stale_subscription_epoch');
  assert.equal(gate.record({
    recordType: 'stream_fault', rendererEpoch: 4, streamId: 'stale', reason: 'sequence_gap',
  }).record_accepted, undefined);

  const receipt = completeProof(gate, 'active', 6);
  assert.equal(gate.record(receipt).ok, true);
});

test('receipt gate rejects coerced and fractional proof integers', () => {
  for (const mutate of [
    (receipt) => { receipt.rendererEpoch = '1'; },
    (receipt) => { receipt.receivedCount = 3.9; },
    (receipt) => { receipt.sequenceStart = '1'; },
    (receipt) => { receipt.channels.control.sequenceEnd = 1.5; },
  ]) {
    const gate = createStreamEnvelopeReceiptGate();
    const receipt = completeProof(gate);
    mutate(receipt);
    assert.equal(gate.record(receipt).ok, false);
    assert.equal(gate.isProven(), false);
  }
});
