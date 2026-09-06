'use strict';

/* UIUX-035: unit coverage for the shared incremental ANSI/OSC stripper
 * (renderer/shared/ansi-stream-utils.js). Exercises the state machine
 * directly — no DOM/harness — so escape-sequence edge cases (BEL vs ST
 * terminators, chunk-boundary splits, an unterminated sequence's safety
 * valve, and reset()) are pinned deterministically. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAnsiStreamStripper } = require('../renderer/shared/ansi-stream-utils');

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

test('plain text with no escape sequences passes through unchanged', () => {
  const stripper = createAnsiStreamStripper();
  assert.equal(stripper.push('hello world\n'), 'hello world\n');
});

test('a complete single-chunk CSI SGR sequence is stripped, text preserved', () => {
  const stripper = createAnsiStreamStripper();
  assert.equal(stripper.push(`${ESC}[32mREADME.md${ESC}[0m done\n`), 'README.md done\n');
});

test('a BEL-terminated OSC is stripped without swallowing what follows it', () => {
  const stripper = createAnsiStreamStripper();
  assert.equal(stripper.push(`${ESC}]0;title${BEL}REAL OUTPUT`), 'REAL OUTPUT');
});

test('an ST-terminated (ESC \\) OSC is stripped without swallowing what follows it', () => {
  const stripper = createAnsiStreamStripper();
  assert.equal(stripper.push(`${ESC}]0;title${ESC}\\REAL OUTPUT`), 'REAL OUTPUT');
});

test('a CSI sequence split across two push() calls is still recognized and stripped', () => {
  const stripper = createAnsiStreamStripper();
  const first = stripper.push(`abc${ESC}[`);
  const second = stripper.push('32mBOLD' + ESC + '[0mEND');
  assert.equal(first + second, 'abcBOLDEND');
});

test('an OSC BEL terminator split across two push() calls is still recognized', () => {
  const stripper = createAnsiStreamStripper();
  const first = stripper.push(`${ESC}]0;title`);
  const second = stripper.push(`${BEL}AFTER`);
  assert.equal(first + second, 'AFTER');
  assert.ok(!(first + second).includes(BEL), 'no raw BEL byte leaks through');
});

test('an OSC ST terminator split across the ESC/backslash boundary is still recognized', () => {
  const stripper = createAnsiStreamStripper();
  const first = stripper.push(`${ESC}]0;title${ESC}`);
  const second = stripper.push('\\AFTER');
  assert.equal(first + second, 'AFTER');
});

test('a CSI split one byte at a time across many push() calls reassembles correctly', () => {
  const stripper = createAnsiStreamStripper();
  const sequence = `x${ESC}[1;31my`;
  let out = '';
  for (const ch of sequence) {
    out += stripper.push(ch);
  }
  assert.equal(out, 'xy');
});

test('an unrecognized single-char escape (not CSI/OSC) passes through untouched', () => {
  const stripper = createAnsiStreamStripper();
  // ESC c (full reset) is outside this module's CSI/OSC scope, matching the
  // prior regex's scope — it should leak through unchanged, not be eaten.
  assert.equal(stripper.push(`${ESC}cafter`), `${ESC}cafter`);
});

test('an unterminated CSI beyond the safety cap resumes normal text mode (no permanent output suppression)', () => {
  const stripper = createAnsiStreamStripper();
  const runaway = ESC + '[' + '9'.repeat(5000); // never reaches a final byte
  const out = stripper.push(runaway + 'RECOVERED');
  assert.match(out, /RECOVERED/, 'output eventually resumes once the safety cap trips');
});

test('reset() clears mid-sequence state so a fresh stream never inherits a dangling escape', () => {
  const stripper = createAnsiStreamStripper();
  stripper.push(`pending${ESC}[`); // leaves the parser mid-CSI
  stripper.reset();
  assert.equal(stripper.push('fresh text'), 'fresh text', 'no leftover CSI state swallows the next push');
});

test('two independent stripper instances do not share state', () => {
  const a = createAnsiStreamStripper();
  const b = createAnsiStreamStripper();
  a.push(`${ESC}[`); // leaves `a` mid-CSI
  assert.equal(b.push('32mBOLD'), '32mBOLD', 'a fresh instance is unaffected by another instance\'s in-flight sequence');
});

test('a second consecutive ESC restarts the escape sequence instead of leaking the first one as literal text', () => {
  // Per ECMA-48/xterm, ESC ESC [ 0 m means the first ESC is abandoned and the
  // second ESC starts the real (CSI) sequence. The old STATE_ESC handling
  // treated the second ESC as "not a CSI/OSC introducer" and emitted BOTH
  // ESC bytes literally before returning to STATE_NONE, leaking a visible
  // `[0m` (and two raw ESC bytes) into the transcript.
  const stripper = createAnsiStreamStripper();
  const out = stripper.push(`${ESC}${ESC}[0mREAL`);
  assert.equal(out, 'REAL', 'the abandoned first ESC and the real CSI sequence are both stripped, no leak');
  assert.ok(!out.includes(ESC), 'no raw ESC byte leaks through');
  assert.ok(!out.includes('[0m'), 'the CSI sequence started by the second ESC is not leaked as literal text');
});

test('three consecutive ESC bytes keep restarting; only the final CSI/OSC introducer is honored', () => {
  const stripper = createAnsiStreamStripper();
  const out = stripper.push(`${ESC}${ESC}${ESC}[31mAFTER`);
  assert.equal(out, 'AFTER');
});

test('a double ESC split across two push() calls still restarts correctly', () => {
  const stripper = createAnsiStreamStripper();
  const first = stripper.push(ESC);
  const second = stripper.push(`${ESC}[0mREAL`);
  assert.equal(first + second, 'REAL');
});

test('null/undefined/empty input never throws and yields empty output', () => {
  const stripper = createAnsiStreamStripper();
  assert.equal(stripper.push(null), '');
  assert.equal(stripper.push(undefined), '');
  assert.equal(stripper.push(''), '');
});
