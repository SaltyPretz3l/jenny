const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatStreamBridge } = require('../services/chat-stream-bridge');

function makeBridge() {
  const sent = [];
  const bridge = createChatStreamBridge({
    sendBridgeEvent: (channel, payload) => sent.push({ channel, payload }),
    log: () => {},
  });
  return { bridge, sent };
}

function makeDelta(streamId, idx) {
  return {
    type: 'delta',
    streamId,
    sessionId: 'sess',
    content: 't' + idx,
    aggregate: 'a' + idx,
    reasoning: { source: 'provider', entriesDelta: [{ phase: 'think', text: 'r' + idx }] },
  };
}

test('coalesces high-rate delta events to bounded IPC count', async () => {
  const { bridge, sent } = makeBridge();

  for (let i = 0; i < 1000; i += 1) {
    bridge.handleEvent(makeDelta('s', i));
  }

  await new Promise((r) => setTimeout(r, 200));

  // A correctly-coalesced 1000-delta burst lands as 1 IPC send in practice.
  // We allow up to 5 to absorb CI scheduling jitter (late setTimeout, an
  // extra flush armed across a tick boundary) — a regression that removed
  // the coalescer would emit ~1000, orders of magnitude over this bound.
  assert.ok(sent.length <= 5, `expected <=5 IPC events, got ${sent.length}`);

  const totalEntries = sent.reduce(
    (sum, call) => sum + (call.payload.reasoning?.entriesDelta?.length || 0),
    0,
  );
  assert.equal(totalEntries, 1000);
  // NOTE: deliberately no wall-clock assertion here — coalescing correctness is
  // proven by the IPC-count and entry-count bounds above. A `Date.now()` elapsed
  // bound only added CI flake without testing behavior.
});

test('flushes pending delta on terminal event without holding for the window', () => {
  const { bridge, sent } = makeBridge();

  for (let i = 0; i < 50; i += 1) {
    bridge.handleEvent(makeDelta('s', i));
  }
  bridge.handleEvent({ type: 'complete', streamId: 's', sessionId: 'sess' });

  assert.equal(sent.length, 2);
});

test('parallel streams coalesce independently', async () => {
  const { bridge, sent } = makeBridge();

  for (let i = 0; i < 500; i += 1) {
    bridge.handleEvent(makeDelta('A', i));
    bridge.handleEvent(makeDelta('B', i));
  }

  await new Promise((r) => setTimeout(r, 200));

  assert.equal(sent.length, 2);
  const byStream = new Map(sent.map((call) => [call.payload.streamId, call.payload]));
  assert.equal(byStream.get('A').reasoning.entriesDelta.length, 500);
  assert.equal(byStream.get('B').reasoning.entriesDelta.length, 500);
});
