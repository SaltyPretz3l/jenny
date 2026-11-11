'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createEditDraft, buildWriteView, describeLine, spliceBetween,
} = require('../renderer/features/renderer-ide-follow-draft-model');

const done = (oldText, newText) => ({
  oldText, oldDone: true, newText, newStarted: true, newDone: true, replaceAll: false,
});
const norm = (s) => s.replace(/\r\n?/g, '\n');

/* The tool's result: each edit replaces the first occurrence in the evolving text. */
function refApply(base, edits) {
  let text = norm(base);
  for (const e of edits) {
    const old = norm(e.oldText);
    const at = text.indexOf(old);
    if (old && at >= 0) text = text.slice(0, at) + norm(e.newText) + text.slice(at + old.length);
  }
  return text;
}

/* Every view line is classified and numbered consistently with the base and the edited file. */
function assertConsistent(view, base, expectedNew) {
  const baseLines = norm(base).split('\n');
  const newLines = expectedNew == null ? null : expectedNew.split('\n');
  const lines = view.text.split('\n');
  assert.equal(lines.length, view.lineCount);
  let baseNo = 0;
  let newNo = 0;
  lines.forEach((line, i) => {
    const d = describeLine(view, i + 1);
    if (d.kind === 'removed') {
      baseNo += 1;
      assert.equal(d.label, String(baseNo), `removed label at view line ${i + 1}`);
      assert.equal(line, baseLines[baseNo - 1]);
      return;
    }
    newNo += 1;
    assert.equal(d.label, String(newNo), `${d.kind} label at view line ${i + 1}`);
    if (d.kind === 'context') {
      baseNo += 1;
      assert.equal(line, baseLines[baseNo - 1]);
    }
    if (newLines) assert.equal(line, newLines[newNo - 1]);
  });
  if (newLines) assert.equal(newNo, newLines.length);
}

const region = (editIndex, removedStart, removedCount, addedStart, addedCount, placed = true) => (
  { editIndex, placed, removedStart, removedCount, addedStart, addedCount });

const ten = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');

test('whole-line replacement in the middle of ten lines', () => {
  const edits = [done('line 4\nline 5\n', 'new A\nnew B\nnew C\n')];
  const view = createEditDraft(ten).update(edits);
  assert.equal(view.text, 'line 1\nline 2\nline 3\nline 4\nline 5\nnew A\nnew B\nnew C\nline 6\nline 7\nline 8\nline 9\nline 10');
  assert.deepEqual(view.regions, [region(0, 4, 2, 6, 3)]);
  assert.equal(view.lineCount, 13);
  assert.equal(view.caret, null);
  const expected = [
    ['context', '1'], ['context', '2'], ['context', '3'], ['removed', '4'], ['removed', '5'],
    ['added', '4'], ['added', '5'], ['added', '6'],
    ['context', '7'], ['context', '8'], ['context', '9'], ['context', '10'], ['context', '11'],
  ];
  expected.forEach(([kind, label], i) => assert.deepEqual(describeLine(view, i + 1), { kind, label }, `line ${i + 1}`));
  assertConsistent(view, ten, refApply(ten, edits));
});

test('mid-line replacement shows the whole line removed and the whole line added', () => {
  const base = 'alpha beta gamma\ndelta\nepsilon';
  const edits = [done('beta', 'BETA2')];
  const view = createEditDraft(base).update(edits);
  assert.equal(view.text, 'alpha beta gamma\nalpha BETA2 gamma\ndelta\nepsilon');
  assert.deepEqual(view.regions, [region(0, 1, 1, 2, 1)]);
  assertConsistent(view, base, refApply(base, edits));
});

test('replacement spanning the middle of one line to the middle of a later line', () => {
  const base = 'one two three\nfour five six\nseven eight nine';
  const edits = [done('two three\nfour five', '2\n4')];
  const view = createEditDraft(base).update(edits);
  assert.equal(view.text, 'one two three\nfour five six\none 2\n4 six\nseven eight nine');
  assert.deepEqual(view.regions, [region(0, 1, 2, 3, 2)]);
  assertConsistent(view, base, refApply(base, edits));
});

test('streaming one whole-line edit', () => {
  const base = 'a\nb\nc\nd';
  const draft = createEditDraft(base);
  let view = draft.update([{ oldText: 'b', oldDone: false, newText: '', newStarted: false, newDone: false }]);
  assert.equal(view.text, base);
  assert.deepEqual(view.regions, []);
  assert.equal(view.caret, null);

  view = draft.update([{ oldText: 'b\n', oldDone: true, newText: '', newStarted: false, newDone: false }]);
  assert.equal(view.text, base);
  assert.deepEqual(view.regions, [region(0, 2, 1, 3, 0)]);
  assert.equal(view.caret, null);

  const target = 'X\nYY\nZ';
  const seen = [];
  for (let n = 1; n <= target.length; n += 1) {
    const newText = target.slice(0, n);
    view = draft.update([{ oldText: 'b\n', oldDone: true, newText, newStarted: true, newDone: false }]);
    const shown = newText.endsWith('\n') ? newText.slice(0, -1) : newText;
    assert.equal(view.text, `a\nb\n${shown}\nc\nd`, `text at ${n}`);
    const shownLines = shown.split('\n');
    assert.deepEqual(view.regions, [region(0, 2, 1, 3, shownLines.length)], `region at ${n}`);
    assert.deepEqual(view.caret, { line: 2 + shownLines.length, column: shownLines[shownLines.length - 1].length + 1 }, `caret at ${n}`);
    seen.push(view.caret.line);
  }
  assert.deepEqual([...new Set(seen)], [3, 4, 5]);

  view = draft.update([{ oldText: 'b\n', oldDone: true, newText: target, newStarted: true, newDone: true }]);
  assert.equal(view.caret, null);
  assert.equal(view.text, 'a\nb\nX\nYY\nZ\nc\nd');
});

test('streaming a mid-line edit keeps the caret at the end of the arriving text', () => {
  const base = 'head\nkeep tail\nlast';
  const draft = createEditDraft(base);
  const target = 'p\nqq\nr';
  for (let n = 1; n <= target.length; n += 1) {
    const newText = target.slice(0, n);
    const view = draft.update([{ oldText: 'keep', oldDone: true, newText, newStarted: true, newDone: false }]);
    const replacement = newText + ' tail';
    assert.equal(view.text, `head\nkeep tail\n${replacement}\nlast`);
    const upTo = newText.split('\n');
    assert.deepEqual(view.caret, { line: 2 + upTo.length, column: upTo[upTo.length - 1].length + 1 }, `caret at ${n}`);
  }
});

test('deletion and replacing a line with an empty line', () => {
  const base = 'a\nb\nc';
  const deletion = [done('b\n', '')];
  let view = createEditDraft(base).update(deletion);
  assert.equal(view.text, base);
  assert.deepEqual(view.regions, [region(0, 2, 1, 3, 0)]);
  assert.equal(view.caret, null);
  assertConsistent(view, base, refApply(base, deletion));

  const blank = 'x\nfoo\ny';
  const edits = [done('foo\n', '\n')];
  view = createEditDraft(blank).update(edits);
  assert.equal(view.text, 'x\nfoo\n\ny');
  assert.deepEqual(view.regions, [region(0, 2, 1, 3, 1)]);
  assert.deepEqual(describeLine(view, 3), { kind: 'added', label: '2' });
  assertConsistent(view, blank, refApply(blank, edits));
});

test('three edits written out of base order come back in text order', () => {
  const edits = [done('line 7\n', 'S7\n'), done('line 2\n', 'S2a\nS2b\n'), done('line 9\nline 10', 'S9')];
  const view = createEditDraft(ten).update(edits);
  assert.deepEqual(view.regions, [region(1, 2, 1, 3, 2), region(0, 9, 1, 10, 1), region(2, 12, 2, 14, 1)]);
  assert.equal(view.lineCount, 14);
  assert.equal(view.text.split('\n')[2], 'S2a');
  assert.equal(view.text.split('\n')[9], 'S7');
  assert.equal(view.text.split('\n')[13], 'S9');
  assertConsistent(view, ten, refApply(ten, edits));
});

test('the same old text twice takes the second occurrence, a third is unplaced', () => {
  const base = 'x = 1\ny\nx = 1\nz';
  const two = [done('x = 1', 'A'), done('x = 1', 'B')];
  let view = createEditDraft(base).update(two);
  assert.equal(view.text, 'x = 1\nA\ny\nx = 1\nB\nz');
  assert.deepEqual(view.regions, [region(0, 1, 1, 2, 1), region(1, 4, 1, 5, 1)]);
  assertConsistent(view, base, refApply(base, two));

  const three = [...two, done('x = 1', 'C')];
  view = createEditDraft(base).update(three);
  assert.equal(view.text, 'x = 1\nA\ny\nx = 1\nB\nz\nC');
  assert.deepEqual(view.regions, [region(0, 1, 1, 2, 1), region(1, 4, 1, 5, 1), region(2, 7, 0, 7, 1, false)]);
  assert.equal(view.lineCount, 7);
});

test('an unplaced edit appends its new text after the last line', () => {
  const base = 'a\nb';
  const draft = createEditDraft(base);
  let view = draft.update([done('zzz', 'N1\nN2')]);
  assert.equal(view.text, 'a\nb\nN1\nN2');
  assert.deepEqual(view.regions, [region(0, 3, 0, 3, 2, false)]);
  assert.equal(view.lineCount, 4);
  assert.deepEqual(describeLine(view, 3), { kind: 'added', label: '3' });

  view = draft.update([{ oldText: 'zzz', oldDone: true, newText: '', newStarted: false, newDone: false }]);
  assert.equal(view.text, base);
  assert.deepEqual(view.regions, []);

  view = draft.update([{ oldText: 'zzz', oldDone: true, newText: 'N1\nN', newStarted: true, newDone: false }]);
  assert.deepEqual(view.caret, { line: 4, column: 2 });
});

test('CRLF in the base and in the edits matches LF', () => {
  const lf = 'one two three\nfour five six\nseven';
  const crlf = lf.replace(/\n/g, '\r\n');
  const lone = lf.replace(/\n/g, '\r');
  const edits = [done('two three\nfour five', '2\n4'), done('seven', 'S\nT')];
  const crEdits = edits.map((e) => ({ ...e, oldText: e.oldText.replace(/\n/g, '\r\n'), newText: e.newText.replace(/\n/g, '\r\n') }));
  const expected = createEditDraft(lf).update(edits);
  assert.deepEqual(createEditDraft(crlf).update(crEdits), expected);
  assert.deepEqual(createEditDraft(lone).update(crEdits), expected);
  assert.equal(expected.text.includes('\r'), false);
  assert.deepEqual(buildWriteView('a\r\nb\rc', true).text, 'a\nb\nc');
});

test('two edits on the same line share one region', () => {
  const base = 'a b c d\nnext';
  const edits = [done('b', 'B'), done('d', 'D')];
  const view = createEditDraft(base).update(edits);
  assert.equal(view.text, 'a b c d\na B c D\nnext');
  assert.deepEqual(view.regions, [region(0, 1, 1, 2, 1)]);
  assertConsistent(view, base, refApply(base, edits));
});

test('buildWriteView for a new file', () => {
  assert.deepEqual(buildWriteView('ab\ncd', false), { text: 'ab\ncd', regions: [], caret: { line: 2, column: 3 }, lineCount: 2 });
  assert.deepEqual(buildWriteView('ab\n', false).caret, { line: 2, column: 1 });
  assert.deepEqual(buildWriteView('', false), { text: '', regions: [], caret: { line: 1, column: 1 }, lineCount: 1 });
  assert.equal(buildWriteView('ab\ncd', true).caret, null);
  assert.equal(buildWriteView(null, true).text, '');
});

test('describeLine outside the view is context with no label', () => {
  const view = createEditDraft('a\nb').update([done('a\n', 'x\n')]);
  for (const n of [0, -1, 99, 1.5, NaN, undefined]) assert.deepEqual(describeLine(view, n), { kind: 'context', label: '' });
  assert.deepEqual(describeLine(null, 1), { kind: 'context', label: '' });
});

test('junk input does not throw and later calls recompute', () => {
  const draft = createEditDraft('a\nb\nc');
  assert.equal(draft.update(null).text, 'a\nb\nc');
  assert.equal(draft.update(undefined).regions.length, 0);
  const junk = [null, undefined, 5, 'x', {}, { oldText: 5, newText: {}, oldDone: true, newStarted: true }, { oldText: 'a', oldDone: true }];
  const view = draft.update(junk);
  assert.equal(view.text, 'a\nb\nc');
  assert.deepEqual(view.regions, [region(6, 1, 1, 2, 0)]);
  assert.equal(createEditDraft(null).update([]).text, '');

  const full = [done('a\n', 'A\n'), done('c', 'C')];
  const first = draft.update(full);
  assert.equal(first.regions.length, 2);
  assert.equal(draft.update(full.slice(0, 1)).regions.length, 1);
  const swapped = draft.update([full[1], full[0]]);
  assert.deepEqual(swapped.regions.map((r) => r.editIndex), [1, 0]);
  assert.equal(swapped.text, first.text);
});

function assertSplice(previous, next, expected) {
  const result = spliceBetween(previous, next);
  if (expected === null) {
    assert.equal(result, null);
    return;
  }
  assert.deepEqual(result, expected);
  assert.equal(previous.slice(0, result.start) + result.text + previous.slice(result.end), next);
}

test('spliceBetween finds the changed middle', () => {
  assertSplice('abc', 'abcdef', { start: 3, end: 3, text: 'def' });
  assertSplice('def', 'abcdef', { start: 0, end: 0, text: 'abc' });
  assertSplice('hello world', 'hello brave world', { start: 6, end: 6, text: 'brave ' });
  assertSplice('abcdef', 'abef', { start: 2, end: 4, text: '' });
  assertSplice('same', 'same', null);
  assertSplice('', '', null);
  assertSplice('', 'x', { start: 0, end: 0, text: 'x' });
  assertSplice('xyz', '', { start: 0, end: 3, text: '' });
  assertSplice('axxxb', 'axxxxb', { start: 4, end: 4, text: 'x' });
  assertSplice('aaaa', 'aaa', { start: 3, end: 4, text: '' });
});

test('spliceBetween does not cut a surrogate pair', () => {
  const grin = '\u{1F600}';
  const smile = '\u{1F601}';
  for (const [previous, next] of [
    [`a${grin}b`, `a${smile}b`],
    [`${grin}`, `${smile}`],
    [`x${grin}`, `x${smile}`],
    [`${grin}y`, `${smile}y`],
    [`a${grin}b`, `ab`],
    [`ab`, `a${grin}b`],
    [`a${grin}${grin}`, `a${grin}${smile}`],
  ]) {
    const result = spliceBetween(previous, next);
    assert.equal(previous.slice(0, result.start) + result.text + previous.slice(result.end), next);
    for (const text of [previous, next]) {
      for (const at of [result.start, result.end]) {
        if (at > 0 && at < text.length) {
          const split = text.charCodeAt(at - 1) >= 0xD800 && text.charCodeAt(at - 1) < 0xDC00
            && text.charCodeAt(at) >= 0xDC00 && text.charCodeAt(at) < 0xE000;
          assert.equal(split, false, `${JSON.stringify(previous)} -> ${JSON.stringify(next)} cut a pair at ${at}`);
        }
      }
    }
  }
  assert.deepEqual(spliceBetween(`a${grin}b`, `a${smile}b`), { start: 1, end: 3, text: smile });
});

test('cost guard: a 40,000 line base takes 300 streamed updates', () => {
  const lines = Array.from({ length: 40000 }, (_, i) => `row ${i + 1} some content for the line`);
  const base = lines.join('\n');
  const draft = createEditDraft(base);
  const oldText = `${lines[19999]}\n`;
  const chunk = `${'n'.repeat(39)}\n`;
  let view;
  for (let i = 1; i <= 300; i += 1) {
    view = draft.update([{ oldText, oldDone: true, newText: chunk.repeat(i), newStarted: true, newDone: i === 300 }]);
  }
  const added = Array(300).fill('n'.repeat(39));
  const expected = [...lines.slice(0, 20000), ...added, ...lines.slice(20000)].join('\n');
  assert.equal(view.text, expected);
  assert.deepEqual(view.regions, [region(0, 20000, 1, 20001, 300)]);
  assert.equal(view.lineCount, 40300);
  assert.equal(view.caret, null);
});
