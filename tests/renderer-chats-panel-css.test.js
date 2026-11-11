'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const panelCss = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chats-panel.css'), 'utf8');
const selectionCss = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chats-panel-selection.css'), 'utf8');
const css = panelCss + '\n' + selectionCss;

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${selector} rule should exist`);
  return match[1];
}

test('chat group labels do not paint a sticky panel gradient', () => {
  const body = ruleBody('.group-label');
  assert.doesNotMatch(body, /position\s*:\s*sticky\b/);
  assert.doesNotMatch(body, /var\(--view-panel-bg\)/);
});

test('the primary Jenny row paints an accent spark and a firmer title', () => {
  assert.match(ruleBody('.session-row__primary-mark'), /color\s*:\s*var\(--accent\)/);
  assert.match(ruleBody('.session-row__primary-mark svg'), /fill\s*:\s*currentColor/);
  assert.match(ruleBody('.session-row--primary .session-row__title-text'), /font-weight\s*:\s*600/);
  assert.match(ruleBody('.session-row .session-row__title'), /font-weight\s*:\s*400/, 'ordinary titles are regular; unread titles are 600 in chat-messages.css');
});

test('chat session rows do not restore per-row bottom dividers', () => {
  assert.doesNotMatch(ruleBody('.session-row'), /border-bottom\s*:/);
});

test('the dot column is rendered for every runtime state, selected or not', t => {
  const dom = new JSDOM('<!doctype html><head></head><body></body>');
  t.after(() => dom.window.close());
  const style = dom.window.document.createElement('style');
  // jsdom does not parse container queries; keep the real stylesheet order.
  style.textContent = panelCss.slice(0, panelCss.indexOf('@container')) + selectionCss;
  dom.window.document.head.append(style);
  for (const state of ['idle', 'streaming', 'approval']) {
    for (const cls of ['active sidebar-bulk-selected', 'sidebar-bulk-selected']) {
      dom.window.document.body.insertAdjacentHTML('beforeend', `<li class="session-row ${cls}" data-session-dominant-state="${state}"><button class="session-row__open"><span class="session-row__dot"></span></button><button class="session-row__menu" hidden></button></li>`);
      const row = dom.window.document.body.lastElementChild;
      const dot = dom.window.getComputedStyle(row.querySelector('.session-row__dot'));
      assert.match(dot.display, /^(?:block|inline-block)$/, `${state} ${cls}`);
      if (state === 'idle') assert.equal(dot.backgroundColor, 'rgba(0, 0, 0, 0)');
    }
  }
});

test('selected rows are highlighted, and an open selected row reads stronger than either alone', () => {
  const selectedHover = '.session-row.sidebar-bulk-selected:is(:hover, :focus-within)';
  const bothHover = '.session-row.active.sidebar-bulk-selected:is(:hover, :focus-within)';
  assert.match(ruleBody(selectedHover), /background:\s*color-mix\(in srgb, var\(--accent\) 14%, transparent\)/);
  assert.match(ruleBody(bothHover), /background:\s*color-mix\(in srgb, var\(--accent\) 22%, transparent\)/);
  assert.match(css, /\.session-row\.sidebar-bulk-selected,\s*\.session-row\.sidebar-bulk-selected:is\(/, 'the resting selected row shares the hover rule');
  assert.match(css, /\.session-row\.active\.sidebar-bulk-selected,\s*\.session-row\.active\.sidebar-bulk-selected:is\(/, 'the resting open selected row shares the hover rule');
  // Three classes beat .session-row.active (two) whatever the import order; the hover form beats its :is() twin.
  assert.ok(css.indexOf(bothHover) > css.indexOf('.session-row.active:is(:hover, :focus-within)'));
  assert.ok(css.indexOf(bothHover) > css.indexOf(selectedHover), 'the stronger mix wins over the plain selected mix');
  const imports = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(imports.indexOf('chats-panel-selection.css') > imports.indexOf('chats-panel.css'));
});

test('forced colours: a selected row is outlined because backgrounds are dropped', () => {
  const forced = selectionCss.match(/@media \(forced-colors: active\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(forced, 'selection css has a forced-colors block');
  const rule = forced[1].match(/\.session-row\.sidebar-bulk-selected\s*\{([^}]*)\}/);
  assert.ok(rule, 'the selected row has a forced-colors rule');
  assert.match(rule[1], /outline:\s*1px solid Highlight/);
  assert.match(rule[1], /outline-offset:\s*-1px/);
});

test('selection has no mode: its toolbar, entry, confirm and checkbox styles are gone', () => {
  const stylesDir = path.join(__dirname, '..', 'styles');
  const files = fs.readdirSync(stylesDir).filter(name => name.endsWith('.css'));
  assert.ok(files.includes('chats-panel-selection.css'));
  const banned = [
    /sidebar-bulk-selecting/,
    /#chatsSelectionEntry/,
    /\.sidebar-bulk-actions/,
    /\.sidebar-bulk-summary/,
    /\.sidebar-bulk-buttons/,
    /\.sidebar-bulk-control/,
    /\.sidebar-bulk-confirm/,
    /\.session-row__selection/,
  ];
  for (const name of files) {
    const text = fs.readFileSync(path.join(stylesDir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const pattern of banned) assert.doesNotMatch(text, pattern, `${name} has no ${pattern}`);
  }
  const shellCss = fs.readFileSync(path.join(stylesDir, 'sidebar.css'), 'utf8');
  assert.doesNotMatch(shellCss, /sidebar-bulk|\[aria-checked/);
  assert.doesNotMatch(css, /\[aria-checked/, 'rows are no longer checkboxes');
});

test('linked-chat tree styles use logical properties, keep the row height and leave chats-panel.css under the ratchet', () => {
  const treeCss = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chats-panel-tree.css'), 'utf8');
  assert.ok(panelCss.split('\n').length <= 600, 'chats-panel.css stays within the 600-line ratchet');
  assert.doesNotMatch(treeCss, /(?:^|[;{\s])(?:left|right|margin-left|margin-right|padding-left|padding-right|border-left|border-right)\s*:/m);
  assert.match(treeCss, /--cw-indent:\s*24px/);
  assert.match(treeCss, /padding-inline-start:\s*calc\(var\(--cw-base, 0px\) \+ var\(--cw-depth, 0\) \* var\(--cw-indent\)\)/);
  assert.match(treeCss, /--cw-thread-x:\s*calc\(var\(--cw-base, 0px\) \+ var\(--space-4\) \+ 4px\)/, 'a section indent moves the guide line with the rows');
  assert.match(treeCss, /--cw-thread:\s*color-mix\(in srgb, var\(--text-muted\) 55%, transparent\)/);
  assert.match(treeCss, /text-box:\s*trim-both cap alphabetic/);
  assert.doesNotMatch(treeCss, /font-size:\s*[\d.]+(?:px|rem)/, 'type uses the role tokens');
  const withoutOrigin = treeCss
    .replace(/\.session-row\[data-tree-origin\] \.session-row__open \{[^}]*\}/, '')
    .replace(/\.session-row\[data-tree-last="true"\]:not\(\[data-tree-depth="0"\]\)::after \{[^}]*\}/, '');
  assert.doesNotMatch(withoutOrigin, /(?:^|[\s;{])(?:block-size|height)\s*:\s*[^;]*session-row-height/m, 'only origin rows may grow past the row height');
  const imports = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  if (imports.includes('chats-panel-tree.css')) {
    assert.ok(imports.indexOf('chats-panel-tree.css') > imports.indexOf('chats-panel.css'));
    assert.ok(imports.indexOf('chats-panel-tree.css') < imports.indexOf('chats-panel-selection.css'), 'bulk selection still wins the grid');
  }
});

test('tree rows: thread levels resolve through the attribute selectors', t => {
  const treeCss = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chats-panel-tree.css'), 'utf8');
  const dom = new JSDOM('<!doctype html><head></head><body></body>');
  t.after(() => dom.window.close());
  const style = dom.window.document.createElement('style');
  style.textContent = treeCss.slice(treeCss.indexOf('.session-row {'), treeCss.indexOf('.session-row[data-tree-depth]:not'))
    + treeCss.slice(treeCss.indexOf('.session-row[data-tree-through~="1"]'), treeCss.indexOf('/* The last child'));
  dom.window.document.head.append(style);
  dom.window.document.body.innerHTML = '<ul><li class="session-row" data-tree-depth="2" data-tree-last="true" data-tree-through="1"></li>'
    + '<li class="session-row" data-tree-depth="1" data-tree-last="false" data-tree-through="1 2"></li></ul>';
  const [grand, middle] = dom.window.document.querySelectorAll('.session-row');
  const computed = node => dom.window.getComputedStyle(node);
  assert.equal(computed(grand).getPropertyValue('--cw-c1').trim(), 'var(--cw-thread)', 'the grandparent level-1 line runs through the grandchild');
  assert.equal(computed(grand).getPropertyValue('--cw-c2').trim(), '', 'the last child draws its own segment, not a level-2 line');
  assert.equal(computed(middle).getPropertyValue('--cw-c2').trim(), 'var(--cw-thread)');
});
