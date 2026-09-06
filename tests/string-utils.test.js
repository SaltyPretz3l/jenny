const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeString,
  normalizeId,
  stripInlineMarkdownLabel,
} = require('../renderer/shared/string-utils');

test('normalizeString coerces null and undefined to empty string', () => {
  assert.equal(normalizeString(null), '');
  assert.equal(normalizeString(undefined), '');
  assert.equal(normalizeString(''), '');
});

test('normalizeString trims whitespace', () => {
  assert.equal(normalizeString('  hello  '), 'hello');
  assert.equal(normalizeString('\thello\n'), 'hello');
});

test('normalizeString treats falsy values as empty string', () => {
  assert.equal(normalizeString(0), '');
  assert.equal(normalizeString(false), '');
  assert.equal(normalizeString(42), '42');
  assert.equal(normalizeString('hello'), 'hello');
});

test('normalizeId behaves identically to normalizeString', () => {
  assert.equal(normalizeId(null), '');
  assert.equal(normalizeId('  abc-123  '), 'abc-123');
  assert.equal(normalizeId(0), '');
});

test('stripInlineMarkdownLabel unwraps paired emphasis, code, links and block markers', () => {
  assert.equal(stripInlineMarkdownLabel('**Testing local file URL access**'), 'Testing local file URL access');
  assert.equal(stripInlineMarkdownLabel('### **Checking config**'), 'Checking config');
  assert.equal(stripInlineMarkdownLabel('__Whole label__'), 'Whole label');
  assert.equal(stripInlineMarkdownLabel('reviewing `git status` output'), 'reviewing git status output');
  assert.equal(stripInlineMarkdownLabel('- Ship the **release** notes'), 'Ship the release notes');
  assert.equal(stripInlineMarkdownLabel('2. Follow up with [the vendor](https://x.test)'), 'Follow up with the vendor');
  assert.equal(stripInlineMarkdownLabel('> quoted title'), 'quoted title');
  assert.equal(stripInlineMarkdownLabel('collapse   runs\nof   whitespace'), 'collapse runs of whitespace');
});

test('stripInlineMarkdownLabel preserves identifiers and unpaired markers', () => {
  assert.equal(stripInlineMarkdownLabel('Checking __init__.py imports'), 'Checking __init__.py imports');
  assert.equal(stripInlineMarkdownLabel('inspect **kwargs handling'), 'inspect **kwargs handling');
  assert.equal(stripInlineMarkdownLabel('Verify snake_case and *partial'), 'Verify snake_case and *partial');
  assert.equal(stripInlineMarkdownLabel('rename my_var to your_var'), 'rename my_var to your_var');
  assert.equal(stripInlineMarkdownLabel('Fix _leading underscore ids'), 'Fix _leading underscore ids');
});

test('stripInlineMarkdownLabel coerces empty and non-string inputs', () => {
  assert.equal(stripInlineMarkdownLabel(''), '');
  assert.equal(stripInlineMarkdownLabel(null), '');
  assert.equal(stripInlineMarkdownLabel(undefined), '');
  assert.equal(stripInlineMarkdownLabel(0), '0');
});

test('stripInlineMarkdownLabel unwraps whole-label single emphasis and parenthesized links', () => {
  assert.equal(stripInlineMarkdownLabel('*Ship the release*'), 'Ship the release');
  assert.equal(stripInlineMarkdownLabel('_Ship the release_'), 'Ship the release');
  assert.equal(stripInlineMarkdownLabel('***Urgent***'), 'Urgent');
  assert.equal(
    stripInlineMarkdownLabel('[Array](https://en.wikipedia.org/wiki/Array_(data_structure))'),
    'Array'
  );
  // Interior single markers still survive — whole-label only.
  assert.equal(stripInlineMarkdownLabel('compare *args and **kwargs'), 'compare *args and **kwargs');
  assert.equal(stripInlineMarkdownLabel('Fix _leading underscore ids'), 'Fix _leading underscore ids');
});
