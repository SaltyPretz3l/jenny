'use strict';

// Without a global document (Node tests, headless hosts) the Markdown modules
// fall back to jsdom. That fallback must build one document and reuse it:
// building a jsdom per render cost ~15 ms each, and in jsdom the first
// selector query on a document adds window listeners that are never removed,
// so querying each freshly sanitized document grew the heap and made every
// later update slower (the streaming-markdown-cost ratchet measured that
// instead of document-size growth).

const test = require('node:test');
const assert = require('node:assert/strict');
const jsdom = require('jsdom');

const OriginalJSDOM = jsdom.JSDOM;
let constructed = 0;
let windowListeners = 0;
jsdom.JSDOM = class CountingJSDOM extends OriginalJSDOM {
  constructor(...args) {
    super(...args);
    constructed += 1;
    const { window } = this;
    const addEventListener = window.addEventListener.bind(window);
    window.addEventListener = (...listenerArgs) => {
      windowListeners += 1;
      return addEventListener(...listenerArgs);
    };
  }
};

const markdownUtils = require('../renderer/shared/markdown-utils');
const mathUtils = require('../renderer/shared/markdown-math-utils');

test.after(() => {
  jsdom.JSDOM = OriginalJSDOM;
  mathUtils.setMathRenderingEnabled(false);
});

test('Markdown rendering without a global document reuses one jsdom document', () => {
  assert.equal(typeof document, 'undefined', 'this file must exercise the no-document fallback');
  mathUtils.setMathRenderingEnabled(true);
  const source = [
    '## Heading',
    '',
    'Prose with **bold**, `inline code`, [a link](https://example.com) and $x^2$.',
    '',
    '- item one',
    '- item two',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
  ].join('\n').repeat(4);

  const renderAll = (end) => {
    const text = source.slice(0, end);
    markdownUtils.renderMarkdown(text, { cachePolicy: 'bypass' });
    const { text: protectedText, map } = mathUtils.protectMath('<p>square $x^2$</p>');
    assert.ok(mathUtils.restoreMathPlaceholders(protectedText, map).includes('x^2'));
    return markdownUtils.renderStreamingMarkdownUnits(text, { mermaid: 'plain' });
  };

  const model = renderAll(Math.floor(source.length / 10));
  const afterFirstRender = { constructed, windowListeners };
  assert.ok(afterFirstRender.constructed > 0, 'the fallback path built its jsdom document');
  assert.ok(model.html.includes('<h2'), 'the render produced HTML');

  for (let step = 2; step <= 10; step += 1) {
    assert.ok(renderAll(Math.floor(source.length * step / 10)).html.includes('<h2'));
  }
  assert.deepEqual(
    { constructed, windowListeners },
    afterFirstRender,
    'later renders built no further jsdom windows and added no window listeners',
  );
});
