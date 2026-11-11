/* The session bar's stylesheet (row 115): layout, fixed order and logical properties. Split from
   renderer-session-bar.test.js, which covers the module's behavior. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const css = read('styles/chat-session-bar.css');
const block = (selector) => {
  const start = css.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `rule ${selector}`);
  return css.slice(start, css.indexOf('}', start));
};

test('the bar stylesheet is imported right after the rail stylesheet', () => {
  const imports = read('styles.css').split(/\r?\n/).filter((line) => line.startsWith('@import'));
  const rail = imports.findIndex((line) => line.includes('chat-session-rail.css'));
  assert.ok(rail >= 0 && imports[rail + 1].includes('chat-session-bar.css'));
});

test('one pane: a 40px row spanning every column, buttons clickable, stage and panels offset by the bar', () => {
  assert.match(block('.chat-view'), /--session-bar-h:\s*40px;/);
  const bar = block('.chat-view > .chat-pane:not(.ide-chat-dock-body) > .chat-timeline-utility-cluster');
  for (const declaration of [/grid-column:\s*1 \/ -1;/, /grid-row:\s*1;/, /justify-self:\s*stretch;/, /display:\s*flex;/, /flex-direction:\s*row;/, /block-size:\s*var\(--session-bar-h\);/, /margin:\s*0;/, /pointer-events:\s*none;/]) {
    assert.match(bar, declaration);
  }
  assert.match(bar, /padding-inline:\s*var\(--space-8\) var\(--space-6\);/);
  assert.match(css, /> \*\s*\{\s*order:\s*80;\s*pointer-events:\s*auto;/, 'buttons keep pointer-events auto');
  const offset = css.match(/(\.chat-view:not\(\[data-pane-count="2"\]\) > :is\([^)]*\)[^{]*)\{\s*margin-block-start:\s*var\(--session-bar-h\);/);
  assert.ok(offset, 'the offset rule exists');
  for (const name of ['.hero-stage', '.chat-thread-stage', '.chat-context-panel', '.artifact-review-resizer', '.artifact-review-panel:not(.artifact-review-overlay)']) {
    assert.ok(offset[1].includes(name), `${name} starts below the bar`);
  }
});

test('fixed visual order by CSS order, independent of mount order', () => {
  const orderOf = (selectorEnd) => {
    const match = css.match(new RegExp(`> ${selectorEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*?order:\\s*(\\d+);`));
    assert.ok(match, selectorEnd);
    return Number(match[1]);
  };
  assert.equal(orderOf('.session-bar-title'), 0);
  assert.equal(orderOf('[data-chat-node="artifactSplitViewToggle"]'), 20);
  assert.equal(orderOf('#chatTimelineTasksToggle'), 30);
  assert.equal(orderOf('#chatTimelineNotesToggle'), 40);
  assert.equal(orderOf('.session-rail-toggle'), 60);
  assert.match(block('.chat-view > .chat-pane:not(.ide-chat-dock-body) > .chat-timeline-utility-cluster > .session-rail-toggle'), /margin-inline-start:\s*var\(--space-4\);/);
  assert.match(block('.chat-view > .chat-pane:not(.ide-chat-dock-body) > .chat-timeline-utility-cluster > .session-bar-title'), /flex:\s*1 1 auto;[\s\S]*min-inline-size:\s*0;[\s\S]*font-size:\s*var\(--font-size-footnote\);[\s\S]*color:\s*var\(--text-secondary\);[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/);
});

test('the diff control: order 10, inline-flex text with the space-3 gap, a truncating branch, tabular counts', () => {
  const orderOf = css.match(/> \.session-bar-diff\s*\{[^}]*?order:\s*(\d+);/);
  assert.ok(orderOf && Number(orderOf[1]) === 10, 'order 10');
  const text = block('.session-bar-diff .session-bar-diff-text');
  for (const declaration of [/display:\s*inline-flex;/, /gap:\s*var\(--space-3\);/, /font-weight:\s*400;/]) assert.match(text, declaration);
  const branch = block('.session-bar-diff-branch');
  for (const declaration of [/max-inline-size:\s*190px;/, /overflow:\s*hidden;/, /text-overflow:\s*ellipsis;/, /white-space:\s*nowrap;/, /color:\s*var\(--text-secondary\);/]) assert.match(branch, declaration);
  assert.match(block('.session-bar-diff-counts'), /font-variant-numeric:\s*tabular-nums;/);
  const narrow = css.match(/(\.chat-view\[data-pane-count="2"\] \.session-bar-diff-branch,\s*\.chat-timeline-utility-cluster\[data-session-bar-compact\] \.session-bar-diff-branch)\s*\{\s*max-inline-size:\s*88px;/);
  assert.ok(narrow, 'split view and the compact bar shrink the name to 88px');
  const diffCss = css.slice(css.indexOf('Diff control:'));
  assert.doesNotMatch(diffCss, /(?:^|[\s;{])(?:border|background)(?:-[a-z-]+)?\s*:/m, 'no border or fill at rest');
});

test('the title hides in an empty chat and in a split; the IDE dock and a hosted pane keep the floating column', () => {
  assert.match(css, /\.chat-view\.chat-empty > \.chat-pane\[data-pane-id="0"\] > \.chat-timeline-utility-cluster > \.session-bar-title,\s*\.chat-view > \.chat-pane\.chat-empty > \.chat-timeline-utility-cluster > \.session-bar-title\s*\{\s*display:\s*none;/);
  assert.match(block('.chat-view[data-pane-count="2"] > .chat-pane > .chat-timeline-utility-cluster > .session-bar-title'), /display:\s*none;/);
  assert.match(block('.session-bar-title'), /display:\s*none;/, 'outside the bar (dock, hosted pane) there is no title');
  const floating = block('.chat-timeline-utility-cluster');
  assert.match(floating, /flex-direction:\s*column;/);
  assert.match(floating, /justify-self:\s*end;/);
  assert.match(floating, /margin-block:\s*var\(--space-4\) 0;/);
  assert.match(floating, /margin-inline-end:\s*var\(--space-4\);/);
});

test('split: the kicker row is the bar, with the close glyph pinned to the pane end', () => {
  const kicker = block('.chat-view[data-pane-count="2"] > .chat-pane > .chat-pane-kicker');
  assert.match(kicker, /padding-inline-end:\s*var\(--split-bar-reserve,\s*200px\);/);
  assert.match(kicker, /min-block-size:\s*var\(--session-bar-h\);/);
  const close = block('.chat-view[data-pane-count="2"] > .chat-pane > .chat-pane-kicker > .chat-pane-close');
  assert.match(close, /position:\s*absolute;/);
  assert.match(close, /inset-inline-end:\s*var\(--space-4\);/);
  const cluster = block('.chat-view[data-pane-count="2"] > .chat-pane > .chat-timeline-utility-cluster');
  for (const declaration of [/grid-column:\s*1;/, /grid-row:\s*1;/, /justify-self:\s*end;/, /align-self:\s*center;/, /block-size:\s*auto;/, /padding-inline:\s*0;/, /margin-inline-end:\s*var\(--split-bar-close-room\);/]) {
    assert.match(cluster, declaration);
  }
});

test('the bar styles use logical properties, existing tokens and no side-border accents', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(stripped, /(?:^|[\s;{])(?:margin|padding|border)-(?:left|right|top|bottom)\s*:|(?:^|[\s;{])(?:left|right|top|bottom|width|height|max-width|min-width|max-height|min-height)\s*:/m);
  assert.doesNotMatch(stripped, /border-inline-(?:start|end)\s*:|border-left|border-right/);
  const tokens = read('styles/foundation.css');
  for (const token of new Set([...stripped.matchAll(/var\((--(?:space|font-size|text)-[\w-]+)/g)].map((m) => m[1]))) {
    assert.ok(tokens.includes(`${token}:`), `${token} is defined in foundation.css`);
  }
});

test('the bar module stays under the 600-line ceiling and the old reserve is gone', () => {
  assert.ok(read('renderer/chat/renderer-session-bar.js').split('\n').length <= 600);
  for (const file of ['styles/chat-panes.css', 'styles/chat-session-rail.css', 'renderer/chat/renderer-chat-pane-surface-controllers.js']) {
    assert.doesNotMatch(read(file), /chat-utility-(?:reserve|room)|observeUtilityReserve/, file);
  }
  assert.doesNotMatch(read('styles/chat-session-rail.css'), /flex-direction:\s*row/, 'the rail no longer flips the cluster');
  assert.doesNotMatch(read('styles/context-panel.css'), /chat-timeline-utility-cluster/, 'the overlay no longer flips the cluster');
});
