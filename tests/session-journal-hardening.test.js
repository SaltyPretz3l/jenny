'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createDeltaEncoder,
  encodeHeader,
  encodeRecord,
  replayJournal,
} = require('../services/backend/session-journal');

const TARGET = { sessionId: 's1', epoch: 1 };

function buildJournal(base, steps) {
  const encoder = createDeltaEncoder(base);
  const parts = [encodeHeader(TARGET)];
  for (const step of steps) {
    const prepared = encoder.prepare(step);
    parts.push(prepared.record);
    prepared.commit();
  }
  return parts;
}

test('a commit prepared against an older baseline throws instead of desyncing', () => {
  const encoder = createDeltaEncoder({ title: 'a' });
  const first = encoder.prepare({ title: 'b' });
  const second = encoder.prepare({ title: 'c' });
  second.commit();
  assert.throws(() => first.commit(), /stale/);
  assert.deepEqual(encoder.prepare({ title: 'c' }).ops, [], 'the baseline is still the committed one');

  const beforeReset = encoder.prepare({ title: 'd' });
  encoder.reset({ title: 'e' });
  assert.throws(() => beforeReset.commit(), /stale/);
  assert.deepEqual(encoder.prepare({ title: 'e' }).ops, []);
});

test('a no-op prepare cannot be committed over a newer baseline', () => {
  const encoder = createDeltaEncoder({ messages: [{ x: 1 }] });
  const grow = encoder.prepare({ messages: [{ x: 1 }, { y: 1 }] });
  const same = encoder.prepare({ messages: [{ x: 1 }] });
  assert.equal(same.record, null);
  grow.commit();
  assert.throws(() => same.commit(), /stale/);
});

test('a record the reader would refuse is never encoded', () => {
  const ops = [{ o: 'set', k: 'title', v: 'x'.repeat(200) }];
  assert.throws(() => encodeRecord(ops, { maxBytes: 100 }), RangeError);
  assert.ok(Buffer.isBuffer(encodeRecord(ops, { maxBytes: 1000 })));
  // Multi-byte text is measured in bytes, not characters.
  const wide = [{ o: 'set', k: 'title', v: '漢'.repeat(40) }];
  assert.throws(() => encodeRecord(wide, { maxBytes: 100 }), RangeError);
});

test('a bad line whose own newline is damaged is corrupt when a valid record follows', () => {
  const base = { title: 'a', messages: [] };
  const parts = buildJournal(base, [
    { title: 'a', messages: [{ id: 1 }] },
    { title: 'a', messages: [{ id: 1 }, { id: 2 }] },
    { title: 'a', messages: [{ id: 1 }, { id: 2 }, { id: 3 }] },
  ]);
  const buffer = Buffer.concat(parts);
  const secondEnd = parts[0].length + parts[1].length + parts[2].length;
  buffer[secondEnd - 1] = 0x20;
  const result = replayJournal(base, buffer, TARGET);
  assert.equal(result.status, 'corrupt');
  assert.equal(result.records, 1);
  assert.equal(result.validBytes, parts[0].length + parts[1].length);
  assert.deepEqual(result.session, { title: 'a', messages: [{ id: 1 }] });
});

test('a valid record after an untruncated torn record is reported as corrupt', () => {
  const base = { messages: [] };
  const parts = buildJournal(base, [
    { messages: [{ id: 1 }] },
    { messages: [{ id: 1 }, { id: 2 }] },
    { messages: [{ id: 1 }, { id: 2 }, { id: 3 }] },
  ]);
  const buffer = Buffer.concat([parts[0], parts[1], parts[2].subarray(0, 10), parts[3]]);
  const result = replayJournal(base, buffer, TARGET);
  assert.equal(result.status, 'corrupt');
  assert.equal(result.records, 1);
});

test('the header carries the continues flag only when set', () => {
  const base = { title: 'a' };
  const plain = replayJournal(base, encodeHeader(TARGET), TARGET);
  assert.equal(plain.status, 'ok');
  assert.equal(plain.continues, false);
  const linked = replayJournal(base, encodeHeader({ ...TARGET, continues: true }), TARGET);
  assert.equal(linked.status, 'ok');
  assert.equal(linked.continues, true);
  assert.equal(replayJournal(base, Buffer.alloc(0), TARGET).continues, false);
});

test('scanning crafted line prefixes stays fast', () => {
  const base = { messages: [] };
  const [header] = buildJournal(base, []);
  const count = 60_000;
  const chunkBytes = 32;
  const finalNewline = count * chunkBytes;
  const chunks = [header];
  for (let i = 0; i < count; i += 1) {
    // Each prefix declares a body that ends exactly at the final newline, so
    // only the raw-newline check stops a CRC pass over the rest of the buffer.
    let text = '';
    for (let digits = 1; digits <= 10; digits += 1) {
      const length = finalNewline - (i * chunkBytes + '\nJ1 '.length + digits + ' 00000000 '.length);
      if (String(length).length === digits) text = `\nJ1 ${length} 00000000 `;
    }
    assert.notEqual(text, '');
    chunks.push(Buffer.from(text.padEnd(chunkBytes, 'A'), 'latin1'));
  }
  chunks.push(Buffer.from('\n'));
  const buffer = Buffer.concat(chunks);
  assert.equal(buffer.length, header.length + finalNewline + 1);
  const startedAt = performance.now();
  const result = replayJournal(base, buffer, TARGET);
  assert.notEqual(result.status, 'ok');
  assert.ok(performance.now() - startedAt < 2000, 'scan is not quadratic');
});
