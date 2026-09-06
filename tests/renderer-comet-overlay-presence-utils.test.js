const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCometOverlayPresenceDeduper,
} = require('../renderer/features/renderer-comet-overlay-presence-utils');

test('comet overlay presence deduper forwards only state tuple transitions per stream', () => {
  const deduper = createCometOverlayPresenceDeduper();
  const first = {
    streamId: 'stream-1',
    sessionId: 'session-1',
    state: 'responding',
    phaseKind: 'text',
    terminalStatus: '',
    terminalSubcode: '',
  };

  assert.equal(deduper.shouldForward(first), true);
  assert.equal(deduper.shouldForward({ ...first }), false);
  assert.equal(deduper.shouldForward({ ...first, state: 'thinking', phaseKind: 'reasoning' }), true);
  assert.equal(deduper.shouldForward({ ...first, state: 'thinking', phaseKind: 'reasoning' }), false);
});

test('comet overlay presence deduper always forwards terminal updates and clears stream state', () => {
  const deduper = createCometOverlayPresenceDeduper();
  const active = {
    streamId: 'stream-2',
    sessionId: 'session-2',
    state: 'responding',
    phaseKind: 'text',
    terminalStatus: '',
    terminalSubcode: '',
  };

  assert.equal(deduper.shouldForward(active), true);
  assert.equal(deduper.shouldForward({ ...active }), false);
  assert.equal(deduper.shouldForward({ ...active, state: 'happy', terminalStatus: 'completed' }), true);
  assert.equal(deduper.shouldForward(active), true);
});

test('comet overlay presence deduper caps retained stream signatures', () => {
  const deduper = createCometOverlayPresenceDeduper({ maxEntries: 128 });

  for (let index = 0; index < 140; index += 1) {
    assert.equal(deduper.shouldForward({
      streamId: `stream-${index}`,
      sessionId: 'session-1',
      state: 'responding',
      phaseKind: 'text',
    }), true);
  }

  assert.equal(deduper.shouldForward({
    streamId: 'stream-139',
    sessionId: 'session-1',
    state: 'responding',
    phaseKind: 'text',
  }), false, 'newest signature remains retained');
  assert.equal(deduper.shouldForward({
    streamId: 'stream-0',
    sessionId: 'session-1',
    state: 'responding',
    phaseKind: 'text',
  }), true, 'oldest signature was evicted');
});

test('comet overlay presence deduper bounds oversized terminal subcodes', () => {
  const deduper = createCometOverlayPresenceDeduper();
  const longPrefix = 'x'.repeat(80);
  const base = {
    streamId: 'stream-long-subcode',
    sessionId: 'session-1',
    state: 'responding',
    phaseKind: 'text',
  };

  assert.equal(deduper.shouldForward({ ...base, terminalSubcode: `${longPrefix}A` }), true);
  assert.equal(deduper.shouldForward({ ...base, terminalSubcode: `${longPrefix}B` }), false);
});
