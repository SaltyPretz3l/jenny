'use strict';

/* Shared glob matcher (row 82 seed): VS Code files.exclude / .editorconfig section
 * semantics, regex-safe, never throws. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { compile, matchAny, parseList, compileAll } = require('../renderer/shared/glob-match');

test('a pattern without a slash matches a basename at any depth', () => {
  const m = compile('*.ts');
  assert.equal(m.test('a.ts'), true);
  assert.equal(m.test('src/deep/a.ts'), true);
  assert.equal(m.test('src/a.tsx'), false);
  assert.equal(compile('node_modules').test('packages/x/node_modules'), true);
  assert.equal(compile('node_modules').test('packages/x/node_modules_extra'), false);
});

test('a slash makes the pattern path-relative and a leading slash anchors it', () => {
  assert.equal(compile('src/*.ts').test('src/a.ts'), true);
  assert.equal(compile('src/*.ts').test('src/deep/a.ts'), false);
  assert.equal(compile('src/*.ts').test('pkg/src/a.ts'), true);
  assert.equal(compile('/src/*.ts').test('pkg/src/a.ts'), false);
  assert.equal(compile('/src/*.ts').test('src/a.ts'), true);
});

test('double star crosses segments', () => {
  const m = compile('src/**/*.test.js');
  assert.equal(m.test('src/a.test.js'), true);
  assert.equal(m.test('src/x/y/a.test.js'), true);
  assert.equal(m.test('lib/a.test.js'), false);
  assert.equal(compile('**/dist').test('a/b/dist'), true);
  assert.equal(compile('**/dist').test('dist'), true);
  assert.equal(compile('docs/**').test('docs/a/b.md'), true);
  assert.equal(compile('docs/**').test('docsx/a.md'), false);
});

test('question marks, classes, negated classes and braces', () => {
  assert.equal(compile('a?.js').test('ab.js'), true);
  assert.equal(compile('a?.js').test('abc.js'), false);
  assert.equal(compile('[abc].js').test('b.js'), true);
  assert.equal(compile('[a-c].js').test('d.js'), false);
  assert.equal(compile('[!a].js').test('a.js'), false);
  assert.equal(compile('[!a].js').test('z.js'), true);
  const braces = compile('*.{js,ts,md}');
  assert.equal(braces.test('x/a.ts'), true);
  assert.equal(braces.test('x/a.md'), true);
  assert.equal(braces.test('x/a.py'), false);
  assert.equal(compile('{package,tsconfig}.json').test('tsconfig.json'), true);
});

test('a trailing slash matches directories only', () => {
  const m = compile('build/');
  assert.equal(m.test('build'), false);
  assert.equal(m.test('build', { isDir: true }), true);
  assert.equal(m.test('pkg/build', { isDir: true }), true);
  assert.equal(m.dirOnly, true);
});

test('literal regex characters never escape', () => {
  assert.equal(compile('a.b').test('axb'), false);
  assert.equal(compile('a.b').test('a.b'), true);
  assert.equal(compile('a+b(c)').test('a+b(c)'), true);
  assert.equal(compile('(.*)').test('anything'), false);
  assert.equal(compile('$^|').test('$^|'), true);
});

test('backslashes and dot-slash prefixes normalize on both sides', () => {
  assert.equal(compile('src\\*.ts').test('src\\a.ts'), true);
  assert.equal(compile('src/*.ts').test('./src/a.ts'), true);
  assert.equal(compile('/src/*.ts').test('/src/a.ts'), true);
});

test('malformed or oversized input matches nothing and never throws', () => {
  assert.equal(compile('').test('a'), false);
  assert.equal(compile(null).test('a'), false);
  assert.equal(compile('/').test('a'), false);
  assert.equal(compile('[abc').test('[abc'), true);
  assert.equal(compile('x'.repeat(600)).test('x'), false);
  assert.equal(compile('*').test('y'.repeat(5000)), false);
  assert.equal(compile('{a,b').test('{a,b'), true);
});

test('parseList keeps a brace alternation together', () => {
  assert.deepEqual(parseList('*.{js,ts}, src/**/*.{css,scss}\nlib'), ['*.{js,ts}', 'src/**/*.{css,scss}', 'lib']);
  assert.ok(matchAny(parseList('*.{js,ts}'), 'a.ts'));
  assert.deepEqual(parseList('a,{b'), ['a', '{b'], 'an unclosed brace swallows nothing past the end');
});

test('wildcard-heavy patterns compile to never instead of backtracking', () => {
  const name = 'a'.repeat(100);
  const started = Date.now();
  assert.equal(compile('*a*a*a*a*b').test(name), false);
  assert.equal(compile('**/*a*/**/*a*/**/*a*/**/*a*/**/b').test(name + '/' + name), false);
  assert.ok(Date.now() - started < 200, 'rejected without a scan');
  assert.equal(compile('*a*a*b').test('xaxaxb'), true, 'three stars in a segment still match');
  assert.equal(compile('src/***/x.js').test('src/deep/er/x.js'), true, 'a star run collapses to a globstar');
});

test('matchAny accepts raw patterns or compiled matchers; parseList splits fields', () => {
  assert.deepEqual(parseList(' src/**, *.md \n !keep '), ['src/**', '*.md', '!keep']);
  assert.equal(matchAny(['*.md', 'src/**'], 'src/x.ts'), true);
  assert.equal(matchAny(['*.md'], 'src/x.ts'), false);
  const compiled = compileAll(['*.md', '']);
  assert.equal(compiled.length, 1);
  assert.equal(matchAny(compiled, 'README.md'), true);
  assert.equal(matchAny([], 'README.md'), false);
});
