const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'inventory', 'inventory-artifact-figure.css'), 'utf8');

function containerBlock() {
  const start = css.indexOf('@container invfigure');
  assert.notEqual(start, -1, 'the narrow-figure container query exists');
  let depth = 0;
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}' && --depth === 0) return css.slice(start, index + 1);
  }
  throw new Error('unterminated @container block');
}

// Gate 2026-10-14 F13: a 112 px chart thumbnail was covered by its hover
// cluster, so a click in the middle hit Copy instead of opening the viewer.
test('a narrow figure moves its tools out from over the image', () => {
  assert.match(css, /\.inv-artifact-figure:not\(\.inv-artifact-figure--attachment\):not\(\.inv-artifact-figure--pending\)\s*\{\s*container: invfigure \/ inline-size;/);
  const block = containerBlock();
  assert.match(block, /@container invfigure \(max-width: 239px\)/);
  const actions = block.match(/\.inv-artifact-figure-actions\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(actions, /position: static;/);
  assert.match(actions, /opacity: 1;/);
  assert.match(actions, /pointer-events: auto;/);
  // Off the dark overlay the light icon colour would vanish on a light theme.
  assert.match(block, /\.inv-artifact-figure-tool\s*\{\s*color: var\(--text-muted\);/);
});

test('the narrow-figure overrides come after the base tool rules they override', () => {
  assert.ok(css.indexOf('@container invfigure') > css.indexOf('.inv-artifact-figure-tool:focus-visible {'));
});

test('attachments size to their content, so they never become an inline-size container', () => {
  const attachment = css.match(/\.inv-artifact-figure--attachment\s*\{([^}]*)\}/)?.[1] || '';
  assert.doesNotMatch(attachment, /container/);
});
