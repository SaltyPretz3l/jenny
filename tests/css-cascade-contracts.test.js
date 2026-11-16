'use strict';

// Cascade contracts the gate run caught by eye. jsdom computes no cascade, so
// these read the parsed stylesheet and compare specificity and source order.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

function parseRules(relativePath) {
  const css = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const dom = new JSDOM(`<!doctype html><style>${css}</style>`);
  const rules = [];
  for (const rule of dom.window.document.styleSheets[0].cssRules) {
    if (!rule.selectorText) continue;
    for (const selector of rule.selectorText.split(',')) {
      rules.push({ selector: selector.trim(), style: rule.style, order: rules.length });
    }
  }
  return rules;
}

// [ids, classes + attributes + pseudo-classes, types + pseudo-elements] for the
// simple selectors these files use (no :is/:not/:where arguments).
function specificity(selector) {
  const ids = (selector.match(/#[\w-]+/g) || []).length;
  const pseudoElements = (selector.match(/::[\w-]+/g) || []).length;
  const classes = (selector.match(/\.[\w-]+/g) || []).length
    + (selector.match(/\[[^\]]+\]/g) || []).length
    + (selector.replace(/::[\w-]+/g, '').match(/:[\w-]+/g) || []).length;
  const types = (selector.replace(/\[[^\]]+\]/g, '').match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  return [ids, classes, types + pseudoElements];
}

function beats(winner, loser) {
  const a = specificity(winner.selector);
  const b = specificity(loser.selector);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return winner.order > loser.order;
}

// OL-1 F3 / F21: `.btn` sets a display, which beats the UA `[hidden]` rule, so a
// `.btn` toggled with `hidden` kept its box (Home "Show all" with 3 items).
test('a hidden .btn loses its box against every .btn display rule in buttons.css', () => {
  const rules = parseRules('styles/components/buttons.css');
  const hiddenRule = rules.find((rule) => rule.selector === '.btn[hidden]');
  assert.ok(hiddenRule, 'buttons.css declares .btn[hidden]');
  assert.equal(hiddenRule.style.getPropertyValue('display'), 'none');
  const displayRules = rules.filter((rule) => rule !== hiddenRule
    && /^\.btn\b/.test(rule.selector) && !/\s/.test(rule.selector)
    && rule.style.getPropertyValue('display') && rule.style.getPropertyValue('display') !== 'none');
  assert.ok(displayRules.some((rule) => rule.selector === '.btn'), 'the scan sees the base .btn display');
  for (const rule of displayRules) {
    assert.ok(beats(hiddenRule, rule), `.btn[hidden] must beat ${rule.selector}`);
  }
});

// TV-5 / F12: the checked radio row's check mark lost to the radio column rule.
test('the checked radio row check mark beats the empty radio column', () => {
  const rules = parseRules('renderer/inventory/inventory.css');
  const column = rules.find((rule) => rule.selector === '.inv-context-menu-item[role="menuitemradio"]::before');
  const checked = rules.filter((rule) => /inv-context-menu-item--checked\[role="menuitemradio"\]/.test(rule.selector)
    && /::before$/.test(rule.selector) && rule.style.getPropertyValue('content'));
  assert.ok(column, 'the radio column rule exists');
  assert.equal(checked.length, 1);
  assert.equal(checked[0].style.getPropertyValue('content'), '"✓"');
  assert.ok(beats(checked[0], column), `${checked[0].selector} must beat ${column.selector}`);
});

// Row 156 (replaces the F8 floating-pill offset contract): the find field lives
// in the session bar. chat-search-v2.css loads before chat-session-bar.css, so
// its placement rules must outrank the bar's `> *` order rule and its title
// rule by specificity, not by source order.
test('the find field outranks the session bar rules it overrides', () => {
  const PREFIX = '.chat-view > .chat-pane:not(.ide-chat-dock-body) > .chat-timeline-utility-cluster';
  const bar = parseRules('styles/chat-session-bar.css');
  const find = parseRules('styles/chat-search-v2.css');
  const pick = (rules, selector) => {
    const rule = rules.find((entry) => entry.selector === selector);
    assert.ok(rule, `${selector} exists`);
    return rule;
  };
  const anyChild = pick(bar, `${PREFIX} > *`);
  const title = pick(bar, `${PREFIX} > .session-bar-title`);
  const field = pick(find, `${PREFIX} > .chat-find`);
  const toggle = pick(find, `${PREFIX} > .chat-find-toggle`);
  const hideTitle = pick(find, `${PREFIX}[data-find-open] > .session-bar-title`);
  assert.equal(field.style.getPropertyValue('order'), '1', 'the field sits right after the title slot');
  assert.equal(toggle.style.getPropertyValue('order'), '50', 'the toggle sits before the Session button (60)');
  assert.equal(hideTitle.style.getPropertyValue('display'), 'none');
  const strictlyBeats = (winner, loser) => {
    const a = specificity(winner.selector);
    const b = specificity(loser.selector);
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] > b[index];
    }
    return false;
  };
  assert.ok(strictlyBeats(field, anyChild), 'the field order beats the bar\u2019s order 80');
  assert.ok(strictlyBeats(toggle, anyChild), 'the toggle order beats the bar\u2019s order 80');
  assert.ok(strictlyBeats(hideTitle, title), 'open, the title hides despite its display: block');
  assert.equal(find.some((rule) => /chat-search-overlay-host/.test(rule.selector)), false, 'no floating host remains');
});

// Gate sitting 2026-11-14 (G9): at a 700 px window the open find field was 4 px wide (one letter of the query
// showed): the counter and buttons took the find group's room while the branch control kept its own. Open, the
// group keeps a floor, so the field holds about ten characters, and in a compact bar the diff control steps aside.
test('open, the find group keeps a floor for the field', () => {
  const PREFIX = '.chat-view > .chat-pane:not(.ide-chat-dock-body) > .chat-timeline-utility-cluster';
  const find = parseRules('styles/chat-search-v2.css');
  const open = find.find((entry) => entry.selector === `${PREFIX}[data-find-open] > .chat-find`);
  assert.ok(open, 'an open-state rule for the find group exists');
  assert.equal(open.style.getPropertyValue('min-inline-size'), 'min(18rem, 70%)');
  // Its numbers never truncate, so a squeezed diff control spilled over the find toggle: compact, it steps aside.
  const bar = parseRules('styles/chat-session-bar.css');
  const diffPlace = bar.find((entry) => entry.selector === `${PREFIX} > .session-bar-diff`);
  const aside = find.find((entry) => entry.selector === `${PREFIX}[data-find-open][data-session-bar-compact] > .session-bar-diff`);
  assert.ok(diffPlace && aside, 'both diff rules exist');
  assert.equal(aside.style.getPropertyValue('display'), 'none');
});

// Gate sitting 2026-11-14 (M1): at a 1024 px window the explorer column is about 220 px wide and the Files filter's
// text field was about 30 px (two letters of "menu"). The shared search bar hides its glyph and case/word toggles
// under `@container (max-width: 300px)`, but the explorer filter was no container, so nothing stepped aside.
test('the explorer filter is a container so the shared bar sheds its toggles, and its field keeps a floor', () => {
  const explorer = parseRules('styles/ide-explorer.css');
  const host = explorer.find((entry) => entry.selector === '.ide-tree-filter');
  assert.ok(host, 'the filter host rule exists');
  assert.equal(host.style.getPropertyValue('container-type'), 'inline-size');
  const input = explorer.find((entry) => entry.selector === '.ide-tree-filter .chat-search-bar-input');
  assert.ok(input, 'the filter field rule exists');
  assert.equal(input.style.getPropertyValue('min-inline-size'), '5rem');
  const css = fs.readFileSync(path.join(ROOT, 'styles/chat-search-v2.css'), 'utf8');
  const sheet = new JSDOM(`<!doctype html><style>${css}</style>`).window.document.styleSheets[0];
  const narrow = [...sheet.cssRules].find((rule) => /^@container \(max-width: 300px\)/.test(rule.cssText));
  assert.ok(narrow, 'the shared bar has a narrow-container rule');
  const hidden = [...narrow.cssRules].filter((rule) => rule.style.getPropertyValue('display') === 'none')
    .flatMap((rule) => rule.selectorText.split(',').map((selector) => selector.trim()));
  assert.ok(hidden.includes('.chat-search-bar-toggles'), 'the case and word toggles step aside in a narrow container');
  // Live re-check: the narrow rule sat above the base `display: inline-flex` rule with the same specificity, so it never won.
  const rules = [...sheet.cssRules];
  const lastBase = Math.max(...rules.map((rule, index) => (rule.selectorText && rule.style.getPropertyValue('display')
    && rule.selectorText.split(',').some((selector) => hidden.includes(selector.trim())) ? index : -1)));
  assert.ok(rules.indexOf(narrow) > lastBase, 'the narrow rule comes after the base display rules it overrides');
});

// Gate sitting 2026-11-14 (M3): the empty-board hint stayed drawn through a proposal's ghost cards. The proposals
// view marks the canvas column while a ghost is drawn (tested in renderer-board-proposals-view.test.js); this is
// the rule that reads the mark, and it must outrank the hint's own `display: grid`.
test('the empty-board hint hides while the canvas column is marked as ghosting', () => {
  const hint = parseRules('styles/board.css').find((entry) => entry.selector === '.board-empty-hint');
  const hide = parseRules('styles/board-proposals.css').find((entry) => entry.selector === '.board-centre[data-board-ghosting] > .board-empty-hint');
  assert.ok(hint && hide, 'both rules exist');
  assert.equal(hint.style.getPropertyValue('display'), 'grid');
  assert.equal(hide.style.getPropertyValue('display'), 'none');
  const [, hideClasses] = specificity(hide.selector);
  const [, hintClasses] = specificity(hint.selector);
  assert.ok(hideClasses > hintClasses, 'the hide rule outranks the hint by specificity, not source order');
});
