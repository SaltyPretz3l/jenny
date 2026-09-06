const test = require('node:test');
const assert = require('node:assert/strict');

const { createPreReadyEventBuffer } = require('../renderer/shared/terminal-stream-utils');

test('pre-ready buffer drops an oversized first event and reports cumulative drop totals', () => {
  const drops = [];
  const buffer = createPreReadyEventBuffer({
    maxEvents: 64,
    maxBytes: 4,
    sizeOf: (_kind, payload) => payload.length,
    onDrop: (drop) => drops.push(drop),
  });

  buffer.push('data', '123456789');

  assert.deepEqual(buffer.drain(), [], 'oversized event is not retained');
  assert.deepEqual(drops, [{ droppedEvents: 1, droppedBytes: 9 }]);
});
