'use strict';

/* Outline providers (row 82 O1): the per-language symbol scanners behind the Outline view.
 * Pure functions over text or the TS navigation tree; no Monaco, no DOM. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../renderer/features/renderer-ide-outline-providers');

// name(children...) shape, for compact tree assertions.
function shape(symbols) {
  return symbols.map((s) => (s.children.length ? `${s.name}(${shape(s.children)})` : s.name)).join(',');
}

test('markdown: #, ## and ### headings nest into a three-level tree', () => {
  const text = ['# Guide', 'intro', '## Install', '### Windows', 'text', '### Linux', '## Use', '# Appendix'].join('\n');
  const out = providers.outlineFromText('markdown', text);
  assert.equal(out.truncated, '');
  assert.equal(shape(out.symbols), 'Guide(Install(Windows,Linux),Use),Appendix');
  const [guide] = out.symbols;
  assert.equal(guide.kind, 'heading');
  assert.equal(guide.line, 1);
  assert.equal(guide.endLine, 7, 'a section ends before the next heading of its level or higher');
  assert.equal(guide.children[0].children[0].line, 4);
  assert.equal(guide.children[0].children[0].endLine, 5);
  assert.equal(out.symbols[1].endLine, 8, 'the last section runs to the end of the file');
});

test('markdown: fences, front matter, closing hashes and setext headings', () => {
  const text = [
    '---', 'title: x', '# not a heading', '---',
    '# Top ##',
    '```js', '# inside a fence', '```',
    'Setext One', '==========',
    'Setext Two', '----------',
    '', '---',
    '- list item', '---',
    '#hashtag',
    '#', '##   ',
  ].join('\n');
  const out = providers.markdownOutline(text);
  assert.equal(shape(out.symbols), 'Top,Setext One(Setext Two)');
  assert.equal(out.symbols[1].line, 9, 'a setext heading sits on its text line');
});

test('python: def and class nest by indentation; strings, brackets and continuations do not', () => {
  const text = [
    'import os',
    'class Greeter:',
    '    """Docs.',
    'def not_a_def():',
    '    """',
    '    def greet(self,',
    'name):',
    '        return f"hi {name}"',
    '',
    '    async def later(self): pass',
    'x = (1 +',
    '  2)',
    'def top():',
    '\tdef inner():',
    '\t\tpass',
    '# comment',
    'y = 1',
  ].join('\n');
  const out = providers.pythonOutline(text);
  assert.equal(shape(out.symbols), 'Greeter(greet,later),top(inner)');
  const [greeter, top] = out.symbols;
  assert.equal(greeter.kind, 'class');
  assert.equal(greeter.children[0].kind, 'method');
  assert.equal(greeter.children[0].column, 9);
  assert.equal(greeter.endLine, 10, 'a class ends at its last code line');
  assert.equal(top.kind, 'function');
  assert.equal(top.children[0].kind, 'function');
  assert.equal(top.endLine, 15, 'a function ends before the next statement at its indentation');
});

test('json: keys to depth 3, array containers by index, comments and trailing commas tolerated', () => {
  const text = [
    '{',
    '  // a comment',
    '  "name": "jenny", /* inline */',
    '  "scripts": {',
    '    "build": "node build.js",',
    '    "deep": { "a": { "b": 1 } },',
    '  },',
    '  "list": [1, { "x": 2 }, [3]],',
    '  "esc\\"aped": null,',
    '}',
  ].join('\n');
  const out = providers.jsonOutline(text);
  assert.equal(shape(out.symbols), 'name,scripts(build,deep(a)),list(1(x),2),esc"aped');
  const scripts = out.symbols[1];
  assert.equal(scripts.line, 4);
  assert.equal(scripts.column, 4, 'the name column is inside the quote');
  assert.equal(scripts.endLine, 7);
  assert.equal(out.symbols[0].endLine, 3);
  assert.equal(providers.jsonOutline('[{"a":1},{"b":2}]').symbols.map((s) => s.name).join(), '0,1', 'a root array lists its containers');
  assert.equal(shape(providers.jsonOutline('{"a": {"b": {"c": {"d": 1}}}}', { maxDepth: 2 }).symbols), 'a(b)');
});

test('css: selectors and at-rules nest; strings, comments and SCSS interpolation do not open blocks', () => {
  const css = [
    '/* { not a rule } */',
    '@import "x.css";',
    '.a, .b {',
    '  content: "{";',
    '}',
    '@media (min-width: 10px) {',
    '  .c:hover { color: red; }',
    '}',
  ].join('\n');
  const out = providers.cssOutline(css);
  assert.equal(shape(out.symbols), '.a, .b,@media (min-width: 10px)(.c:hover)');
  assert.equal(out.symbols[0].kind, 'selector');
  assert.equal(out.symbols[1].kind, 'at-rule');
  assert.equal(out.symbols[0].endLine, 5);
  const scss = ['.card {', '  // a { comment', '  &-#{$name} { a: b; }', '  { anonymous: 1; .inner { x: y } }', '}'].join('\n');
  assert.equal(shape(providers.outlineFromText('scss', scss).symbols), '.card(&-#{$name},.inner)');
});

test('css: a long prelude stays linear (unbroken text, an unquoted data: URI) and keeps its name', () => {
  // The prelude was re-trimmed per character: 256 KB without `;` or `{` took ~13 s.
  const unbroken = 'a'.repeat(256 * 1024);
  const uri = `@font-face { src: url(data:font/woff2;base64,${'A'.repeat(200 * 1024)}); }\n.after { x: y }`;
  const started = Date.now();
  assert.deepEqual(providers.cssOutline(unbroken).symbols, []);
  assert.equal(shape(providers.cssOutline(uri).symbols), '@font-face,.after');
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
  // A heading or YAML line with a huge whitespace run (both regexes backtracked on it).
  const spaces = ' '.repeat(200 * 1024);
  const md = providers.outlineFromText('markdown', `# a${spaces}b\n## next`);
  const yaml = providers.outlineFromText('yaml', `key${spaces}x: 1\nother: 2`);
  assert.equal(md.symbols[0].name, 'a');
  assert.equal(shape(yaml.symbols), 'other');
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  const long = `.${'x'.repeat(5000)} { a: b }`;
  const name = providers.cssOutline(long).symbols[0].name;
  assert.ok(name.startsWith('.xxx') && name.length <= 240);
});

test('yaml: top-level keys only, each running to the line before the next', () => {
  const text = ['# c', 'name: ci', 'on:', '  push:', '    branches: [main]', '"quoted key": 1', 'jobs:', '- a', '---', 'second: doc', ''].join('\n');
  const out = providers.yamlOutline(text);
  assert.deepEqual(out.symbols.map((s) => [s.name, s.line, s.endLine]), [
    ['name', 2, 2], ['on', 3, 5], ['quoted key', 6, 6], ['jobs', 7, 8], ['second', 10, 10],
  ]);
});

test('navigation tree: VS Code inclusion rule, name position, span range', () => {
  const src = 'import x from "y";\nclass Greeter {\n  greet() {}\n}\nfoo(function () { function named() {} });\n';
  const lineStarts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') lineStarts.push(i + 1);
  const positionAt = (offset) => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line += 1;
    return { lineNumber: line + 1, column: offset - lineStarts[line] + 1 };
  };
  const at = (text) => src.indexOf(text);
  const tree = {
    text: '"file"', kind: 'module', spans: [{ start: 0, length: src.length }],
    childItems: [
      { text: 'x', kind: 'alias', spans: [{ start: 7, length: 1 }] },
      {
        text: 'Greeter', kind: 'class', spans: [{ start: at('class'), length: at('}\nfoo') + 1 - at('class') }], nameSpan: { start: at('Greeter'), length: 7 },
        childItems: [{ text: 'greet', kind: 'method', spans: [{ start: at('greet'), length: 10 }] }],
      },
      {
        text: '<function>', kind: 'function', spans: [{ start: at('function ()'), length: 30 }],
        childItems: [{ text: 'named', kind: 'function', spans: [{ start: at('function named'), length: 19 }], nameSpan: { start: at('named'), length: 5 } }],
      },
    ],
  };
  const out = providers.outlineFromNavigationTree(tree, positionAt);
  assert.equal(shape(out.symbols), 'Greeter(greet),named', 'aliases and anonymous functions are dropped; a named child is kept');
  const greeter = out.symbols[0];
  assert.deepEqual([greeter.line, greeter.column, greeter.startLine, greeter.endLine], [2, 7, 2, 4]);
  assert.equal(out.symbols[1].line, 5);
  const capped = providers.outlineFromNavigationTree(tree, positionAt, { maxOffset: at('foo') });
  assert.equal(shape(capped.symbols), 'Greeter(greet)');
  assert.equal(capped.truncated, 'size');
});

test('bounds: the symbol cap and the text cap stop the scan and say which', () => {
  const many = Array.from({ length: 30 }, (_, i) => `# h${i}`).join('\n');
  const capped = providers.markdownOutline(many, { maxSymbols: 10 });
  assert.equal(capped.symbols.length, 10);
  assert.equal(capped.truncated, 'symbols');
  const sized = providers.outlineFromText('markdown', '# a\n# b\n# c\n', { maxTextChars: 8 });
  assert.equal(shape(sized.symbols), 'a,b');
  assert.equal(sized.truncated, 'size');
  assert.equal(providers.MAX_SYMBOLS, 2000);
  assert.equal(providers.MAX_TEXT_CHARS, 1024 * 1024);
  const big = Array.from({ length: 2100 }, (_, i) => `k${i}: 1`).join('\n');
  const yaml = providers.yamlOutline(big);
  assert.equal(yaml.symbols.length, 2000);
  assert.equal(yaml.truncated, 'symbols');
});

test('providerFor maps languages first and extensions for plain text; unknown types have none', () => {
  assert.equal(providers.providerFor('typescript', 'a.ts'), 'navtree');
  assert.equal(providers.providerFor('javascript', 'a.js'), 'navtree');
  assert.equal(providers.providerFor('markdown', ''), 'markdown');
  assert.equal(providers.providerFor('scss', 'a.scss'), 'css');
  assert.equal(providers.providerFor('plaintext', 'ci.yml'), 'yaml');
  assert.equal(providers.providerFor('', 'tool.PY'), 'python');
  assert.equal(providers.providerFor('rust', 'a.rs'), null);
  assert.equal(providers.providerFor('plaintext', 'notes.txt'), null);
  assert.deepEqual(providers.outlineFromText('rust', 'fn main() {}'), { symbols: [], truncated: '', supported: false });
});

test('findActivePath picks the innermost range; sortSymbols sorts by position or by name', () => {
  const { symbols } = providers.pythonOutline(['class B:', '    def z(self): pass', '    def a(self):', '        pass', 'def A():', '    pass'].join('\n'));
  assert.deepEqual(providers.findActivePath(symbols, 4).map((s) => s.name), ['B', 'a']);
  assert.deepEqual(providers.findActivePath(symbols, 6).map((s) => s.name), ['A']);
  assert.deepEqual(providers.findActivePath(symbols, 99), []);
  assert.equal(shape(providers.sortSymbols(symbols, 'name')), 'A,B(a,z)');
  assert.equal(shape(providers.sortSymbols(symbols, 'position')), 'B(z,a),A');
  assert.equal(shape(symbols), 'B(z,a),A', 'sorting copies');
});

test('keys stay stable across edits that keep ancestry, and disambiguate duplicates', () => {
  const before = providers.markdownOutline('# A\n## B\n## B\n');
  const after = providers.markdownOutline('intro\n\n# A\ntext\n## B\n## B\n');
  assert.deepEqual(before.symbols[0].children.map((s) => s.key), after.symbols[0].children.map((s) => s.key));
  assert.notEqual(before.symbols[0].children[0].key, before.symbols[0].children[1].key);
});
