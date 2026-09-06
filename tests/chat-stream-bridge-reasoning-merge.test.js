const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatStreamBridge } = require('../services/chat-stream-bridge');

test('coalesced reasoning snapshots replace matching ids while distinct ids append', () => {
  const sent = [];
  let flush = null;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(channel, payload) {
      sent.push({ channel, payload });
    },
    log() {},
    setCoalesceTimer(callback) {
      flush = callback;
      return 'timer';
    },
    clearCoalesceTimer() {
      flush = null;
    },
  });

  bridge.handleEvent({
    type: 'delta',
    streamId: 'stream-reasoning-snapshots',
    reasoning: {
      source: 'provider',
      entriesDelta: [
        { id: 'reason-same', text: 'First snapshot' },
        { id: 'reason-distinct-1', text: 'First distinct entry' },
      ],
    },
  });
  bridge.handleEvent({
    type: 'delta',
    streamId: 'stream-reasoning-snapshots',
    reasoning: {
      source: 'provider',
      entriesDelta: [
        { id: 'reason-same', text: 'Second snapshot' },
        { id: 'reason-distinct-2', text: 'Second distinct entry' },
      ],
    },
  });
  bridge.handleEvent({
    type: 'delta',
    streamId: 'stream-reasoning-snapshots',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-same', text: 'Final snapshot' }],
    },
  });
  flush();

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].payload.reasoning.entriesDelta, [
    { id: 'reason-same', text: 'Final snapshot' },
    { id: 'reason-distinct-1', text: 'First distinct entry' },
    { id: 'reason-distinct-2', text: 'Second distinct entry' },
  ]);
});
