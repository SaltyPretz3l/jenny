const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTerminalStateUtils,
  resolveTerminalPresentation,
} = require('../renderer/chat/renderer-stream-terminal-state');

test('terminal presentation matrix defines every outcome and fails unknown closed', () => {
  const expected = {
    complete: 'completed',
    error: 'errored',
    cancelled: 'cancelled',
    denied: 'denied',
    timeout: 'timed_out',
    interrupted: 'interrupted',
    preempted: 'preempted',
    unknown: 'unknown',
  };
  for (const [input, status] of Object.entries(expected)) {
    const presentation = resolveTerminalPresentation(input);
    assert.equal(presentation.status, status);
    assert.ok(presentation.label);
    assert.ok(presentation.tone);
    assert.ok(presentation.ariaLabel);
    assert.ok(presentation.actions.length);
  }
  assert.notEqual(resolveTerminalPresentation('malformed').status, 'completed');
  assert.equal(resolveTerminalPresentation('malformed').status, 'unknown');
});

test('hydration guard preserves the locally terminal row over stale streaming persistence', () => {
  const logs = [];
  const utils = createTerminalStateUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming', COMPLETE: 'complete', ERROR: 'error' },
    normalizeId: (value) => String(value || '').trim(),
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
  });
  const hydrated = utils.guardTerminalHydratedMessages(
    'session_1',
    [{ id: 'm1', streamId: 'stream_1', status: 'streaming', content: 'old' }],
    [{ id: 'm1', streamId: 'stream_1', status: 'complete', content: 'final' }],
    { streamId: 'stream_1' }
  );
  assert.equal(hydrated[0].status, 'complete');
  assert.equal(hydrated[0].content, 'final');
  assert.equal(logs.some((entry) => entry.event === 'stream.terminal_hydration_stale'), true);
});

test('hydration guard recognizes every canonical non-success terminal status', () => {
  const utils = createTerminalStateUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming', COMPLETE: 'complete', ERROR: 'error' },
    normalizeId: (value) => String(value || '').trim(),
    appendClientLog: () => {},
  });

  for (const status of ['denied', 'timeout', 'preempted', 'interrupted', 'unknown']) {
    const hydrated = utils.guardTerminalHydratedMessages(
      'session_1',
      [{ id: 'm1', streamId: 'stream_1', status: 'streaming', content: 'stale' }],
      [{ id: 'm1', streamId: 'stream_1', status, content: `${status} locally` }],
      { streamId: 'stream_1' }
    );
    assert.equal(hydrated[0].status, status);
    assert.equal(hydrated[0].content, `${status} locally`);
  }
});
