const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// The sidebar panel toggles are hidden via the `hidden` attribute (syncPanelToggle()
// and the strip's own sync). But each carries an author-origin `display` that
// overrides the UA `[hidden] { display: none }` rule, so the attribute alone would
// leave the button on screen. These guard the explicit `[hidden]` overrides that
// restore the hide. (jsdom reflects the DOM property but never runs the author
// cascade, so this class of bug is only catchable at the CSS-text level.)
test('the header collapse toggle honours the hidden attribute', () => {
  const css = readRepoFile('styles/chats-panel.css');
  const rule = css.match(/\.chats-panel-collapse-toggle\[hidden\]\s*\{([^}]*)\}/);

  assert.ok(rule, '.chats-panel-collapse-toggle[hidden] rule should exist in styles/chats-panel.css');
  assert.match(rule[1], /display\s*:\s*none/, 'the rule should set display: none');
});

test('the strip expand toggle honours the hidden attribute', () => {
  const css = readRepoFile('styles/chats-panel-collapsed.css');
  const rule = css.match(/\.chats-strip__panel-toggle\[hidden\]\s*\{([^}]*)\}/);

  assert.ok(rule, '.chats-strip__panel-toggle[hidden] rule should exist in styles/chats-panel-collapsed.css');
  assert.match(rule[1], /display\s*:\s*none/, 'the rule should set display: none');
});
