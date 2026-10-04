const { PassThrough } = require('node:stream');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pipeChildLogs } = require('../services/backend/child-process-logging');

function createCapture(t, maxLineBytes) {
  const stderr = new PassThrough();
  t.after(() => stderr.destroy());
  const logs = [];
  const retained = [];
  pipeChildLogs({ stderr }, {
    maxLineBytes,
    logger: (level, event, details) => logs.push({ level, event, details }),
    onOutput: output => retained.push(output.line),
  });
  return { stderr, logs, retained };
}

for (const [name, character, count, limit] of [
  ['ASCII', 'a', 100, 64],
  ['CJK', '\u4f60', 100, 100],
  ['emoji', '\u{1f600}', 25, 51],
]) {
  for (const terminated of [true, false]) {
    test(`${name} ${terminated ? 'emitted' : 'pending'} lines obey UTF-8 byte limits`, t => {
      const { stderr, logs, retained } = createCapture(t, limit);
      const input = character.repeat(count);
      stderr.write(input + (terminated ? '\n' : ''));
      if (!terminated) {
        assert.equal(logs.filter(row => row.event.endsWith('.output_truncated')).length, 1,
          'pending line must report byte overflow before a newline');
        stderr.write('\n');
      }
      const output = logs.find(row => row.event.endsWith('.output')).details;
      const expected = character.repeat(Math.floor(limit / Buffer.byteLength(character, 'utf8')));
      assert.ok(Buffer.byteLength(output.line, 'utf8') <= limit, 'emitted line must fit the byte budget');
      assert.equal(output.line, expected);
      assert.equal(output.line.isWellFormed(), true);
      assert.equal(output.line.includes('\ufffd'), false);
      assert.equal(output.droppedBytes, Buffer.byteLength(input, 'utf8') - Buffer.byteLength(expected, 'utf8'));
      assert.deepEqual(retained, [expected]);
    });
  }
}

test('a multibyte character split across chunks is decoded before applying the byte limit', t => {
  const { stderr, logs, retained } = createCapture(t, 5);
  const bytes = Buffer.from('a\u{1f600}\u4f60\n', 'utf8');
  stderr.write(bytes.subarray(0, 3));
  assert.equal(logs.length, 0);
  stderr.write(bytes.subarray(3));
  const output = logs.find(row => row.event.endsWith('.output')).details;
  assert.equal(output.line, 'a\u{1f600}');
  assert.equal(Buffer.byteLength(output.line, 'utf8'), 5);
  assert.equal(output.line.isWellFormed(), true);
  assert.equal(output.line.includes('\ufffd'), false);
  assert.equal(output.droppedBytes, 3);
  assert.deepEqual(retained, ['a\u{1f600}']);
});

test('ordinary multibyte lines fitting the budget stay unannotated', t => {
  const { stderr, logs } = createCapture(t, 7);
  stderr.write('\u4f60\u{1f600}\n');
  assert.deepEqual(logs.map(row => row.details), [{ stream: 'stderr', line: '\u4f60\u{1f600}' }]);
});
