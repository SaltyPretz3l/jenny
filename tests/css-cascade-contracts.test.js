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
  const checked = rules.filter((rule) => /inv-context-menu-item--checked/.test(rule.selector)
    && /::before$/.test(rule.selector) && rule.style.getPropertyValue('content'));
  assert.ok(column, 'the radio column rule exists');
  assert.equal(checked.length, 1);
  assert.equal(checked[0].style.getPropertyValue('content'), '"✓"');
  assert.ok(beats(checked[0], column), `${checked[0].selector} must beat ${column.selector}`);
});

// F8: the search bar ran to the stage's right edge, so its Close sat under the
// conversation utility cluster's Artifacts toggle. The find pill floats at the
// stage's top inline-end and must end inside the cluster's footprint; the
// offset is logical so the pill mirrors with the cluster in RTL.
test('the chat find pill ends inside the conversation utility cluster', () => {
  const tokens = {};
  for (const rule of parseRules('styles/foundation.css')) {
    if (rule.selector !== ':root') continue;
    for (const name of ['--space-2', '--space-4']) {
      const value = rule.style.getPropertyValue(name).trim();
      if (value && !tokens[name]) tokens[name] = value;
    }
  }
  // Resolves the px tokens and the calc() arithmetic these two rules use.
  const px = (value) => {
    const expression = value.replace(/var\((--[\w-]+)\)/g, (_match, name) => tokens[name])
      .replace(/^calc\((.*)\)$/, '$1').replace(/px/g, '');
    assert.match(expression, /^[\d\s.+*()-]+$/, `resolvable length: ${value}`);
    return Function(`return (${expression});`)();
  };
  const host = parseRules('styles/chat-search-v2.css').find((rule) => rule.selector === '.chat-search-overlay-host');
  assert.equal(host.style.getPropertyValue('position'), 'absolute', 'the pill floats instead of spanning the stage');
  const orientation = parseRules('styles/chat-timeline-orientation-v2.css');
  const cluster = orientation.find((rule) => rule.selector === '.chat-timeline-utility-cluster');
  const button = orientation.find((rule) => rule.selector === '.chat-timeline-utility-button');
  const footprint = px(button.style.getPropertyValue('width')) + px(cluster.style.getPropertyValue('margin-inline-end'));
  assert.ok(px(host.style.getPropertyValue('inset-inline-end')) > footprint, 'Close clears the utility cluster');
});
