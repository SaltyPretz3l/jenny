'use strict';
// new-test-file: tests/markdown-utils.test.js sits at the 1015-line file-size ceiling, so the plain thinking-code cases live here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown, clearMarkdownRenderCache } = require('../renderer/shared/markdown-utils');

const PLAIN = { mermaid: 'plain', codeBlocks: 'plain' };

// Thinking text: a fence is one plain block with Copy, never the answer's toolbar, colouring or clamp.
test('renderMarkdown codeBlocks:plain emits exactly one plain block with a Copy button', () => {
  clearMarkdownRenderCache();
  assert.equal(
    renderMarkdown('```js\nconst a = 1 < 2;\n```', PLAIN),
    '<div class="thinking-code-host"><pre class="thinking-code"><code>const a = 1 &lt; 2;\n</code></pre>'
      + '<button type="button" class="inv-codeblock-copy thinking-code-copy" aria-label="Copy code">Copy</button></div>\n',
  );
});

test('codeBlocks:plain has no clamp, ids, colouring or language label past 25 lines, and a mermaid fence stays plain code', () => {
  clearMarkdownRenderCache();
  for (const fence of ['js', 'mermaid']) {
    const long = renderMarkdown(`\`\`\`${fence}\n${'flowchart TD\n'.repeat(40)}\`\`\``, PLAIN);
    assert.ok(long.startsWith('<div class="thinking-code-host"><pre class="thinking-code"><code>flowchart TD\n'), long);
    assert.doesNotMatch(long, /collaps|expand-overlay|\bid=|aria-controls|markdown-code-block|markdown-mermaid|tok-|language-|Wrap/);
    assert.equal((long.match(/<button\b/g) || []).length, 1);
  }
});

test('the default render stays byte-identical, before and after a plain render of the same source', () => {
  clearMarkdownRenderCache();
  const source = '```js\nconst a = 1 < 2;\n```';
  const expected = '<div class="markdown-code-block inv-codeblock-wrap"><div class="markdown-code-header inv-codeblock-toolbar">'
    + '<span class="markdown-code-language inv-codeblock-language" style="--lang-dot: #EF9F27;" data-language-id="javascript">JavaScript</span>'
    + '<button type="button" class="inv-codeblock-wrap-toggle" aria-label="Wrap long lines" aria-pressed="false">Wrap</button>'
    + '<button type="button" class="inv-codeblock-copy" aria-label="Copy code">Copy</button></div>'
    + '<pre><code class="language-js" data-code-highlighted="default" data-language-id="javascript">'
    + '<span class="tok tok-default">const a = 1 &lt; 2;</span>\n<span class="tok tok-default"></span></code></pre></div>\n';
  assert.equal(renderMarkdown(source), expected);
  renderMarkdown(source, PLAIN);
  assert.equal(renderMarkdown(source), expected);
  const long = renderMarkdown(`\`\`\`js\n${'line\n'.repeat(30)}\`\`\``);
  assert.match(long, /class="markdown-code-block inv-codeblock-wrap collapsible collapsed"/);
  assert.match(long, /markdown-code-expand-overlay/);
});
