'use strict';

/* createTerminalTail: the main-side, bounded, ANSI-stripped tail of one
 * Workspace terminal's output (row 94 P4 terminal_read). Covers escape
 * sequences split across pushes (CSI, OSC by BEL and by ST), CRLF split
 * across pushes, carriage-return overwrite (progress bars), backspace, C0
 * dropping, the maxChars bound and truncation flag, line clamping, the
 * over-long single line, and clear(). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTerminalTail } = require('../services/workspace-terminal-tail');

const ESC = '\u001b';

test('a CSI color sequence split across two pushes is stripped', () => {
  const tail = createTerminalTail();
  tail.push(`red: ${ESC}[3`);
  tail.push(`1mERROR${ESC}[0m done\n`);
  assert.deepEqual(tail.read(), { lines: ['red: ERROR done'], truncated: false });
});

test('an OSC title ended by BEL keeps the text after the BEL', () => {
  const tail = createTerminalTail();
  tail.push(`${ESC}]0;my ti`);
  tail.push('tle\u0007PS C:\\> ');
  assert.deepEqual(tail.read().lines, ['PS C:\\> ']);
});

test('an OSC title ended by ST split across pushes is stripped', () => {
  const tail = createTerminalTail();
  tail.push(`before\n${ESC}]2;title${ESC}`);
  tail.push('\\after\n');
  assert.deepEqual(tail.read().lines, ['before', 'after']);
});

test('CRLF split across pushes is one line break', () => {
  const tail = createTerminalTail();
  tail.push('one\r');
  tail.push('\ntwo\r\nthree\n');
  assert.deepEqual(tail.read().lines, ['one', 'two', 'three']);
});

test('a progress bar overwritten by bare CRs leaves the last frame', () => {
  const tail = createTerminalTail();
  tail.push('10%\r20%\r30%\n');
  assert.deepEqual(tail.read().lines, ['30%']);
  tail.push('40%\r');
  tail.push('50%');
  assert.deepEqual(tail.read().lines, ['30%', '50%'], 'a CR at the end of a push is resolved by the next push');
});

test('backspace deletes one char of the partial line; other C0 controls drop, tab stays', () => {
  const tail = createTerminalTail();
  tail.push('abx\bc\u0001\td\u0007\n');
  assert.deepEqual(tail.read().lines, ['abc\td']);
  tail.push('\b\bz');
  assert.deepEqual(tail.read().lines, ['abc\td', 'z'], 'backspace on an empty partial is a no-op');
});

test('the partial line is the last element only when non-empty', () => {
  const tail = createTerminalTail();
  tail.push('done\n');
  assert.deepEqual(tail.read().lines, ['done']);
  tail.push('PS> ');
  assert.deepEqual(tail.read().lines, ['done', 'PS> ']);
});

test('the maxChars bound drops the oldest lines and keeps truncated until clear', () => {
  const tail = createTerminalTail({ maxChars: 20 });
  tail.push('aaaa\nbbbb\ncccc\n');
  assert.equal(tail.read().truncated, false);
  tail.push('dddd\neeee\nffff\n');
  const { lines, truncated } = tail.read({ lines: 200 });
  assert.equal(truncated, true);
  assert.deepEqual(lines, ['bbbb', 'cccc', 'dddd', 'eeee', 'ffff'], 'only the oldest line was dropped');
  assert.ok(tail.size <= 20, `size ${tail.size} stays within maxChars`);
  tail.push('f\n');
  assert.equal(tail.read({ lines: 200 }).truncated, true, 'truncated sticks');
  tail.clear();
  assert.equal(tail.size, 0);
  assert.deepEqual(tail.read(), { lines: [], truncated: false });
});

test('a stream of empty lines is bounded too', () => {
  const tail = createTerminalTail({ maxChars: 50 });
  tail.push('\n'.repeat(1000));
  assert.ok(tail.size <= 50);
  assert.equal(tail.read().truncated, true);
});

test('lines clamp to 1..200 and truncated reports unreturned lines', () => {
  const tail = createTerminalTail();
  for (let i = 0; i < 300; i += 1) tail.push(`line ${i}\n`);
  const one = tail.read({ lines: 0 });
  assert.deepEqual(one.lines, ['line 299']);
  assert.equal(one.truncated, true);
  assert.equal(tail.read({ lines: 500 }).lines.length, 200);
  assert.equal(tail.read({ lines: 'x' }).lines.length, 80, 'a non-number means the default 80');
  assert.equal(tail.read().lines.length, 80);
  const all = createTerminalTail();
  all.push('a\nb\n');
  assert.deepEqual(all.read({ lines: 2 }), { lines: ['a', 'b'], truncated: false });
});

test('an over-long single line is clipped to its last maxChars chars', () => {
  const tail = createTerminalTail({ maxChars: 10 });
  tail.push('0123456789abcdef');
  assert.deepEqual(tail.read(), { lines: ['6789abcdef'], truncated: true });
  tail.push('\n');
  assert.ok(tail.size <= 10);
  const done = createTerminalTail({ maxChars: 10 });
  done.push('0123456789abcdef\n');
  assert.deepEqual(done.read(), { lines: ['6789abcdef'], truncated: true });
});

test('clear resets a mid-escape state', () => {
  const tail = createTerminalTail();
  tail.push(`${ESC}]0;never ended`);
  tail.clear();
  tail.push('visible\n');
  assert.deepEqual(tail.read().lines, ['visible']);
});
