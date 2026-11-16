'use strict';

// new-test-file: server/team/tty-input.js (slices 1h and 3-13/3-14) is the one terminal line reader that
// `owner-init`, `import-conversations`, `team-export`, `team-restore` and `team-delete` share; its behaviour changed
// when it moved out of cli.js, and no file pinned it directly.

const assert = require('node:assert/strict');
const test = require('node:test');

const { MAX_CHARACTERS, isTerminalPair, readPassword, readTerminalLine } = require('../../server/team/tty-input');
const { ttyInput } = require('./helpers/team-maintenance-fixture');

function sink() {
  let text = '';
  return { isTTY: true, write(chunk) { text += String(chunk); return true; }, text: () => text };
}

// Reads one line with `chunks` written to the terminal in turn; answers { value } or { reason } and the echo.
async function readWith(chunks, { echo = false, password = false } = {}) {
  const input = ttyInput();
  const output = sink();
  const reading = password ? readPassword({ input, output, prompt: '> ' }) : readTerminalLine({ input, output, prompt: '> ', echo });
  // Settled as soon as the reader answers, which may be before the last chunk is written.
  const settled = reading.then((value) => ({ value }), (error) => ({ reason: error.reason }));
  for (const chunk of chunks) {
    await new Promise((resolve) => setImmediate(resolve));
    if (chunk === null) input.end(); else input.write(chunk);
  }
  const answer = await settled;
  return { ...answer, shown: output.text(), raw: input.isRaw };
}

test('a line ends at Enter; backspace and DEL edit it; control characters are dropped', async () => {
  assert.equal((await readWith(['abc\r'])).value, 'abc');
  assert.equal((await readWith(['abx\bc\n'])).value, 'abc');
  assert.equal((await readWith(['abx\u007fc\r'])).value, 'abc');
  assert.equal((await readWith(['a\u0001b\r'])).value, 'ab');
  assert.equal((await readWith(['ab\u0004c\r'])).value, 'abc', 'Ctrl-D after text is dropped, not an end');
});

test('the line holds 1024 characters and refuses the next one', async () => {
  assert.equal(MAX_CHARACTERS, 1024);
  assert.equal((await readWith(['x'.repeat(1024), '\r'])).value.length, 1024);
  assert.equal((await readWith(['x'.repeat(1025), '\r'])).reason, 'input_too_long');
});

test('Ctrl-C, Ctrl-D on an empty line and the end of input refuse and restore the terminal', async () => {
  for (const [chunks, reason] of [[['ab\u0003'], 'input_cancelled'], [['\u0004'], 'input_closed'], [['ab', null], 'input_closed']]) {
    const read = await readWith(chunks);
    assert.equal(read.reason, reason, JSON.stringify(chunks));
    assert.equal(read.raw, false, 'raw mode restored');
  }
});

test('a multi-byte character split across chunks arrives whole', async () => {
  const bytes = Buffer.from('café \u{1F600}', 'utf8');
  const read = await readWith([bytes.subarray(0, 4), bytes.subarray(4, 7), bytes.subarray(7), '\r']);
  assert.equal(read.value, 'café \u{1F600}');
});

test('the password reader echoes nothing; the echoing reader shows what is typed and erases on backspace', async () => {
  const secret = await readWith(['hunter22\r'], { password: true });
  assert.equal(secret.value, 'hunter22');
  assert.equal(secret.shown.includes('hunter'), false);
  assert.equal(secret.shown, '> \n');
  const shown = await readWith(['abx\bc\r'], { echo: true });
  assert.equal(shown.shown, '> abx\b \bc\n');
});

test('only a terminal is read: a pipe or a prompt stream that is not a terminal refuses', async () => {
  await assert.rejects(readTerminalLine({ input: { isTTY: false }, output: sink() }), { reason: 'tty_required' });
  assert.equal(isTerminalPair(ttyInput(), sink()), true);
  assert.equal(isTerminalPair(ttyInput(), { isTTY: false }), false);
  assert.equal(isTerminalPair({ isTTY: true }, sink()), false, 'no raw mode');
});
