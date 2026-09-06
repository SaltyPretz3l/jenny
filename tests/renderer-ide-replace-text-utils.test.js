'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  toLf,
  detectEol,
  restoreEol,
  escapeRegExp,
  isPotentiallyUnsafeRegexSource,
  computeRegexPreviewReplacement,
  expandReplacement,
  computeLineStarts,
  locate,
  buildPreviewWindow,
  collectRegexMatchesForFile,
  applyReplaceToText,
  applyReplaceAtPosition,
} = require('../renderer/features/renderer-ide-replace-text-utils.js');

describe('synchronous regex preview guard', () => {
  it('flags nested quantifiers and quantified alternation, but keeps lookaround available', () => {
    assert.equal(isPotentiallyUnsafeRegexSource('(a+)+$'), true);
    assert.equal(isPotentiallyUnsafeRegexSource('(a|aa)+$'), true);
    assert.equal(isPotentiallyUnsafeRegexSource('(?<=foo)bar'), false);
  });

  it('does not execute an unsafe pattern while rendering the replacement preview', () => {
    const replacement = computeRegexPreviewReplacement({
      preview: { text: 'aaaaX', matchStart: 0, matchEnd: 4 },
    }, {
      query: '(a+)+$',
      replaceText: 'x',
      caseSensitive: true,
    });
    assert.equal(replacement, 'aaaa');
  });
});

// ---------------------------------------------------------------------------
// 1. EOL utilities
// ---------------------------------------------------------------------------
describe('toLf', () => {
  it('normalises CRLF to LF', () => {
    assert.equal(toLf('a\r\nb'), 'a\nb');
  });
  it('normalises bare CR to LF', () => {
    assert.equal(toLf('a\rb'), 'a\nb');
  });
  it('leaves LF-only text unchanged', () => {
    assert.equal(toLf('a\nb'), 'a\nb');
  });
  it('handles null/undefined gracefully', () => {
    assert.equal(toLf(null), '');
    assert.equal(toLf(undefined), '');
  });
});

describe('detectEol', () => {
  it('returns crlf for CRLF input', () => {
    assert.equal(detectEol('hello\r\nworld'), 'crlf');
  });
  it('returns lf for LF-only input', () => {
    assert.equal(detectEol('hello\nworld'), 'lf');
  });
  it('returns cr for bare-CR input (so a replace preserves classic-Mac endings)', () => {
    assert.equal(detectEol('hello\rworld'), 'cr');
  });
  it('returns lf for empty string', () => {
    assert.equal(detectEol(''), 'lf');
  });
});

describe('restoreEol', () => {
  it('round-trips LF->CRLF for crlf mode', () => {
    assert.equal(restoreEol('a\nb', 'crlf'), 'a\r\nb');
  });
  it('leaves text unchanged for lf mode', () => {
    assert.equal(restoreEol('a\nb', 'lf'), 'a\nb');
  });
  it('does not double-convert', () => {
    // Applying crlf to already-LF text should produce exactly one \r\n per \n
    assert.equal(restoreEol('a\nb\nc', 'crlf'), 'a\r\nb\r\nc');
  });
});

// ---------------------------------------------------------------------------
// 2. escapeRegExp
// ---------------------------------------------------------------------------
describe('escapeRegExp', () => {
  it('escapes . and (', () => {
    assert.equal(escapeRegExp('a.b('), 'a\\.b\\(');
  });
  it('escapes all standard metacharacters', () => {
    const metas = '.*+?^$()|[]\\{}';
    const escaped = escapeRegExp(metas);
    // None of the escaped chars should be "active" in a regex
    const re = new RegExp(escaped);
    assert.ok(re.test(metas));
  });
  it('leaves plain text unchanged', () => {
    assert.equal(escapeRegExp('hello world'), 'hello world');
  });
});

// ---------------------------------------------------------------------------
// 3. applyReplaceToText — literal, case sensitivity
// ---------------------------------------------------------------------------
describe('applyReplaceToText literal case-insensitive', () => {
  it('replaces all case variants when caseSensitive:false', () => {
    const { newRaw, count } = applyReplaceToText('Foo foo', {
      query: 'foo',
      replaceText: 'bar',
      caseSensitive: false,
    });
    assert.equal(newRaw, 'bar bar');
    assert.equal(count, 2);
  });
  it('replaces only matching case when caseSensitive:true', () => {
    const { newRaw, count } = applyReplaceToText('Foo foo', {
      query: 'foo',
      replaceText: 'bar',
      caseSensitive: true,
    });
    assert.equal(newRaw, 'Foo bar');
    assert.equal(count, 1);
  });
});

// ---------------------------------------------------------------------------
// 4. applyReplaceToText — $ in replaceText must be literal (non-regex mode)
// ---------------------------------------------------------------------------
describe('applyReplaceToText $ literal safety', () => {
  it('treats $& in replaceText as a literal string', () => {
    const { newRaw, count } = applyReplaceToText('foo', {
      query: 'foo',
      replaceText: '$&X',
      useRegex: false,
    });
    assert.equal(newRaw, '$&X');
    assert.equal(count, 1);
  });
  it('treats $1 in replaceText as a literal string', () => {
    const { newRaw } = applyReplaceToText('hello', {
      query: 'hello',
      replaceText: '$1world',
      useRegex: false,
    });
    assert.equal(newRaw, '$1world');
  });
});

// ---------------------------------------------------------------------------
// 5. applyReplaceToText — regex with capture groups
// ---------------------------------------------------------------------------
describe('applyReplaceToText regex capture groups', () => {
  it('swaps key=value pairs using $1 and $2', () => {
    const { newRaw } = applyReplaceToText('a=1\nb=2\n', {
      query: '(\\w+)=(\\d+)',
      replaceText: '$2=$1',
      useRegex: true,
    });
    assert.equal(newRaw, '1=a\n2=b\n');
  });
});

// ---------------------------------------------------------------------------
// 6. applyReplaceToText — EOL preservation
// ---------------------------------------------------------------------------
describe('applyReplaceToText EOL preservation', () => {
  it('preserves CRLF line endings after replace', () => {
    const input = 'foo\r\nfoo\r\n';
    const { newRaw } = applyReplaceToText(input, {
      query: 'foo',
      replaceText: 'bar',
    });
    assert.equal(newRaw, 'bar\r\nbar\r\n');
    // No bare \r without following \n, no double CRLF
    assert.ok(!/\r[^\n]/.test(newRaw), 'no lone CR');
    assert.ok(!/\r\r/.test(newRaw), 'no doubled CR');
  });
  it('preserves every untouched boundary in a mixed CRLF/LF/CR buffer', () => {
    const input = 'a\r\nfoo\nbar\rbaz\r\n';
    const all = applyReplaceToText(input, { query: 'foo', replaceText: 'FOO' });
    assert.equal(all.newRaw, 'a\r\nFOO\nbar\rbaz\r\n');

    const one = applyReplaceAtPosition(input, {
      line: 3, column: 1, query: 'bar', replaceText: 'BAR',
    });
    assert.equal(one.newRaw, 'a\r\nfoo\nBAR\rbaz\r\n');
  });
});

// ---------------------------------------------------------------------------
// 7. applyReplaceToText — zero-width regex terminates
// ---------------------------------------------------------------------------
describe('applyReplaceToText zero-width regex', () => {
  it('terminates and returns for a zero-width-capable pattern', () => {
    const result = applyReplaceToText('abc', {
      query: 'x*',
      replaceText: 'Y',
      useRegex: true,
    });
    assert.ok(result !== undefined, 'returned a result');
    assert.ok(typeof result.count === 'number', 'count is a number');
    assert.ok(typeof result.newRaw === 'string', 'newRaw is a string');
  });
});

// ---------------------------------------------------------------------------
// 8. applyReplaceAtPosition
// ---------------------------------------------------------------------------
describe('applyReplaceAtPosition', () => {
  const text = 'x one\ny\nx two\n';

  it('replaces the match at line:3, column:1', () => {
    const { newRaw, ok } = applyReplaceAtPosition(text, {
      line: 3,
      column: 1,
      query: 'x',
      replaceText: 'Z',
    });
    assert.ok(ok);
    assert.equal(newRaw, 'x one\ny\nZ two\n');
  });

  it('returns ok:false when there is no match at the position', () => {
    const { newRaw, ok } = applyReplaceAtPosition(text, {
      line: 1,
      column: 3,
      query: 'x',
      replaceText: 'Z',
    });
    assert.equal(ok, false);
    assert.equal(newRaw, text);
  });

  it('returns ok:false for out-of-range line', () => {
    const { ok } = applyReplaceAtPosition(text, {
      line: 99,
      column: 1,
      query: 'x',
      replaceText: 'Z',
    });
    assert.equal(ok, false);
  });

  it('respects caseSensitive:true at position', () => {
    const { ok } = applyReplaceAtPosition('Hello\n', {
      line: 1,
      column: 1,
      query: 'hello',
      replaceText: 'hi',
      caseSensitive: true,
    });
    assert.equal(ok, false);
  });

  it('respects caseSensitive:false at position', () => {
    const { newRaw, ok } = applyReplaceAtPosition('Hello\n', {
      line: 1,
      column: 1,
      query: 'hello',
      replaceText: 'hi',
      caseSensitive: false,
    });
    assert.ok(ok);
    assert.equal(newRaw, 'hi\n');
  });
});

// ---------------------------------------------------------------------------
// 9. collectRegexMatchesForFile
// ---------------------------------------------------------------------------
describe('collectRegexMatchesForFile', () => {
  it('collects 2 results for "tok" on a 2-line text', () => {
    const lfText = 'tok one\ntok two\n';
    const re = /tok/g;
    const out = [];
    const matched = new Set();
    collectRegexMatchesForFile('file.txt', lfText, re, out, matched, null);

    assert.equal(out.length, 2, 'two matches found');
    assert.ok(matched.has('file.txt'), 'path in matched set');

    // First match: line 1, column 1
    assert.equal(out[0].line, 1);
    assert.equal(out[0].column, 1);
    assert.equal(out[0].path, 'file.txt');

    // Second match: line 2, column 1
    assert.equal(out[1].line, 2);
    assert.equal(out[1].column, 1);

    // Preview text contains the match
    for (const r of out) {
      const { text, matchStart, matchEnd } = r.preview;
      assert.equal(text.slice(matchStart, matchEnd), 'tok',
        'preview excerpt matches "tok"');
    }
  });

  it('respects the atCap callback to stop early', () => {
    const lfText = 'a\na\na\n';
    const re = /a/g;
    const out = [];
    const matched = new Set();
    let calls = 0;
    // Allow only 1 result
    collectRegexMatchesForFile('x', lfText, re, out, matched, () => {
      calls++;
      return calls >= 1;
    });
    assert.equal(out.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 10. buildPreviewWindow — long-line windowing
// ---------------------------------------------------------------------------
describe('buildPreviewWindow long line', () => {
  it('returns text length <= 240 and keeps match inside the window', () => {
    // Build a line of 400 chars: 200 chars of padding, then 'MATCH', then more
    const before = 'a'.repeat(200);
    const matchStr = 'MATCH';
    const after = 'b'.repeat(195);
    const longLine = before + matchStr + after; // 400 chars total
    // Treat the whole thing as a single line (lineStart=0, lineEnd=longLine.length)
    const absStart = before.length;
    const absEnd = absStart + matchStr.length;
    const result = buildPreviewWindow(longLine, 0, longLine.length, absStart, absEnd);

    assert.ok(result.text.length <= 240, `preview text length ${result.text.length} <= 240`);
    assert.ok(result.matchStart >= 0);
    assert.ok(result.matchEnd <= 240);
    assert.ok(result.matchEnd >= result.matchStart);
    // The match should be visible in the excerpt
    assert.equal(
      result.text.slice(result.matchStart, result.matchEnd),
      matchStr,
      'windowed preview contains the original match text'
    );
  });

  it('returns the whole line when it is <= 240 chars', () => {
    const line = 'short line with match HERE done';
    const mS = line.indexOf('HERE');
    const mE = mS + 4;
    const result = buildPreviewWindow(line, 0, line.length, mS, mE);
    assert.equal(result.text, line);
    assert.equal(result.matchStart, mS);
    assert.equal(result.matchEnd, mE);
  });
});

// ---------------------------------------------------------------------------
// Extra: computeLineStarts + locate sanity
// ---------------------------------------------------------------------------
describe('computeLineStarts', () => {
  it('returns [0] for text with no newlines', () => {
    assert.deepEqual(computeLineStarts('hello'), [0]);
  });
  it('tracks positions after each newline', () => {
    assert.deepEqual(computeLineStarts('a\nb\nc'), [0, 2, 4]);
  });
});

describe('locate', () => {
  it('finds line and column for offset 0', () => {
    const text = 'ab\ncd\n';
    const ls = computeLineStarts(text);
    const r = locate(ls, text, 0);
    assert.equal(r.line, 1);
    assert.equal(r.column, 1);
  });
  it('finds line 2 correctly', () => {
    const text = 'ab\ncd\n';
    const ls = computeLineStarts(text);
    const r = locate(ls, text, 3); // 'c' on line 2
    assert.equal(r.line, 2);
    assert.equal(r.column, 1);
  });
});

// ---------------------------------------------------------------------------
// Regression guards for the adversarial-review findings
// ---------------------------------------------------------------------------
describe('zero-width regex never corrupts the buffer (data-loss guard)', () => {
  it("'a*' replaces only the non-empty 'a' run, not every empty position", () => {
    const r = applyReplaceToText('cat\ndog\n', { query: 'a*', replaceText: 'Z', useRegex: true });
    assert.equal(r.newRaw, 'cZt\ndog\n');
    assert.equal(r.count, 1);
  });
  it("'.?' replaces each non-empty single char and counts them accurately", () => {
    const r = applyReplaceToText('ab\n', { query: '.?', replaceText: 'X', useRegex: true });
    assert.equal(r.newRaw, 'XX\n');
    assert.equal(r.count, 2);
  });
  it("zero-width-only pattern like '\\\\b' makes no change (consistent with the find skipping zero-width)", () => {
    const r = applyReplaceToText('the cat', { query: '\\b', replaceText: '|', useRegex: true });
    assert.equal(r.newRaw, 'the cat');
    assert.equal(r.count, 0);
  });
  it("mixed pattern 'b*' counts the substitutions it actually performs", () => {
    const r = applyReplaceToText('abbc', { query: 'b*', replaceText: 'X', useRegex: true });
    // Only the non-empty 'bb' run is replaced.
    assert.equal(r.newRaw, 'aXc');
    assert.equal(r.count, 1);
  });
});

describe('lookaround substitution uses full match context (not the isolated slice)', () => {
  it('applyReplaceAtPosition replaces a lookahead match', () => {
    const r = applyReplaceAtPosition('barfoo', {
      line: 1, column: 1, query: 'bar(?=foo)', replaceText: 'X', useRegex: true,
    });
    assert.deepEqual(r, { newRaw: 'Xfoo', ok: true });
  });
  it('applyReplaceToText replaces a lookbehind match', () => {
    const r = applyReplaceToText('foobar', { query: '(?<=foo)bar', replaceText: 'X', useRegex: true });
    assert.equal(r.newRaw, 'fooX');
    assert.equal(r.count, 1);
  });
  it('applyReplaceAtPosition rejects a zero-width match position', () => {
    const r = applyReplaceAtPosition('abc', { line: 1, column: 1, query: 'x*', replaceText: 'Z', useRegex: true });
    assert.equal(r.ok, false);
    assert.equal(r.newRaw, 'abc');
  });
});

describe('bare-CR (classic Mac) endings survive a replace', () => {
  it('keeps CR endings and only changes the matched text', () => {
    const r = applyReplaceToText('a\rb\rc', { query: 'b', replaceText: 'X' });
    assert.equal(r.newRaw, 'a\rX\rc');
  });
  it('restoreEol maps LF back to CR for cr mode', () => {
    assert.equal(restoreEol('a\nb', 'cr'), 'a\rb');
  });
});

describe('expandReplacement mirrors String.prototype.replace patterns', () => {
  it('expands $1/$2, $&, $$ from the match object', () => {
    const m = /(\w+)=(\d+)/.exec('a=1');
    assert.equal(expandReplacement(m, '$2=$1'), '1=a');
    assert.equal(expandReplacement(m, '$&!'), 'a=1!');
    assert.equal(expandReplacement(m, '$$'), '$');
  });
  it('expands $` and $\\' + "'" + ' (prefix/suffix)', () => {
    const m = /b/.exec('abc');
    assert.equal(expandReplacement(m, '[$`|$' + "'" + ']'), '[a|c]');
  });
  it('expands named captures in preview, replace-all, and replace-at-position paths', () => {
    const query = '(?<first>\\w+) (?<last>\\w+)';
    const replaceText = '$<last>, $<first>';
    const preview = computeRegexPreviewReplacement({
      preview: { text: 'first last', matchStart: 0, matchEnd: 10 },
    }, { query, replaceText, caseSensitive: true });
    assert.equal(preview, 'last, first');
    assert.equal(applyReplaceToText('first last', {
      query, replaceText, useRegex: true, caseSensitive: true,
    }).newRaw, 'last, first');
    assert.equal(applyReplaceAtPosition('first last', {
      line: 1, column: 1, query, replaceText, useRegex: true, caseSensitive: true,
    }).newRaw, 'last, first');

    assert.equal(expandReplacement(/(x)/.exec('x'), '$<missing>'), '$<missing>');
    assert.equal(expandReplacement(/(?<known>x)/.exec('x'), '$<missing>'), '');
  });
});
