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

test('selection glyph is visible for every runtime state while menus and inactive toolbar stay hidden', t => {
  const dom = new JSDOM('<!doctype html><head></head><body><div class="sidebar-bulk-actions" hidden></div></body>');
  t.after(() => dom.window.close());
  const style = dom.window.document.createElement('style');
  // jsdom does not parse container queries; keep the real stylesheet order.
  style.textContent = panelCss.slice(0, panelCss.indexOf('@container')) + selectionCss;
  dom.window.document.head.append(style);
  for (const state of ['idle', 'streaming', 'approval']) {
    dom.window.document.body.insertAdjacentHTML('beforeend', `<li class="session-row active sidebar-bulk-selecting sidebar-bulk-selected" data-session-dominant-state="${state}"><button class="session-row__open" role="checkbox" aria-checked="true"><span class="session-row__selection"></span><span class="session-row__dot"></span></button><button class="session-row__menu" hidden></button></li>`);
    const row = dom.window.document.body.lastElementChild;
    const computed = node => dom.window.getComputedStyle(node);
    assert.equal(computed(row.querySelector('.session-row__selection')).display, 'block', state);
    assert.equal(computed(row.querySelector('.session-row__menu')).display, 'none', state);
    assert.equal(computed(row.querySelector('.session-row__dot')).display, state === 'idle' ? 'none' : 'block');
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
