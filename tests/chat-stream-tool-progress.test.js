'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MAX_PREVIEW_CHARS, emitToolProgress } = require('../services/backend/chat-stream-tool-progress');

const BASE = { streamId: 'stream-1', sessionId: 'session-1', turnId: 'turn-1' };
const PREVIEW = `data:image/png;base64,${Buffer.from('frame').toString('base64')}`;

function capture() {
  const service = new EventEmitter();
  const events = [];
  service.on('chat-stream', (event) => events.push(event));
  return { service, events };
}

test('a progress report becomes one ephemeral tool_progress event on the turn', () => {
  const { service, events } = capture();
  assert.equal(emitToolProgress(service, BASE, { callId: ' call-1 ', toolName: 'image_generate',
    progress: { phase: 'sample', step: 4, steps: 20, fraction: 0.2, preview: PREVIEW, extra: 'dropped' } }), true);
  assert.deepEqual(events, [{ type: 'tool_progress', ...BASE, callId: 'call-1', toolName: 'image_generate',
    phase: 'sample', step: 4, steps: 20, preview: PREVIEW }]);
});

test('unknown phases, missing call ids and bad steps or previews are re-bounded at the boundary', () => {
  const { service, events } = capture();
  assert.equal(emitToolProgress(service, BASE, { callId: 'c', progress: { phase: 'explode' } }), false);
  assert.equal(emitToolProgress(service, BASE, { callId: '', progress: { phase: 'load' } }), false);
  assert.equal(emitToolProgress(null, BASE, { callId: 'c', progress: { phase: 'load' } }), false);
  for (const progress of [
    { phase: 'sample', step: 21, steps: 20 }, { phase: 'sample', step: 1.5, steps: 20 }, { phase: 'sample', step: 1, steps: 5000 },
    { phase: 'load', step: 1, steps: 2 },
    { phase: 'sample', preview: 'data:image/svg+xml;base64,PHN2Zy8+' },
    { phase: 'sample', preview: 'javascript:alert(1)' },
    { phase: 'sample', preview: `data:image/png;base64,${'A'.repeat(MAX_PREVIEW_CHARS)}` },
  ]) emitToolProgress(service, BASE, { callId: 'c', progress });
  assert.equal(events.length, 7);
  for (const event of events) {
    assert.equal('step' in event, false);
    assert.equal('preview' in event, false);
  }
});
