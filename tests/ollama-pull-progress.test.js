'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSize,
  parsePullLine,
  aggregatePullStats,
  stripAnsi,
} = require('../services/ollama-pull-progress');

// ---------------------------------------------------------------------------
// parseSize
// ---------------------------------------------------------------------------

test('parseSize("1.5","GB") returns Math.round(1.5 * 1024**3)', () => {
  assert.equal(parseSize('1.5', 'GB'), Math.round(1.5 * 1024 ** 3));
});

test('parseSize("10","MB") returns 10 * 1024**2', () => {
  assert.equal(parseSize('10', 'MB'), 10 * 1024 ** 2);
});

test('parseSize("x","MB") returns 0 for non-numeric input', () => {
  assert.equal(parseSize('x', 'MB'), 0);
});

test('parseSize("5","") falls back to multiplier 1 for unknown unit', () => {
  assert.equal(parseSize('5', ''), 5);
});

test('parseSize("5","UNKNOWN") falls back to multiplier 1 for unrecognised unit', () => {
  assert.equal(parseSize('5', 'UNKNOWN'), 5);
});

// ---------------------------------------------------------------------------
// parsePullLine — status lines
// ---------------------------------------------------------------------------

test('parsePullLine "pulling manifest" returns status Pulling manifest', () => {
  const result = parsePullLine('pulling manifest');
  assert.equal(result.kind, 'status');
  assert.equal(result.label, 'Pulling manifest');
});

test('parsePullLine "verifying sha256 digest" returns status Verifying', () => {
  const result = parsePullLine('verifying sha256 digest');
  assert.equal(result.kind, 'status');
  assert.equal(result.label, 'Verifying');
});

test('parsePullLine "writing manifest" returns status Writing manifest', () => {
  const result = parsePullLine('writing manifest');
  assert.equal(result.kind, 'status');
  assert.equal(result.label, 'Writing manifest');
});

test('parsePullLine "removing any unused layers" returns status Finishing up', () => {
  const result = parsePullLine('removing any unused layers');
  assert.equal(result.kind, 'status');
  assert.equal(result.label, 'Finishing up');
});

test('parsePullLine "success" returns success Complete', () => {
  const result = parsePullLine('success');
  assert.equal(result.kind, 'success');
  assert.equal(result.label, 'Complete');
});

// ---------------------------------------------------------------------------
// parsePullLine — layer lines
// ---------------------------------------------------------------------------

test('parsePullLine "using existing layer <digest>" returns layer with percent 100', () => {
  const result = parsePullLine('using existing layer abc123def0');
  assert.equal(result.kind, 'layer');
  assert.equal(result.digest, 'abc123def0');
  assert.equal(result.percent, 100);
});

test('parsePullLine "using existing layer" with no digest returns status Reusing layers', () => {
  const result = parsePullLine('using existing layer');
  assert.equal(result.kind, 'status');
  assert.equal(result.label, 'Reusing layers');
});

test('parsePullLine progress line returns kind layer with correct fields', () => {
  const result = parsePullLine('pulling abc1234 50% 1.5 MB/3.0 MB');
  assert.equal(result.kind, 'layer');
  assert.equal(result.digest, 'abc1234');
  assert.equal(result.percent, 50);
  assert.equal(result.bytes, parseSize('1.5', 'MB'));
  assert.equal(result.total, parseSize('3.0', 'MB'));
});

test('parsePullLine with percent > 100 clamps percent to 100', () => {
  const result = parsePullLine('pulling aabbcc 150%');
  assert.equal(result.kind, 'layer');
  assert.equal(result.percent, 100);
});

test('sequential percent-only progress updates one stable aggregate entry', () => {
  const layers = new Map();
  for (const line of ['10%', '40%', '75%']) {
    const parsed = parsePullLine(line);
    layers.set(parsed.digest, parsed);
  }

  assert.equal(layers.size, 1);
  assert.equal(aggregatePullStats(layers).percent, 75);
});

test('parsePullLine blank line returns null', () => {
  assert.equal(parsePullLine(''), null);
  assert.equal(parsePullLine('   '), null);
});

test('parsePullLine line with no pulling-digest and no percent returns null', () => {
  assert.equal(parsePullLine('some random text with no progress info'), null);
});

// ---------------------------------------------------------------------------
// aggregatePullStats — size-weighted percent
// ---------------------------------------------------------------------------

test('aggregatePullStats with two layers returns size-weighted percent 25, correct bytes/totalBytes', () => {
  // layer a: percent=100, total=100 bytes, bytes=100
  // layer b: percent=0,   total=300 bytes, bytes=0
  // weighted = (100*100 + 300*0) / 400 = 10000/400 = 25
  const layers = new Map([
    ['a', { percent: 100, total: 100, bytes: 100 }],
    ['b', { percent: 0,   total: 300, bytes: 0   }],
  ]);
  const result = aggregatePullStats(layers);
  assert.equal(result.percent, 25);
  assert.equal(result.bytes, 100);
  assert.equal(result.totalBytes, 400);
});

test('aggregatePullStats with zero totals falls back to simple average of percents', () => {
  // all totals = 0 → falls back to pctSum / count = (60 + 40) / 2 = 50
  const layers = new Map([
    ['x', { percent: 60, total: 0, bytes: 0 }],
    ['y', { percent: 40, total: 0, bytes: 0 }],
  ]);
  const result = aggregatePullStats(layers);
  assert.equal(result.percent, 50);
  assert.equal(result.totalBytes, 0);
});

test('aggregatePullStats empty map returns zeros', () => {
  const result = aggregatePullStats(new Map());
  assert.equal(result.percent, 0);
  assert.equal(result.bytes, 0);
  assert.equal(result.totalBytes, 0);
});

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

test('stripAnsi removes the VT/ANSI control sequences ollama emits for its redraw', () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  // The exact sequences that were leaking into the onboarding progress label.
  assert.equal(stripAnsi(`a${ESC}[Kb`), 'ab');
  assert.equal(stripAnsi(`${ESC}[?25h`), '');
  assert.equal(stripAnsi(`${ESC}[?25l`), '');
  assert.equal(stripAnsi(`${ESC}[?2026h`), '');
  assert.equal(stripAnsi(`${ESC}[?2026l`), '');
  assert.equal(stripAnsi(`${ESC}[2K`), '');
  assert.equal(stripAnsi(`${ESC}[1G`), '');
  // SGR color codes and a BEL-terminated OSC string are stripped too.
  assert.equal(stripAnsi(`${ESC}[38;5;200mX${ESC}[0m`), 'X');
  assert.equal(stripAnsi(`${ESC}]0;title${BEL}`), '');
  // Nullish / non-string inputs coerce to ''.
  assert.equal(stripAnsi(undefined), '');
  assert.equal(stripAnsi(null), '');
  // A real ollama progress line keeps its human text and drops the trailing
  // redraw codes (the bug from the fresh-install onboarding screenshot).
  const line = `pulling 36f399a3348a: 5% 526 MB/9.8 GB 65 MB/s 2m21s${ESC}[K${ESC}[?25h${ESC}[?2026l`;
  assert.equal(stripAnsi(line), 'pulling 36f399a3348a: 5% 526 MB/9.8 GB 65 MB/s 2m21s');
});

test('parsePullLine is unaffected by trailing ANSI redraw codes', () => {
  const ESC = String.fromCharCode(27);
  const raw = `pulling 36f399a3348a: 5% 526 MB/9.8 GB 65 MB/s 2m21s${ESC}[K${ESC}[?25h`;
  const clean = 'pulling 36f399a3348a: 5% 526 MB/9.8 GB 65 MB/s 2m21s';
  // The parser strips internally, so a trailing-ANSI line parses identically to
  // its stripped form (the codes never participate in a capture).
  assert.deepEqual(parsePullLine(raw), parsePullLine(clean));
  const parsed = parsePullLine(raw);
  assert.equal(parsed.kind, 'layer');
  assert.equal(parsed.digest, '36f399a3348a');
  assert.equal(parsed.percent, 5);
});
