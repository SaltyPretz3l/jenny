'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  applyHunkDecisions,
  hunksMatchBase,
  splitLines,
  joinLines,
  parseHunkSides,
} = require('../renderer/features/renderer-ide-hunk-apply-utils');

// These hand-written fixtures pin the structured_diff.py hunk wire contract:
// LF-normalized ranges with space, '-', '+', and '\\' line prefixes.
function wireHunk(oldStart, oldLines, newStart, newLines, lines) {
  return { oldStart, oldLines, newStart, newLines, lines };
}

function allIndices(hunks) {
  return hunks.map((_hunk, index) => index);
}

/* ------------------------------------------------------------------ */
/* Pure line-split / join round-trips                                   */
/* ------------------------------------------------------------------ */

test('splitLines/joinLines round-trip across trailing-newline shapes', () => {
  for (const text of ['', 'a', 'a\n', 'a\nb', 'a\nb\n', '\n', '\n\n', 'a\n\nb\n']) {
    const { lines, finalNewline } = splitLines(text);
    assert.equal(joinLines(lines, finalNewline), text, `round-trip failed for ${JSON.stringify(text)}`);
  }
});

test('parseHunkSides decodes prefixes and the no-newline marker per side', () => {
  // Context line shared at EOF without a newline marks BOTH sides.
  const both = parseHunkSides({ lines: [' a', '\\ No newline at end of file'] });
  assert.deepEqual(both.oldLines, ['a']);
  assert.deepEqual(both.newLines, ['a']);
  assert.equal(both.oldNoNewline, true);
  assert.equal(both.newNoNewline, true);

  // A marker after a '+' marks only the new side; after a '-' only the old side.
  const newOnly = parseHunkSides({ lines: ['-a', '+a', '+b', '\\ No newline at end of file'] });
  assert.deepEqual(newOnly.oldLines, ['a']);
  assert.deepEqual(newOnly.newLines, ['a', 'b']);
  assert.equal(newOnly.newNoNewline, true);
  assert.equal(newOnly.oldNoNewline, false);
});

/* ------------------------------------------------------------------ */
/* Round-trip property: accept-all == M, reject-all == O               */
/* ------------------------------------------------------------------ */

const SIMPLE_MODIFICATION_HUNKS = [
  wireHunk(1, 3, 1, 3, [' a', '-b', '+B', ' c']),
];
const WHOLE_FILE_DELETION_HUNKS = [
  wireHunk(1, 3, 1, 0, ['-a', '-b', '-c']),
];
const TWO_SEPARATED_HUNKS = [
  wireHunk(1, 5, 1, 5, [' l01', '-l02', '+L02', ' l03', ' l04', ' l05']),
  wireHunk(8, 5, 8, 5, [' l08', ' l09', ' l10', '-l11', '+L11', ' l12']),
];
const GROWING_FIRST_HUNK = [
  wireHunk(1, 5, 1, 6, [' l01', '-l02', '+INS-A', '+INS-B', ' l03', ' l04', ' l05']),
  wireHunk(8, 5, 9, 5, [' l08', ' l09', ' l10', '-l11', '+L11', ' l12']),
];

const ROUND_TRIP_CASES = [
  ['simple single-line modification', 'a\nb\nc\n', 'a\nB\nc\n', SIMPLE_MODIFICATION_HUNKS],
  [
    'pure insertion in the middle',
    'a\nb\nc\n',
    'a\nX\nb\nc\n',
    [wireHunk(1, 3, 1, 4, [' a', '+X', ' b', ' c'])],
  ],
  [
    'pure deletion in the middle',
    'a\nb\nc\nd\n',
    'a\nb\nd\n',
    [wireHunk(1, 4, 1, 3, [' a', ' b', '-c', ' d'])],
  ],
  ['insertion at the start', 'a\nb\n', 'Z\na\nb\n', [wireHunk(1, 2, 1, 3, ['+Z', ' a', ' b'])]],
  ['insertion at the end', 'a\nb\n', 'a\nb\nZ\n', [wireHunk(1, 2, 1, 3, [' a', ' b', '+Z'])]],
  [
    'deletion of the last line',
    'a\nb\nc\nd\ne\n',
    'a\nb\nc\nd\n',
    [wireHunk(2, 4, 2, 3, [' b', ' c', ' d', '-e'])],
  ],
  ['deletion of the first line', 'a\nb\nc\n', 'b\nc\n', [wireHunk(1, 3, 1, 2, ['-a', ' b', ' c'])]],
  [
    'multi-line block replacement',
    'a\nb\nc\nd\ne\n',
    'a\nX\nY\nZ\ne\n',
    [wireHunk(1, 5, 1, 5, [' a', '-b', '-c', '-d', '+X', '+Y', '+Z', ' e'])],
  ],
  [
    'modified side has no trailing newline',
    'a\nb\n',
    'a\nB',
    [wireHunk(1, 2, 1, 2, [' a', '-b', '+B', '\\ No newline at end of file'])],
  ],
  [
    'original side has no trailing newline',
    'a\nb',
    'a\nB\n',
    [wireHunk(1, 2, 1, 2, [' a', '-b', '\\ No newline at end of file', '+B'])],
  ],
  [
    'both sides lack a trailing newline',
    'a\nb\nc',
    'a\nB\nc',
    [wireHunk(1, 3, 1, 3, [' a', '-b', '+B', ' c', '\\ No newline at end of file'])],
  ],
  [
    'created file (empty original)',
    '',
    'hello\nworld\n',
    [wireHunk(1, 0, 1, 2, ['+hello', '+world'])],
  ],
  [
    'created file without trailing newline',
    '',
    'hello',
    [wireHunk(1, 0, 1, 1, ['+hello', '\\ No newline at end of file'])],
  ],
  ['whole content deleted (empty modified)', 'a\nb\nc\n', '', WHOLE_FILE_DELETION_HUNKS],
  [
    'two separate adjacent changes',
    'a\nb\nc\nd\ne\nf\ng\n',
    'A\nb\nc\nd\ne\nf\nG\n',
    [wireHunk(1, 7, 1, 7, ['-a', '+A', ' b', ' c', ' d', ' e', ' f', '-g', '+G'])],
  ],
  [
    'blank lines preserved',
    'a\n\nb\n\n\nc\n',
    'a\n\nB\n\n\nc\n',
    [wireHunk(1, 6, 1, 6, [' a', ' ', '-b', '+B', ' ', ' ', ' c'])],
  ],
  [
    'leading-context-only change at EOF',
    'x\ny\nz\n',
    'x\ny\nZ\n',
    [wireHunk(1, 3, 1, 3, [' x', ' y', '-z', '+Z'])],
  ],
];

for (const [label, oldText, newText, hunks] of ROUND_TRIP_CASES) {
  test(`round-trip: ${label}`, () => {
    assert.ok(hunks.length > 0, `${label}: expected at least one hunk`);

    // accept-all (nothing rejected) reproduces the modified text exactly.
    const acceptAll = applyHunkDecisions(newText, hunks, { rejected: [] });
    assert.equal(acceptAll.text, newText, `${label}: accept-all must equal Jenny's version`);
    assert.deepEqual(acceptAll.conflicts, [], `${label}: accept-all has no conflicts`);

    // reject-all reproduces the pre-change original exactly.
    const rejectAll = applyHunkDecisions(newText, hunks, { rejected: allIndices(hunks) });
    assert.equal(rejectAll.text, oldText, `${label}: reject-all must equal the pre-change version`);
    assert.deepEqual(rejectAll.conflicts, [], `${label}: reject-all has no conflicts`);
  });
}

/* ------------------------------------------------------------------ */
/* Partial decisions on multi-hunk diffs                                */
/* ------------------------------------------------------------------ */

test('rejecting only the first of two hunks restores just that region', () => {
  // Changes at l02 and l11 are >6 lines apart, so sidecar context 3 keeps them
  // as two separate wire hunks rather than merging them.
  const newText = 'l01\nL02\nl03\nl04\nl05\nl06\nl07\nl08\nl09\nl10\nL11\nl12\n';
  const hunks = TWO_SEPARATED_HUNKS;
  assert.equal(hunks.length, 2, `expected two separate hunks, got ${hunks.length}`);

  // Reject hunk 0 (the l02 change), keep hunk 1 (l11 change).
  const onlyFirst = applyHunkDecisions(newText, hunks, { rejected: [0] });
  assert.equal(onlyFirst.text, 'l01\nl02\nl03\nl04\nl05\nl06\nl07\nl08\nl09\nl10\nL11\nl12\n');
  assert.deepEqual(onlyFirst.conflicts, []);

  // Reject hunk 1 only, keep hunk 0.
  const onlySecond = applyHunkDecisions(newText, hunks, { rejected: [1] });
  assert.equal(onlySecond.text, 'l01\nL02\nl03\nl04\nl05\nl06\nl07\nl08\nl09\nl10\nl11\nl12\n');
  assert.deepEqual(onlySecond.conflicts, []);
});

test('rejecting a hunk is independent of its position (no coordinate drift)', () => {
  // The first hunk grows the file (one line -> three lines) when accepted; the
  // changes are >6 lines apart so sidecar context 3 keeps two distinct hunks. The
  // second hunk must still splice correctly because decisions apply against the
  // immutable base M, not against the shifting result.
  const newText = 'l01\nINS-A\nINS-B\nl03\nl04\nl05\nl06\nl07\nl08\nl09\nl10\nL11\nl12\n';
  const hunks = GROWING_FIRST_HUNK;
  assert.ok(hunks.length >= 2, `expected at least two hunks, got ${hunks.length}`);

  // Reject the earlier (l02 -> INS-A/INS-B) hunk only; the l11 -> L11 change stays.
  const rejectFirst = applyHunkDecisions(newText, hunks, { rejected: [0] });
  assert.equal(rejectFirst.text, 'l01\nl02\nl03\nl04\nl05\nl06\nl07\nl08\nl09\nl10\nL11\nl12\n');
  assert.deepEqual(rejectFirst.conflicts, []);

  // Reject the later hunk only; the insertion stays.
  const rejectSecond = applyHunkDecisions(newText, hunks, { rejected: [hunks.length - 1] });
  assert.equal(rejectSecond.text, 'l01\nINS-A\nINS-B\nl03\nl04\nl05\nl06\nl07\nl08\nl09\nl10\nl11\nl12\n');
  assert.deepEqual(rejectSecond.conflicts, []);
});

/* ------------------------------------------------------------------ */
/* Conflict detection (divergence guard)                                */
/* ------------------------------------------------------------------ */

test('a rejected hunk whose region diverged is reported as a conflict and left untouched', () => {
  const hunks = SIMPLE_MODIFICATION_HUNKS;

  // The base no longer matches the hunk's modified side (someone edited it).
  const diverged = 'a\nTOTALLY-DIFFERENT\nc\n';
  const out = applyHunkDecisions(diverged, hunks, { rejected: [0] });
  assert.deepEqual(out.conflicts, [0], 'the diverged hunk is a conflict');
  assert.equal(out.text, diverged, 'a conflicted hunk leaves the text untouched');
});

test('accepting (not rejecting) a diverged hunk reports no conflict and keeps the base', () => {
  const hunks = SIMPLE_MODIFICATION_HUNKS;
  const diverged = 'a\nDIFFERENT\nc\n';
  const out = applyHunkDecisions(diverged, hunks, { rejected: [] });
  assert.deepEqual(out.conflicts, []);
  assert.equal(out.text, diverged);
});

/* ------------------------------------------------------------------ */
/* Degenerate inputs                                                    */
/* ------------------------------------------------------------------ */

test('no hunks is an identity transform for any decision set', () => {
  assert.equal(applyHunkDecisions('a\nb\n', [], { rejected: [] }).text, 'a\nb\n');
  assert.equal(applyHunkDecisions('a\nb\n', [], { rejected: [0, 1] }).text, 'a\nb\n');
  assert.equal(applyHunkDecisions('', [], {}).text, '');
});

test('out-of-range / malformed rejected indices are ignored', () => {
  const hunks = SIMPLE_MODIFICATION_HUNKS;
  // Indices outside the hunk list, and non-integers, are dropped: behaves as accept-all.
  const out = applyHunkDecisions('a\nB\nc\n', hunks, { rejected: [5, -1, 1.5, 'x', null] });
  assert.equal(out.text, 'a\nB\nc\n');
  assert.deepEqual(out.conflicts, []);
});

test('hunksMatchBase detects whether the text is the version the hunks were computed against', () => {
  const original = 'a\nb\nc\n';
  const jenny = 'a\nB\nc\n';
  const hunks = SIMPLE_MODIFICATION_HUNKS;
  // The modified side ("Jenny's version") matches; the original and any diverged
  // content do not.
  assert.equal(hunksMatchBase(jenny, hunks), true);
  assert.equal(hunksMatchBase(original, hunks), false);
  assert.equal(hunksMatchBase('a\nDIVERGED\nc\n', hunks), false);
  // No hunks => vacuously consistent.
  assert.equal(hunksMatchBase('anything\n', []), true);
});

test('a whole-file-deletion hunk does not merge its old lines into diverged content', () => {
  // Hunks for deleting an entire file (new side empty). Applied against UNRELATED
  // current content, reject-all must NOT prepend the stale original — the
  // empty-new-side region must be reported as a conflict, leaving the base intact.
  const hunks = [wireHunk(1, 2, 1, 0, ['-line1', '-line2'])];
  const out = applyHunkDecisions('unrelated user content\n', hunks, { rejected: allIndices(hunks) });
  assert.deepEqual(out.conflicts, [0], 'the inconsistent whole-file-deletion hunk is a conflict');
  assert.equal(out.text, 'unrelated user content\n', 'diverged content is left untouched');

  // Applied against the genuinely-empty base it still reconstructs the original.
  assert.equal(applyHunkDecisions('', hunks, { rejected: allIndices(hunks) }).text, 'line1\nline2\n');
});

test('identical old/new text yields no hunks and a clean round-trip', () => {
  const hunks = [];
  assert.deepEqual(hunks, []);
  assert.equal(applyHunkDecisions('same\ncontent\n', hunks, { rejected: [] }).text, 'same\ncontent\n');
});
