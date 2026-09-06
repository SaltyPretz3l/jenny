'use strict';

// W2-1: tool.output_chunk forwarding (services/backend/chat-stream-tool-output-chunk.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_CHUNK_LINES,
  MAX_CHUNK_LINE_CHARS,
  handleToolOutputChunkNotification,
} = require('../services/backend/chat-stream-tool-output-chunk');

function makeService() {
  const events = [];
  return {
    events,
    emit(channel, payload) {
      events.push({ channel, payload });
    },
  };
}

const CONTEXT = { eventBase: { sessionId: 'session-1', streamId: 'stream-1' } };

test('claims tool.output_chunk and forwards a bounded chat-stream event', () => {
  const service = makeService();
  const claimed = handleToolOutputChunkNotification(service, CONTEXT, {
    method: 'tool.output_chunk',
    params: {
      tool_call_id: 'call-1',
      tool_name: 'run_command',
      sequence: 4,
      lines: [
        { stream: 'stdout', text: 'building...' },
        { stream: 'stderr', text: 'warn' },
        { stream: 'bogus-stream', text: 'coerced' },
      ],
      emitted_lines: 12,
      dropped_lines: 3,
      elapsed_ms: 900,
    },
  });

  assert.equal(claimed, true);
  assert.equal(service.events.length, 1);
  const { channel, payload } = service.events[0];
  assert.equal(channel, 'chat-stream');
  assert.equal(payload.type, 'tool_output_chunk');
  assert.equal(payload.sessionId, 'session-1');
  assert.equal(payload.streamId, 'stream-1');
  assert.equal(payload.callId, 'call-1');
  assert.equal(payload.toolName, 'run_command');
  assert.equal(payload.sequence, 4);
  assert.deepEqual(payload.lines, [
    { stream: 'stdout', text: 'building...' },
    { stream: 'stderr', text: 'warn' },
    { stream: 'stdout', text: 'coerced' },
  ]);
  assert.equal(payload.emittedLines, 12);
  assert.equal(payload.droppedLines, 3);
  assert.equal(payload.elapsedMs, 900);
});

test('other methods are not claimed', () => {
  const service = makeService();
  assert.equal(
    handleToolOutputChunkNotification(service, CONTEXT, {
      method: 'tool.result',
      params: { tool_call_id: 'call-2' },
    }),
    false
  );
  assert.equal(service.events.length, 0);
});

test('missing call id or empty lines claim the notification without emitting', () => {
  const service = makeService();
  assert.equal(
    handleToolOutputChunkNotification(service, CONTEXT, {
      method: 'tool.output_chunk',
      params: { lines: [{ stream: 'stdout', text: 'orphan' }] },
    }),
    true
  );
  assert.equal(
    handleToolOutputChunkNotification(service, CONTEXT, {
      method: 'tool.output_chunk',
      params: { tool_call_id: 'call-3', lines: [] },
    }),
    true
  );
  assert.equal(
    handleToolOutputChunkNotification(service, CONTEXT, {
      method: 'tool.output_chunk',
      params: { tool_call_id: 'call-3', lines: [{ stream: 'stdout', text: '' }, 'not-an-object'] },
    }),
    true
  );
  assert.equal(service.events.length, 0);
});

test('re-bounds oversized payloads at the trust boundary', () => {
  const service = makeService();
  const lines = Array.from({ length: MAX_CHUNK_LINES + 10 }, (_, i) => ({
    stream: 'stdout',
    text: `x`.repeat(MAX_CHUNK_LINE_CHARS + 500) + String(i),
  }));
  handleToolOutputChunkNotification(service, CONTEXT, {
    method: 'tool.output_chunk',
    params: { tool_call_id: 'call-4', lines },
  });

  assert.equal(service.events.length, 1);
  const payload = service.events[0].payload;
  assert.equal(payload.lines.length, MAX_CHUNK_LINES);
  for (const line of payload.lines) {
    assert.equal(line.text.length, MAX_CHUNK_LINE_CHARS);
  }
});
