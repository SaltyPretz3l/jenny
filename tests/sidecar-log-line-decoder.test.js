'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SidecarLogLineDecoder } = require('../services/backend/sidecar-log-line-decoder');

test('decodes split LF and CRLF records without exposing partial lines', () => {
  const decoder = new SidecarLogLineDecoder();
  assert.deepEqual(decoder.push(Buffer.from('{"a":1}\r')), []);
  assert.deepEqual(decoder.push(Buffer.from('\n{"b"')), ['{"a":1}']);
  assert.deepEqual(decoder.push(Buffer.from(':2}\n')), ['{"b":2}']);
});

test('flushes a bounded final partial line and drops oversized lines', () => {
  const decoder = new SidecarLogLineDecoder({ maxLineBytes: 1024 });
  assert.deepEqual(decoder.push('partial'), []);
  assert.deepEqual(decoder.end(), ['partial']);
  const oversized = new SidecarLogLineDecoder({ maxLineBytes: 1024 });
  assert.deepEqual(oversized.push('x'.repeat(1025) + '\n'), []);
  assert.equal(oversized.droppedOversizedLines, 1);
});

test('discards every chunk of one oversized physical line until its newline or end', () => {
  const decoder = new SidecarLogLineDecoder({ maxLineBytes: 1024 });
  assert.deepEqual(decoder.push('x'.repeat(1025)), []);
  assert.deepEqual(decoder.push('TAIL\nvalid\n'), ['valid']);
  assert.equal(decoder.droppedOversizedLines, 1);

  const ended = new SidecarLogLineDecoder({ maxLineBytes: 1024 });
  assert.deepEqual(ended.push('x'.repeat(1025)), []);
  assert.deepEqual(ended.end('TAIL'), []);
  assert.equal(ended.droppedOversizedLines, 1);
});
