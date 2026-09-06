'use strict';

// JCA-009 direct coverage for services/workspace-terminal-output-queue.js:
// batching must preserve stdout/stderr arrival order (coalescing only adjacent
// same-stream chunks) and byte caps must never split a multibyte UTF-8
// character into replacement glyphs. Both the terminal and run-task services
// deliver through this queue.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTerminalOutputQueue,
} = require('../services/workspace-terminal-output-queue');

function createQueue(options = {}) {
  const events = [];
  const flushes = [];
  const queue = createTerminalOutputQueue({
    emit: (stream, text, droppedBytes) => events.push({ stream, text, droppedBytes }),
    log: (droppedBytes) => flushes.push(droppedBytes),
    // Manual flush control: never auto-schedule inside the test.
    schedule: () => null,
    cancel: () => {},
    ...options,
  });
  return { queue, events, flushes };
}

test('interleaved stdout/stderr chunks deliver in arrival order', () => {
  const { queue, events } = createQueue();
  queue.push('stdout', 'A');
  queue.push('stderr', 'B');
  queue.push('stdout', 'C');
  queue.flush();

  assert.deepEqual(
    events.map((event) => [event.stream, event.text]),
    [['stdout', 'A'], ['stderr', 'B'], ['stdout', 'C']],
    'whole-batch stream grouping must not reorder A/B/C into AC/B'
  );
});

test('adjacent same-stream chunks still coalesce into one event', () => {
  const { queue, events } = createQueue();
  queue.push('stdout', 'one ');
  queue.push('stdout', 'two');
  queue.push('stderr', 'warn');
  queue.flush();

  assert.deepEqual(
    events.map((event) => [event.stream, event.text]),
    [['stdout', 'one two'], ['stderr', 'warn']]
  );
});

test('the per-event byte cap truncates at a UTF-8 character boundary', () => {
  // Cap the event at 8 bytes and feed a tail whose cap boundary lands inside
  // a 3-byte character ('€' = E2 82 AC). The decoded text must start at the
  // next complete character instead of a U+FFFD replacement glyph.
  const { queue, events } = createQueue({ maxEventBytes: 8, maxBufferedBytes: 1024 });
  queue.push('stdout', 'xxxx€€€'); // 4 + 9 bytes; last 8 bytes split the first '€'
  queue.flush();

  assert.equal(events.length, 1);
  assert.ok(!events[0].text.includes('�'), 'no replacement character at the cap boundary');
  assert.equal(events[0].text, '€€', 'the partial leading character is dropped, not corrupted');
  assert.ok(events[0].droppedBytes > 0, 'the dropped partial bytes are counted');
});

test('a head-trim under buffer pressure realigns to a character boundary', () => {
  // Buffer cap forces trimToBufferCap to cut inside the first multibyte char;
  // the flush must realign before decoding.
  const { queue, events } = createQueue({ maxBufferedBytes: 8, maxEventBytes: 8 });
  queue.push('stdout', '€€€'); // 9 bytes > 8-byte buffer cap: 1 leading byte trimmed
  queue.flush();

  assert.equal(events.length, 1);
  assert.ok(!events[0].text.includes('�'), 'no replacement character after the head trim');
  assert.equal(events[0].text, '€€');
  assert.ok(events[0].droppedBytes >= 3, 'the whole broken character is accounted as dropped');
});
