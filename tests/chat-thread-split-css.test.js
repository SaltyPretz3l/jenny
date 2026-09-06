const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readImports() {
  return readRepoFile('styles.css')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('@import'))
    .map((line) => line.match(/url\("([^"]+)"\)/)?.[1])
    .filter(Boolean);
}

function selectorAtRuleStart(selector) {
  return new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
}

function assertMovedRuleStart({ focusedCss, parentCss, selector }) {
  const pattern = selectorAtRuleStart(selector);
  assert.match(focusedCss, pattern, `${selector} should live in the focused stylesheet`);
  assert.doesNotMatch(parentCss, pattern, `${selector} should not remain in chat-thread.css`);
}

test('chat thread split CSS loads immediately after the base thread stylesheet', () => {
  const imports = readImports();
  const threadIndex = imports.indexOf('./styles/chat-thread.css');

  assert.notEqual(threadIndex, -1);
  assert.equal(imports[threadIndex + 1], './styles/chat-thread-rail.css');
  assert.equal(imports[threadIndex + 2], './styles/chat-thread-presets.css');
  assert.equal(imports[threadIndex + 3], './styles/chat-a11y-v2.css');
});

test('chat thread rail selectors live in their focused stylesheet', () => {
  const railCss = readRepoFile('styles/chat-thread-rail.css');
  const threadCss = readRepoFile('styles/chat-thread.css');

  for (const selector of [
    '.chat-thread-toggle,',
    '.chat-row-node-dot {',
    '.chat-thread-children {',
  ]) {
    assertMovedRuleStart({ focusedCss: railCss, parentCss: threadCss, selector });
  }
});

test('chat thread preset selectors live in their focused stylesheet', () => {
  const presetsCss = readRepoFile('styles/chat-thread-presets.css');
  const threadCss = readRepoFile('styles/chat-thread.css');

  for (const selector of [
    '.chat-view.thread-transition-ready.chat-active .hero-stack',
  ]) {
    assertMovedRuleStart({ focusedCss: presetsCss, parentCss: threadCss, selector });
  }
});

test('the retired explorer-minimal preset leaves no selectors behind', () => {
  // Retired 2026-07-05 (quiet-timeline overhaul). A resurrected selector means
  // dead CSS is accreting again — remove it, do not re-add the preset.
  for (const relativePath of ['styles/chat-thread-presets.css', 'styles/chat-thread.css']) {
    assert.doesNotMatch(
      readRepoFile(relativePath),
      /\.timeline-explorer-details\s*[,{[]/,
      `${relativePath} should not style the retired explorer-minimal preset`
    );
  }
});
