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

test('chat session rows do not restore per-row bottom dividers', () => {
  assert.doesNotMatch(ruleBody('.session-row'), /border-bottom\s*:/);
});

test('reserved dot is visible for every runtime state but yields to bulk selection', t => {
  const dom = new JSDOM('<!doctype html><head></head><body><div class="sidebar-bulk-actions" hidden></div></body>');
  t.after(() => dom.window.close());
  const style = dom.window.document.createElement('style');
  // jsdom does not parse container queries; keep the real stylesheet order.
  style.textContent = panelCss.slice(0, panelCss.indexOf('@container')) + selectionCss;
  dom.window.document.head.append(style);
  for (const state of ['idle', 'streaming', 'approval']) {
    dom.window.document.body.insertAdjacentHTML('beforeend', `<li class="session-row active sidebar-bulk-selected" data-session-dominant-state="${state}"><button class="session-row__open" role="checkbox" aria-checked="true"><span class="session-row__selection"></span><span class="session-row__dot"></span></button><button class="session-row__menu" hidden></button></li>`);
    const row = dom.window.document.body.lastElementChild;
    const computed = node => dom.window.getComputedStyle(node);
    assert.match(computed(row.querySelector('.session-row__dot')).display, /^(?:block|inline-block)$/, state);
    if (state === 'idle') {
      assert.equal(computed(row.querySelector('.session-row__dot')).backgroundColor, 'rgba(0, 0, 0, 0)');
    }
    row.classList.add('sidebar-bulk-selecting');
    assert.equal(computed(row.querySelector('.session-row__selection')).display, 'block', state);
    assert.equal(computed(row.querySelector('.session-row__menu')).display, 'none', state);
    assert.equal(computed(row.querySelector('.session-row__dot')).display, 'none', state);
    assert.equal(computed(row.querySelector('.session-row__selection')).animationName, 'none');
  }
  assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector('.sidebar-bulk-actions')).display, 'none');
});

test('bulk selection background wins over current-chat styling without changing status-dot styles', () => {
  const selector = '.session-row.sidebar-bulk-selected:is(:hover, :focus-within)';
  assert.match(ruleBody(selector), /background:\s*color-mix\(in srgb, var\(--accent\)/);
  assert.ok(css.indexOf(selector) > css.indexOf('.session-row.active:is(:hover, :focus-within)'));
  const shellCss = fs.readFileSync(path.join(__dirname, '..', 'styles', 'sidebar.css'), 'utf8');
  assert.doesNotMatch(shellCss, /sidebar-bulk|\[aria-checked/);
  assert.doesNotMatch(css, /\[aria-checked[^\n]+session-row__dot/);
  const imports = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(imports.indexOf('chats-panel-selection.css') > imports.indexOf('chats-panel.css'));
});

test('selection layout permits wrapping and confirmation overlays within the sidebar bounds', () => {
  assert.match(ruleBody('.sidebar-bulk-actions'), /flex-wrap:\s*wrap/);
  assert.match(ruleBody('.sidebar-bulk-control'), /min-height:\s*32px/);
  const dialog = ruleBody('.sidebar-bulk-actions .sidebar-bulk-confirm');
  assert.match(dialog, /inset-block-start:\s*100%/);
  assert.match(dialog, /inset-inline:\s*0/);
  assert.match(dialog, /min-width:\s*0/);
  assert.match(dialog, /overflow-y:\s*auto/);
  assert.match(dialog, /animation:\s*none/);
});

test('linked-chat tree styles use logical properties, keep the row height and leave chats-panel.css under the ratchet', () => {
  const treeCss = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chats-panel-tree.css'), 'utf8');
  assert.ok(panelCss.split('\n').length <= 600, 'chats-panel.css stays within the 600-line ratchet');
  assert.doesNotMatch(treeCss, /(?:^|[;{\s])(?:left|right|margin-left|margin-right|padding-left|padding-right|border-left|border-right)\s*:/m);
  assert.match(treeCss, /--cw-indent:\s*16px/);
  assert.match(treeCss, /padding-inline-start:\s*calc\(var\(--cw-depth, 0\) \* var\(--cw-indent\)\)/);
  assert.match(treeCss, /--cw-thread:\s*var\(--line-strong\)/);
  assert.match(treeCss, /text-box:\s*trim-both cap alphabetic/);
  assert.doesNotMatch(treeCss, /font-size:\s*[\d.]+(?:px|rem)/, 'type uses the role tokens');
  const withoutOrigin = treeCss.replace(/\.session-row\[data-tree-origin\] \.session-row__open \{[^}]*\}/, '');
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
  assert.equal(computed(grand).getPropertyValue('--cw-c2').trim(), '', 'the last child draws an elbow, not a level-2 line');
  assert.equal(computed(middle).getPropertyValue('--cw-c2').trim(), 'var(--cw-thread)');
});
