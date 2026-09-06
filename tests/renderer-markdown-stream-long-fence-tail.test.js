'use strict';

// WO-18 admits >8 KiB fences to the incremental tail path, which closes the
// open fence with a synthetic closer before re-parsing the tail. A tail that
// stops mid-line must not carry that closer into the rendered code: every
// intermediate frame has to match a from-scratch render byte for byte.
const test = require('node:test');
const assert = require('node:assert/strict');

const markdownUtils = require('../renderer/shared/markdown-utils');

test('a long open fence renders identically to a full render at every mid-line frame', () => {
  let body = '```text\n';
  for (let line = 0; line < 30; line += 1) body += `${'x'.repeat(299)}\n`;
  const frames = [
    body,
    `${body}partial`,
    `${body}partial line\n`,
    `${body}partial line\nnext`,
    `${body}partial line\nnext\n\`\`\``, // the source's own closer, newline not yet streamed
    `${body}partial line\nnext\n\`\`\`\n`,
  ];
  let previousUnits = [];
  let incrementalFrames = 0;
  frames.forEach((frame, index) => {
    const incremental = markdownUtils.renderStreamingMarkdownUnits(frame, { mermaid: 'plain', previousUnits });
    markdownUtils.clearMarkdownRenderCache();
    const full = markdownUtils.renderStreamingMarkdownUnits(frame, { mermaid: 'plain' });
    assert.equal(incremental.html, full.html, `frame ${index} diverged from a from-scratch render`);
    assert.doesNotMatch(incremental.html, /partial```/, `frame ${index} leaked the synthetic closer into the code`);
    if (incremental.renderMode === 'incremental') incrementalFrames += 1;
    previousUnits = incremental.units;
  });
  assert.ok(incrementalFrames >= 4, `expected the long-fence incremental path to engage, saw ${incrementalFrames} frames`);
});
