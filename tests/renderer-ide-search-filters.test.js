'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const filters = require('../renderer/features/renderer-ide-search-filters');

test('parseGlobField splits, normalizes slashes, anchors ./ and caps entries', () => {
  assert.deepEqual(filters.parseGlobField('src, *.md\n docs\\api'), ['src', '*.md', 'docs/api']);
  assert.deepEqual(filters.parseGlobField('./src/**, ./'), ['/src/**']);
  assert.deepEqual(filters.parseGlobField(''), []);
  assert.deepEqual(filters.parseGlobField('x'.repeat(257) + ',ok'), ['ok']);
  const many = Array.from({ length: 80 }, (_, i) => `d${i}`).join(',');
  assert.equal(filters.parseGlobField(many).length, 32);
});

test('sanitizeGlobList ignores non-arrays and coerces/caps entries', () => {
  assert.deepEqual(filters.sanitizeGlobList('src'), []);
  assert.deepEqual(filters.sanitizeGlobList({ a: 1 }), []);
  assert.deepEqual(filters.sanitizeGlobList([' src ', 5, null, {}, 'a\\b', 'y'.repeat(300)]), ['src', '5', 'a/b']);
  assert.equal(filters.sanitizeGlobList(Array.from({ length: 50 }, () => 'x')).length, 32);
});

test('createSearchPathFilter: a plain folder name covers everything below it', () => {
  const filter = filters.createSearchPathFilter({ include: ['src'] });
  assert.equal(filter.active, true);
  assert.equal(filter.includesFile('src/a.js'), true);
  assert.equal(filter.includesFile('src/deep/b.js'), true);
  assert.equal(filter.includesFile('lib/src/c.js'), true, 'basename rule: src anywhere');
  assert.equal(filter.includesFile('docs/a.md'), false);
  assert.equal(filter.includesFile('README.md'), false);
});

test('createSearchPathFilter: globs, anchors and extensions', () => {
  const ext = filters.createSearchPathFilter({ include: ['*.md'] });
  assert.equal(ext.includesFile('README.md'), true);
  assert.equal(ext.includesFile('docs/guide.md'), true);
  assert.equal(ext.includesFile('src/a.js'), false);
  const anchored = filters.createSearchPathFilter({ include: ['/src/deep'] });
  assert.equal(anchored.includesFile('src/deep/b.js'), true);
  assert.equal(anchored.includesFile('x/src/deep/b.js'), false);
});

test('createSearchPathFilter: empty filters include everything and are inactive', () => {
  const filter = filters.createSearchPathFilter({});
  assert.equal(filter.active, false);
  assert.equal(filter.includesFile('a/b.js'), true);
  assert.equal(filter.excludesFile('a/b.js'), false);
  assert.equal(filter.excludesDirectory('a'), false);
});

test('createSearchPathFilter: exclude prunes directories and files below them', () => {
  const filter = filters.createSearchPathFilter({ exclude: ['node_modules', 'dist', '*.log', 'docs/'] });
  assert.equal(filter.excludesDirectory('node_modules'), true);
  assert.equal(filter.excludesDirectory('pkg/node_modules'), true);
  assert.equal(filter.excludesDirectory('src'), false);
  assert.equal(filter.excludesFile('node_modules/pkg/index.js'), true);
  assert.equal(filter.excludesFile('dist/a.js'), true);
  assert.equal(filter.excludesFile('a/b.log'), true);
  assert.equal(filter.excludesFile('src/a.js'), false);
  // Trailing slash: directories only, so a FILE named docs is kept but its folder is pruned.
  assert.equal(filter.excludesDirectory('docs'), true);
  assert.equal(filter.excludesFile('docs'), false);
  assert.equal(filter.excludesFile('docs/readme.md'), true);
  assert.equal(filter.acceptsFile('src/a.js'), true);
  assert.equal(filter.acceptsFile('dist/a.js'), false);
});

test('createSearchPathFilter: include + exclude compose and malformed patterns match nothing', () => {
  const filter = filters.createSearchPathFilter({ include: ['src'], exclude: ['*.test.js'] });
  assert.equal(filter.acceptsFile('src/a.js'), true);
  assert.equal(filter.acceptsFile('src/a.test.js'), false);
  assert.equal(filter.acceptsFile('lib/a.js'), false);
  const junk = filters.createSearchPathFilter({ include: ['['] });
  assert.doesNotThrow(() => junk.includesFile('a.js'));
});

test('whole word only guards the sides of the query that are word characters', () => {
  const r = filters.resolveEffectiveFind({ query: 'foo(', wholeWord: true });
  assert.ok(new RegExp(r.query).test('foo(x'), 'a trailing paren needs no boundary');
  assert.ok(!new RegExp(r.query).test('afoo(x'), 'the word start still does');
  assert.equal(filters.wholeWordSource('\\$x', '$x'), '(?:\\$x)(?![A-Za-z0-9_])');
});

test('wholeWordSource wraps with word-char lookarounds', () => {
  assert.equal(filters.wholeWordSource('a|b'), '(?<![A-Za-z0-9_])(?:a|b)(?![A-Za-z0-9_])');
  const re = new RegExp(filters.wholeWordSource('test'), 'g');
  assert.deepEqual('a test. (test) testing retest test_x'.match(re), ['test', 'test']);
});

test('resolveEffectiveFind leaves the query alone without wholeWord', () => {
  assert.deepEqual(
    filters.resolveEffectiveFind({ query: 'a.b', replaceText: '$1', useRegex: false, wholeWord: false }),
    { query: 'a.b', replaceText: '$1', useRegex: false }
  );
  assert.deepEqual(
    filters.resolveEffectiveFind({ query: 'a+', replaceText: '$1', useRegex: true }),
    { query: 'a+', replaceText: '$1', useRegex: true }
  );
});

test('resolveEffectiveFind folds wholeWord into a regex and keeps literal text literal', () => {
  const literal = filters.resolveEffectiveFind({ query: 'a.b', replaceText: 'cost $5 $&', useRegex: false, wholeWord: true });
  assert.equal(literal.useRegex, true);
  assert.equal(literal.query, '(?<![A-Za-z0-9_])(?:a\\.b)(?![A-Za-z0-9_])');
  assert.equal(literal.replaceText, 'cost $$5 $$&');
  assert.equal('x a.b y axb'.replace(new RegExp(literal.query, 'g'), literal.replaceText), 'x cost $5 $& y axb');
  const regex = filters.resolveEffectiveFind({ query: 'te(s)t', replaceText: '[$1]', useRegex: true, wholeWord: true });
  assert.equal(regex.query, '(?<![A-Za-z0-9_])(?:te(s)t)(?![A-Za-z0-9_])');
  assert.equal(regex.replaceText, '[$1]', 'regex replacement templates are untouched');
});

test('pushSearchHistory: newest last, trimmed, de-duplicated, short queries ignored, capped', () => {
  assert.deepEqual(filters.pushSearchHistory([], '  foo  '), ['foo']);
  assert.deepEqual(filters.pushSearchHistory(['foo', 'bar'], 'foo'), ['bar', 'foo']);
  const original = ['foo'];
  assert.deepEqual(filters.pushSearchHistory(original, 'x'), ['foo']);
  assert.notEqual(filters.pushSearchHistory(original, 'x'), original, 'always a new array');
  assert.deepEqual(filters.pushSearchHistory(original, '   '), ['foo']);
  let list = [];
  for (let i = 0; i < 30; i += 1) list = filters.pushSearchHistory(list, `query${i}`);
  assert.equal(list.length, 20);
  assert.equal(list[0], 'query10');
  assert.equal(list[19], 'query29');
});

test('stepSearchHistory: ArrowUp walks older, ArrowDown walks newer and returns to the draft', () => {
  const list = ['one', 'two', 'three'];
  assert.equal(filters.stepSearchHistory([], -1, 'up'), null);
  assert.deepEqual(filters.stepSearchHistory(list, -1, 'up', 'draft'), { cursor: 2, value: 'three' });
  assert.deepEqual(filters.stepSearchHistory(list, 2, 'up', 'draft'), { cursor: 1, value: 'two' });
  assert.deepEqual(filters.stepSearchHistory(list, 0, 'up', 'draft'), { cursor: 0, value: 'one' });
  assert.deepEqual(filters.stepSearchHistory(list, 0, 'down', 'draft'), { cursor: 1, value: 'two' });
  assert.deepEqual(filters.stepSearchHistory(list, 2, 'down', 'my draft'), { cursor: -1, value: 'my draft' });
  assert.equal(filters.stepSearchHistory(list, -1, 'down', 'draft'), null);
  assert.deepEqual(filters.stepSearchHistory(list, 2, 'down'), { cursor: -1, value: '' });
});

test('buildSearchOptions is set-only so the plain payload stays untouched', () => {
  assert.deepEqual(filters.buildSearchOptions({}), {});
  assert.deepEqual(filters.buildSearchOptions({ wholeWord: false, includeText: ' ', excludeText: '' }), {});
  assert.deepEqual(
    filters.buildSearchOptions({ wholeWord: true, includeText: 'src, ./lib', excludeText: '*.log' }),
    { wholeWord: true, include: ['src', '/lib'], exclude: ['*.log'] }
  );
  assert.deepEqual(filters.buildSearchOptions(null), {});
});

// X1: anchored-include pruning. skipsDirectory(dir) may only answer true when no accepted
// file can live under dir, for every pattern shape (VS Code-style: only a leading '/'
// anchors; a pattern with an inner '/' still matches at any depth).
const X1_FILES = [
  'src/a.js', 'src/lib/b.js', 'src/lib/deep/c.ts', 'docs/src/x.js', 'docs/a/y.md', 'docs/b/z.md', 'lib/x',
  'lib/a/x', 'a/b/x', 'README.md', 'srcx/a.js', 's1/k.js', 'tests/x/y/z.js', '!docs/n.md', 'pkg/src/lib/q.js',
];
const X1_PATTERNS = [
  ['**/x'], ['src/**'], ['*.js'], ['/src/**'], ['/src'], ['/src/'], ['/src/lib/*.js'], ['/s*/**'],
  ['/{src,lib}/**'], ['!docs'], ['/docs/[ab]/**'], ['/src/**', '*.md'], ['/tests/**/z.js'], ['/lib/x'], ['['],
];

function ancestorsOf(file) {
  const parts = file.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

test('X1: skipsDirectory never prunes a directory that holds an accepted file', () => {
  for (const include of X1_PATTERNS) {
    for (const exclude of [[], ['*.md']]) {
      const filter = filters.createSearchPathFilter({ include, exclude });
      for (const file of X1_FILES) {
        if (!filter.acceptsFile(file)) continue;
        for (const dir of ancestorsOf(file)) {
          assert.equal(filter.skipsDirectory(dir), false, `${JSON.stringify(include)} must walk ${dir} for ${file}`);
        }
      }
    }
  }
});

test('X1: an anchored include prunes unrelated directories; unanchored shapes prune nothing', () => {
  const anchored = filters.createSearchPathFilter({ include: ['/src/**'] });
  assert.equal(anchored.skipsDirectory('docs'), true);
  assert.equal(anchored.skipsDirectory('docs/src'), true);
  assert.equal(anchored.skipsDirectory('srcx'), true);
  assert.equal(anchored.skipsDirectory('src'), false);
  assert.equal(anchored.skipsDirectory('src/lib/deep'), false);
  const literal = filters.createSearchPathFilter({ include: ['/src/lib/*.js'] });
  assert.deepEqual(['src', 'src/lib', 'src/other', 'docs'].map(literal.skipsDirectory), [false, false, true, true]);
  for (const include of [['**/x'], ['src/**'], ['*.js'], ['/s*/**'], ['!docs'], ['/src/**', '*.md'], []]) {
    const filter = filters.createSearchPathFilter({ include });
    assert.equal(filter.skipsDirectory('docs'), false, JSON.stringify(include));
    assert.equal(filter.skipsDirectory('a/b/c'), false, JSON.stringify(include));
  }
  // Exclude still prunes the way it did.
  assert.equal(filters.createSearchPathFilter({ exclude: ['vendor'] }).skipsDirectory('pkg/vendor'), true);
});
