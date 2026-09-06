'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const streamRenderer = require('../renderer/shared/markdown-stream-renderer');
const mermaidText = require('../renderer/shared/markdown-mermaid-text');
const mathUtils = require('../renderer/shared/markdown-math-utils');
const markdownUtils = require('../renderer/shared/markdown-utils');
const codeHighlight = require('../renderer/chat/renderer-code-highlight');

const scanDependencies = { mermaidText, mathUtils };

test('stable-prefix scan holds continuations and open constructs in the tail', () => {
  assert.equal(streamRenderer.findStablePrefixEnd('First.\n\nSecond.', scanDependencies), 8);
  assert.equal(streamRenderer.findStablePrefixEnd('First.\n\n```js\ncode', scanDependencies), 8);
  assert.equal(streamRenderer.findStablePrefixEnd('First.\n\n$$\nx + y', scanDependencies), 8);
  assert.equal(streamRenderer.findStablePrefixEnd('First.\nSecond.\n```js\ncode', scanDependencies), 15);
  assert.equal(streamRenderer.findStablePrefixEnd('- item\n  ```js\n  code', scanDependencies), 0);
  assert.equal(streamRenderer.findStablePrefixEnd('<div></div>\n```js\ncode\n', scanDependencies), 0);
  assert.equal(streamRenderer.findStablePrefixEnd('First.\n```', scanDependencies), 0);
  assert.equal(streamRenderer.findStablePrefixEnd('First.\n```js\n', scanDependencies), 7);
  assert.equal(streamRenderer.findStablePrefixEnd('- one\n\n- two', scanDependencies), 0);
  assert.equal(streamRenderer.findStablePrefixEnd('| A |\n| - |\n| 1 |\n\n| 2 |', scanDependencies), 0);
  assert.equal(streamRenderer.findStablePrefixEnd('```js\nconst x = 1;\n\nstill code', scanDependencies), 0);
  assert.equal(streamRenderer.findStablePrefixEnd('$$\nx + y\n\nstill math', scanDependencies), 0);
  assert.equal(streamRenderer.findStablePrefixEnd('- one\n\nParagraph.', scanDependencies), 7);
  assert.equal(streamRenderer.findStablePrefixEnd('- one\n\n```js\ncode', scanDependencies), 7);
  assert.equal(streamRenderer.findStablePrefixEnd('First.\n\n```js\ncode\n\nmore code', scanDependencies), 8);
  assert.equal(streamRenderer.findStablePrefixEnd('[docs]\n\nParagraph.', scanDependencies), 0);
  assert.equal(streamRenderer.findStablePrefixEnd('<pre>\nalpha\n\nbeta', scanDependencies), 0);
  assert.equal(streamRenderer.findStablePrefixEnd('<mark>\nalpha\n\nbeta', scanDependencies), 0);
  assert.equal(streamRenderer.findStablePrefixEnd('<!--\nalpha\n\nbeta', scanDependencies), 0);
  assert.equal(streamRenderer.findStablePrefixEnd('<custom-box>\nalpha\n\nbeta', scanDependencies), 0);
  assert.equal(streamRenderer.findStablePrefixEnd('`inline code\n\ncontinues`', scanDependencies), 0);
  assert.equal(streamRenderer.findStablePrefixEnd('- [ ] done\n\nParagraph.', scanDependencies), 12);
});

test('plain HTML mode promotes a prefix containing an unbalanced raw tag', () => {
  const initialSource = 'First <script>';
  const source = `${initialSource}\n\nSecond.`;
  const plainInitial = markdownUtils.renderStreamingMarkdownUnits(initialSource, { mermaid: 'plain' });
  const plain = markdownUtils.renderStreamingMarkdownUnits(source, { mermaid: 'plain', previousUnits: plainInitial.units });
  const answerInitial = markdownUtils.renderStreamingMarkdownUnits(initialSource);
  const answer = markdownUtils.renderStreamingMarkdownUnits(source, { previousUnits: answerInitial.units });

  assert.ok(plain.streamState.stablePrefixEnd > 0);
  assert.equal(answer.streamState.stablePrefixEnd, 0);
});

test('append-only rendering reuses a proven prefix and matches a full render', () => {
  const first = markdownUtils.renderStreamingMarkdownUnits('First paragraph.');
  const second = markdownUtils.renderStreamingMarkdownUnits(
    'First paragraph.\n\nSecond paragraph.',
    { previousUnits: first.units }
  );
  const thirdSource = 'First paragraph.\n\nSecond paragraph. More text grows.';
  const third = markdownUtils.renderStreamingMarkdownUnits(thirdSource, { previousUnits: second.units });
  const full = markdownUtils.renderStreamingMarkdownUnits(thirdSource);

  assert.equal(first.renderMode, 'full');
  assert.equal(first.fallbackReason, 'initial');
  assert.equal(second.renderMode, 'incremental');
  assert.equal(third.renderMode, 'incremental');
  assert.equal(third.changedStartIndex, 1);
  assert.equal(third.html, full.html);
  assert.ok(third.streamState.stablePrefixEnd > 0);
  assert.equal(Object.isFrozen(third.streamState), true);
  assert.equal(Object.isFrozen(third.streamState.prefixUnits), true);
});

test('source replacement and malformed state fail back to a complete render', () => {
  const initial = markdownUtils.renderStreamingMarkdownUnits('Original paragraph.');
  const replaced = markdownUtils.renderStreamingMarkdownUnits('Replacement paragraph.', {
    previousUnits: initial.units,
  });
  const malformed = markdownUtils.renderStreamingMarkdownUnits('Replacement paragraph grows.', {
    previousUnits: replaced.units,
    previousStreamState: { version: 1, source: null },
  });
  const inconsistent = markdownUtils.renderStreamingMarkdownUnits('Replacement paragraph grows again.', {
    previousUnits: replaced.units,
    previousStreamState: {
      version: 1,
      source: 'Replacement paragraph.',
      stablePrefixEnd: 4,
      prefixUnits: [],
    },
  });

  assert.equal(replaced.renderMode, 'full');
  assert.equal(replaced.fallbackReason, 'source_replaced');
  assert.equal(malformed.renderMode, 'full');
  assert.equal(malformed.fallbackReason, 'invalid_state');
  assert.equal(inconsistent.fallbackReason, 'invalid_state');
});

test('unissued state cannot inject unsanitized prefix HTML', () => {
  const forged = markdownUtils.renderStreamingMarkdownUnits('safe tail', {
    previousStreamState: {
      version: 1,
      source: 'safe',
      stablePrefixEnd: 4,
      prefixUnits: [{ html: '<img src=x onerror=alert(1)>', fingerprint: 'forged' }],
    },
  });

  assert.equal(forged.renderMode, 'full');
  assert.equal(forged.fallbackReason, 'invalid_state');
  assert.doesNotMatch(forged.html, /onerror|<img/i);
});

test('reference links and raw block HTML stay byte-equivalent to a full render', () => {
  const cases = [
    ['[docs]\n\nParagraph.', '[docs]\n\nParagraph.\n\n[docs]: https://example.com'],
    ['[docs]: https://example.com\n\nParagraph.', '[docs]: https://example.com\n\nParagraph.\n\nSee [docs].'],
    ['<pre>\nalpha\n\nbeta', '<pre>\nalpha\n\nbeta\n\ngamma\n</pre>'],
    ['<div>\nalpha\n\nbeta', '<div>\nalpha\n\nbeta\n\ngamma\n</div>'],
    ['<blockquote>\nalpha\n\nbeta', '<blockquote>\nalpha\n\nbeta\n\ngamma\n</blockquote>'],
    ['<table>\n<tr><td>alpha</td></tr>\n\nbeta', '<table>\n<tr><td>alpha</td></tr>\n\nbeta\n\n<tr><td>gamma</td></tr>\n</table>'],
    ['<mark>\nalpha\n\nbeta', '<mark>\nalpha\n\nbeta\n\ngamma\n</mark>'],
    ['<!--\nalpha\n\nbeta', '<!--\nalpha\n\nbeta\n\ngamma\n-->'],
    ['<script>\nalpha\n\nbeta', '<script>\nalpha\n\nbeta\n\ngamma\n</script>'],
    ['`inline code\n\nbeta', '`inline code\n\nbeta\n\ngamma`'],
  ];

  for (const [firstSource, nextSource] of cases) {
    const first = markdownUtils.renderStreamingMarkdownUnits(firstSource);
    const next = markdownUtils.renderStreamingMarkdownUnits(nextSource, { previousUnits: first.units });
    const full = markdownUtils.renderStreamingMarkdownUnits(nextSource);
    assert.equal(next.html, full.html, nextSource);
  }
});

test('balanced inline HTML and task markers retain safe incremental reuse', () => {
  const cases = [
    ['Before <kbd>Ctrl</kbd>.', 'Before <kbd>Ctrl</kbd>.\n\nSecond paragraph.'],
    ['Visit <https://example.com>.', 'Visit <https://example.com>.\n\nSecond paragraph.'],
    ['First<br>line.', 'First<br>line.\n\nSecond paragraph.'],
    ['- [ ] done', '- [ ] done\n\nSecond paragraph.'],
  ];

  for (const [firstSource, nextSource] of cases) {
    const first = markdownUtils.renderStreamingMarkdownUnits(firstSource);
    const next = markdownUtils.renderStreamingMarkdownUnits(nextSource, { previousUnits: first.units });
    const full = markdownUtils.renderStreamingMarkdownUnits(nextSource);
    assert.equal(next.renderMode, 'incremental', nextSource);
    assert.equal(next.html, full.html, nextSource);
  }
});

test('missing structural guards force a complete render', () => {
  const renderChunk = (source) => ({ html: `<p>${source}</p>`, fragment: null });
  const initial = streamRenderer.renderStreamingMarkdownUnits('First.', {}, {
    renderChunk,
    streamUnits: require('../renderer/shared/markdown-stream-units'),
    mermaidText: {},
    mathUtils: {},
    createTemplateElement: () => ({ innerHTML: '', content: { childNodes: [] } }),
  });
  const next = streamRenderer.renderStreamingMarkdownUnits('First.\n\nSecond.', {
    previousUnits: initial.units,
    previousStreamState: initial.streamState,
  }, {
    renderChunk,
    streamUnits: require('../renderer/shared/markdown-stream-units'),
    mermaidText: {},
    mathUtils: {},
    createTemplateElement: () => ({ innerHTML: '', content: { childNodes: [] } }),
  });

  assert.equal(next.renderMode, 'full');
  assert.equal(next.fallbackReason, 'guard_unavailable');
});

test('render dependency failures degrade without escaping the renderer seam', () => {
  const result = streamRenderer.renderStreamingMarkdownUnits('First.', {}, {
    renderChunk: () => { throw new Error('render failed'); },
    streamUnits: require('../renderer/shared/markdown-stream-units'),
    mermaidText,
    mathUtils,
  });

  assert.equal(result, null);
});

test('mid-list and mid-table growth does not freeze an unsafe boundary', () => {
  const listFirst = markdownUtils.renderStreamingMarkdownUnits('Intro.\n\n- outer\n  - nested');
  const listNext = markdownUtils.renderStreamingMarkdownUnits(
    'Intro.\n\n- outer\n  - nested grows',
    { previousUnits: listFirst.units }
  );
  const tableFirst = markdownUtils.renderStreamingMarkdownUnits('Intro.\n\n| A | B |\n| - | - |\n| 1 |');
  const tableNext = markdownUtils.renderStreamingMarkdownUnits(
    'Intro.\n\n| A | B |\n| - | - |\n| 1 | 2 |',
    { previousUnits: tableFirst.units }
  );

  assert.equal(listNext.streamState.stablePrefixEnd, 'Intro.\n\n'.length);
  assert.equal(tableNext.streamState.stablePrefixEnd, 'Intro.\n\n'.length);
  assert.equal(listNext.changedStartIndex, 1);
  assert.equal(tableNext.changedStartIndex, 1);
});

test('an open bulk fence after prose activates the bounded construct path', () => {
  const body = Array.from(
    { length: codeHighlight.MAX_BODY_LINES + 700 },
    (_, index) => `line ${index}\n`
  ).join('');
  const cases = [
    ['blank-line separated', 'First paragraph.\n\nSecond paragraph.\n\n'],
    ['glued', 'First paragraph.\n\nSecond paragraph.\n'],
  ];
  for (const [label, prose] of cases) {
    const source = `${prose}\`\`\`js\n${body}`;
    let previousUnits = [];
    let previousStreamState = null;
    let model;
    for (let end = 120; ; end += 120) {
      model = markdownUtils.renderStreamingMarkdownUnits(source.slice(0, Math.min(end, source.length)), {
        mermaid: 'plain', previousUnits, previousStreamState,
      });
      previousUnits = model.units;
      previousStreamState = model.streamState;
      if (end >= source.length) break;
    }

    const full = markdownUtils.renderStreamingMarkdownUnits(source, { mermaid: 'plain' });
    assert.ok(model.streamState.stablePrefixEnd >= prose.length, label);
    assert.equal(model.streamState.activeConstruct?.kind, 'fence', label);
    assert.equal(model.html, full.html, label);
  }
});

test('a fence cannot interrupt a streaming HTML block', () => {
  const body = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join('');
  const source = `<div></div>\n\`\`\`js\n${body}`;
  let previousUnits = [];
  let previousStreamState = null;
  let model;
  for (let end = 1; end <= source.length; end += 1) {
    model = markdownUtils.renderStreamingMarkdownUnits(source.slice(0, end), {
      mermaid: 'plain', previousUnits, previousStreamState,
    });
    previousUnits = model.units;
    previousStreamState = model.streamState;
  }

  const full = markdownUtils.renderStreamingMarkdownUnits(source, { mermaid: 'plain' });
  assert.equal(model.html, full.html);
});

test('an incomplete fence opener can grow into paragraph text', () => {
  const source = 'First.\n```js`x\nmore\n';
  let previousUnits = [];
  let previousStreamState = null;
  let model;
  for (let end = 1; end <= source.length; end += 1) {
    model = markdownUtils.renderStreamingMarkdownUnits(source.slice(0, end), {
      mermaid: 'plain', previousUnits, previousStreamState,
    });
    previousUnits = model.units;
    previousStreamState = model.streamState;
  }

  const full = markdownUtils.renderStreamingMarkdownUnits(source, { mermaid: 'plain' });
  assert.equal(model.html, full.html);
});

// A table nested in a list item must never become a construct: the construct
// freezes head+suffix, so </li></ul> would be baked into the frozen prefix and
// every later block of that item would render outside the list. Reachable at 44
// chars once the table activation floor was removed.
test('a nested table streams byte-identically to a from-scratch render', () => {
  const cases = {
    'bullet table then a paragraph': '- | a | b |\n  | - | - |\n  | 1 | 2 |\n\n  note\n',
    'ordered table then a paragraph': '1. | a | b |\n   | - | - |\n   | 1 | 2 |\n\n   note\n',
    'bullet table then a nested list': '- | a | b |\n  | - | - |\n  | 1 | 2 |\n\n  - deeper\n',
    'top-level table then a paragraph': '| a | b |\n| - | - |\n| 1 | 2 |\n\nnote\n',
  };
  for (const [label, source] of Object.entries(cases)) {
    let previousUnits = [];
    let previousStreamState = null;
    let model = null;
    for (let end = 1; end <= source.length; end += 1) {
      model = markdownUtils.renderStreamingMarkdownUnits(source.slice(0, end), {
        mermaid: 'plain', previousUnits, previousStreamState,
      });
      previousUnits = model.units;
      previousStreamState = model.streamState;
    }
    const full = markdownUtils.renderStreamingMarkdownUnits(source, { mermaid: 'plain' });
    assert.equal(model.html, full.html, label);
  }
});
