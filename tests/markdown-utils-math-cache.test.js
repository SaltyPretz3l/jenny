const test = require('node:test');
const assert = require('node:assert/strict');

const mathUtils = require('../renderer/shared/markdown-math-utils');
const markdownUtils = require('../renderer/shared/markdown-utils');

test('repeated math renders restore their own placeholders instead of reusing nonce-bearing cache HTML', (t) => {
  t.after(() => {
    mathUtils.setMathRenderingEnabled(false);
    markdownUtils.clearMarkdownRenderCache();
  });
  markdownUtils.clearMarkdownRenderCache();
  mathUtils.setMathRenderingEnabled(true);
  const source = 'repeat $x^2$';

  const first = markdownUtils.renderMarkdown(source);
  const second = markdownUtils.renderMarkdown(source);

  for (const [label, rendered] of [['first', first], ['second', second]]) {
    assert.match(rendered, /markdown-math/, `${label} render contains the math wrapper`);
    assert.doesNotMatch(rendered, /MJNYMATH\d+K/, `${label} render contains no placeholder token`);
  }
});
