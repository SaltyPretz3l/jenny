const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// These are presentation contracts that only exist in the cascade: jsdom parses
// the DOM but never applies author stylesheets, so the only place to assert them
// is the CSS text itself. Same approach as chats-panel-toggle-hidden-css.test.js.

test('the session tab band collapses below two open tabs', () => {
  const css = readRepoFile('styles/workspace-rail.css');
  const rule = css.match(
    /\.workspace-rail-shell\[data-tab-count="0"\],\s*\.workspace-rail-shell\[data-tab-count="1"\]\s*\{([^}]*)\}/
  );

  assert.ok(rule, 'a data-tab-count collapse rule should exist in styles/workspace-rail.css');
  assert.match(rule[1], /display\s*:\s*none/, 'the band must be removed from layout, not just emptied');
});

// `.workspace-rail-shell:empty` cannot carry this on its own: renderRail()
// builds the scroll arrows, the rail, and the + button unconditionally on its
// first call, so the shell stops being :empty the moment the chat view paints.
test('the :empty rule is kept but is not the only collapse condition', () => {
  const css = readRepoFile('styles/workspace-rail.css');
  assert.match(css, /\.workspace-rail-shell:empty/, ':empty still covers the pre-first-render state');
  assert.match(css, /\[data-tab-count="0"\]/, 'the tab-count rule is what collapses the band after render');
});

// The + button is a sibling of .workspace-rail (it is not a tab, so it stays out
// of the role="tablist"). A stretching rail would therefore shove it to the far
// right of the window; shrink-wrapping the rail parks it after the last tab.
test('the rail shrink-wraps its tabs so the + button trails the last tab', () => {
  const css = readRepoFile('styles/workspace-rail.css');
  const rule = css.match(/^\.workspace-rail \{([^}]*)\}/m);

  assert.ok(rule, '.workspace-rail rule should exist');
  assert.doesNotMatch(rule[1], /flex\s*:\s*1\s*;/, '.workspace-rail must not stretch to fill the band');
  assert.match(rule[1], /flex\s*:\s*0 1 auto/, '.workspace-rail should shrink-wrap its tabs');
});

test('the shell owns the band paint and drag region once the rail shrink-wraps', () => {
  const css = readRepoFile('styles/workspace-rail.css');
  const rule = css.match(/^\.workspace-rail-shell \{([^}]*)\}/m);

  assert.ok(rule, '.workspace-rail-shell rule should exist');
  assert.match(rule[1], /background\s*:/, 'the shell must paint the band across its full width');
  assert.match(rule[1], /border-bottom\s*:/, 'the shell must carry the band divider');
  assert.match(rule[1], /-webkit-app-region\s*:\s*drag/, 'the leftover strip stays a window-drag area');
});

test('the chats overflow trigger rests hidden but stays focusable', () => {
  const css = readRepoFile('styles/chats-panel.css');
  const rule = css.match(/^\.chats-tool-button \{([^}]*)\}/m);

  assert.ok(rule, '.chats-tool-button rule should exist in styles/chats-panel.css');
  assert.match(rule[1], /opacity\s*:\s*0/, 'the trigger rests invisible');
  // display:none / visibility:hidden would drop it out of the tab order and the
  // accessibility tree; opacity keeps it reachable by keyboard.
  assert.doesNotMatch(rule[1], /display\s*:\s*none/, 'must not be removed from layout');
  assert.doesNotMatch(rule[1], /visibility\s*:\s*hidden/, 'must not be removed from the a11y tree');
});

test('the chats overflow trigger reveals on hover, focus, and while its menu is open', () => {
  const css = readRepoFile('styles/chats-panel.css');
  const rule = css.match(
    /\.view-panel:hover \.chats-tool-button,\s*\.chats-tool-button:focus-visible,\s*\.chats-tool-button\[data-menu-open\]\s*\{([^}]*)\}/
  );

  assert.ok(rule, 'a combined reveal rule should exist');
  assert.match(rule[1], /opacity\s*:\s*1/, 'all three states must paint the trigger');
});

// ---- Chat tab rail (shell-chrome area 2) ----

function cssRules(css) {
  const rules = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(stripped))) {
    rules.push({ selector: match[1].trim(), body: match[2] });
  }
  return rules;
}

test('a tab keeps a 134px minimum so about 14 characters of title survive (real-app gate C2)', () => {
  const css = readRepoFile('styles/workspace-rail.css');
  const rule = css.match(/^\.workspace-rail-tab \{([^}]*)\}/m);
  assert.ok(rule, '.workspace-rail-tab rule should exist');
  assert.match(rule[1], /min-width\s*:\s*134px/);
  assert.match(rule[1], /max-width\s*:\s*220px/);
});

test('the rail state dot shares the sidebar state tokens', () => {
  const css = readRepoFile('styles/workspace-rail.css');
  assert.match(css, /\.workspace-rail-state-dot\s*\{/);
  assert.match(css, /\[data-session-dominant-state="streaming"\][^{]*\.workspace-rail-state-dot\s*\{[^}]*var\(--sidebar-state-streaming-color\)/);
  assert.match(css, /\[data-session-dominant-state="approval"\][^{]*\.workspace-rail-state-dot\s*\{[^}]*var\(--sidebar-state-approval-color\)/);
  assert.doesNotMatch(css, /\.workspace-rail-indicator/, 'the state word is retired from the tab');
});

test('the rail fades the clipped edge when tabs overflow', () => {
  const css = readRepoFile('styles/workspace-rail.css');
  const rules = cssRules(css);
  const start = rules.find((entry) => /^\.workspace-rail\[data-overflow-start\]$/.test(entry.selector));
  const end = rules.find((entry) => /^\.workspace-rail\[data-overflow-end\]$/.test(entry.selector));
  const both = rules.find((entry) => /^\.workspace-rail\[data-overflow-start\]\[data-overflow-end\]$/.test(entry.selector));
  for (const rule of [start, end, both]) {
    assert.ok(rule, 'each overflow edge combination needs a mask rule');
    assert.match(rule.body, /mask-image\s*:\s*linear-gradient/);
  }
});

test('the rail glyph buttons use a role type token', () => {
  const css = readRepoFile('styles/workspace-rail.css');
  assert.doesNotMatch(css, /--font-size-sm\b/);
});

test('the retired per-tab link button leaves no styles behind', () => {
  const css = readRepoFile('styles/workspace-rail.css');
  assert.doesNotMatch(css, /workspace-rail-link-button/);
});

test('a chat open as a tab shows a ring in the sidebar dot slot', () => {
  const css = readRepoFile('styles/chats-panel.css');
  const rule = cssRules(css).find((entry) => /\[data-session-dominant-state="open"\]/.test(entry.selector) && /\.session-row__dot/.test(entry.selector) && /box-shadow/.test(entry.body));
  assert.ok(rule, 'a ring rule keyed on the open dominant state should exist');
  assert.doesNotMatch(css, /data-session-tab-open/, 'the open mark is the dominant state, not a second attribute');
  assert.match(rule.body, /box-shadow\s*:\s*inset 0 0 0 1px var\(--text-decorative\)/);
  assert.doesNotMatch(rule.selector, /streaming|approval/, 'the ring marks idle rows; state dots keep their fill');
});
