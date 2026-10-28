'use strict';

// Primitive-level behaviour of the shared inventory context menu (radio rows,
// descriptions, access keys, keyboard focus recovery, anchor toggling).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const contextMenu = require('../renderer/inventory/context-menu.js');

function setup(t, extraItems) {
  const dom = new JSDOM('<!doctype html><body><button id="trigger">Open</button><input id="field"></body>');
  const { window } = dom;
  const doc = window.document;
  const trigger = doc.getElementById('trigger');
  const picks = [];
  const hides = [];
  const items = extraItems || [
    { label: 'Answers', description: 'Replies only.', checked: false, accessKey: '1', action: () => picks.push('answers') },
    { separator: true },
    { label: 'Thinking', checked: true, accessKey: '2', action: () => picks.push('thinking') },
    { label: 'Plain', shortcutHint: 'Ctrl+P', action: () => picks.push('plain') },
  ];
  const open = () => contextMenu.show({
    anchorEl: trigger, rootEl: trigger, restoreFocusTo: trigger, items,
    onHide: () => hides.push('hide'),
  });
  t.after(() => { contextMenu.hide({ restoreFocus: false }); dom.window.close(); });
  const menuEl = () => doc.querySelector('.inv-context-menu');
  const key = (target, k) => {
    const event = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  return { window, doc, trigger, picks, hides, open, menuEl, key };
}

test('an ariaLabel names the menu; without one the menu has no aria-label', (t) => {
  const { doc, trigger, menuEl } = setup(t);
  contextMenu.show({ anchorEl: trigger, rootEl: trigger, items: [{ label: 'One', action() {} }], ariaLabel: 'Move View to…' });
  assert.equal(menuEl().getAttribute('aria-label'), 'Move View to…');
  contextMenu.show({ anchorEl: trigger, rootEl: trigger, items: [{ label: 'One', action() {} }] });
  assert.equal(doc.querySelector('.inv-context-menu').hasAttribute('aria-label'), false);
});

test('a toggle row is a menuitemcheckbox with aria-checked and the checked class', (t) => {
  const { doc, trigger } = setup(t);
  contextMenu.show({ anchorEl: trigger, rootEl: trigger, items: [{ label: 'Report', toggle: true, checked: true, action() {} }] });
  const button = doc.querySelector('.inv-context-menu-item');
  assert.equal(button.getAttribute('role'), 'menuitemcheckbox');
  assert.equal(button.getAttribute('aria-checked'), 'true');
  assert.equal(button.classList.contains('inv-context-menu-item--checked'), true);
});

test('radio rows carry menuitemradio, aria-checked and the checked class; plain rows stay menuitems', (t) => {
  const { doc, open } = setup(t);
  open();
  const buttons = [...doc.querySelectorAll('.inv-context-menu-item')];
  assert.deepEqual(buttons.map((b) => b.getAttribute('role')), ['menuitemradio', 'menuitemradio', 'menuitem']);
  assert.deepEqual(buttons.map((b) => b.getAttribute('aria-checked')), ['false', 'true', null]);
  assert.deepEqual(buttons.map((b) => b.classList.contains('inv-context-menu-item--checked')), [false, true, false]);
  assert.equal(doc.querySelector('.inv-context-menu [role="separator"]')?.className, 'inv-context-menu-separator');
});

test('a description renders label + description inside the text wrapper and describes the item', (t) => {
  const { doc, open } = setup(t);
  open();
  const [withDescription, withoutDescription, plain] = [...doc.querySelectorAll('.inv-context-menu-item')];
  const wrap = withDescription.querySelector('.inv-context-menu-text');
  assert.ok(wrap, 'text wrapper present');
  assert.equal(wrap.children.length, 2);
  assert.equal(wrap.children[0].textContent, 'Answers');
  const description = wrap.querySelector('.inv-context-menu-description');
  assert.equal(description.textContent, 'Replies only.');
  assert.ok(description.id, 'the description has an id');
  assert.equal(withDescription.getAttribute('aria-describedby'), description.id);
  assert.equal(withoutDescription.querySelector('.inv-context-menu-text'), null, 'no wrapper without a description');
  assert.equal(withoutDescription.hasAttribute('aria-describedby'), false);
  // The access key is announced as a shortcut; its visual hint stays out of the name.
  assert.equal(withDescription.getAttribute('aria-keyshortcuts'), '1');
  assert.equal(withDescription.querySelector('.inv-context-menu-shortcut').getAttribute('aria-hidden'), 'true');
  // A caller-supplied hint (no access key) is still read.
  assert.equal(plain.querySelector('.inv-context-menu-shortcut').textContent, 'Ctrl+P');
  assert.equal(plain.querySelector('.inv-context-menu-shortcut').hasAttribute('aria-hidden'), false);
  assert.equal(plain.hasAttribute('aria-keyshortcuts'), false);
});

test('an access key picks only while focus is inside the menu', (t) => {
  const { doc, open, key, picks, menuEl } = setup(t);
  open();
  assert.equal(doc.activeElement, doc.querySelector('.inv-context-menu-item'), 'first item focused on open');
  const event = key(doc.activeElement, '2');
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(picks, ['thinking']);
  assert.equal(menuEl(), null, 'picking closes the menu');
});

test('a character typed in an outside input is left to that input', (t) => {
  const { doc, open, key, picks, menuEl } = setup(t);
  open();
  const field = doc.getElementById('field');
  field.focus();
  const event = key(field, '1');
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(picks, []);
  const arrow = key(field, 'ArrowDown');
  assert.equal(arrow.defaultPrevented, false, 'arrows in the field stay with the field');
  assert.equal(doc.activeElement, field);
  assert.ok(menuEl(), 'the menu is still open');
});

test('arrow keys keep navigating after a pointer click on menu padding or a separator drops focus to body', (t) => {
  const { window, doc, open, key, menuEl } = setup(t);
  open();
  const items = [...doc.querySelectorAll('.inv-context-menu-item')];
  const separator = menuEl().querySelector('[role="separator"]');
  separator.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.ok(menuEl(), 'a mousedown inside the menu does not dismiss it');
  // A browser moves focus off the item to body for a click on a non-focusable part of the menu.
  doc.activeElement.blur();
  assert.equal(doc.activeElement, doc.body);
  const down = key(doc.body, 'ArrowDown');
  assert.equal(down.defaultPrevented, true);
  assert.equal(doc.activeElement, items[0], 'ArrowDown from nowhere focuses the first item');
  doc.activeElement.blur();
  key(doc.body, 'ArrowUp');
  assert.equal(doc.activeElement, items[items.length - 1], 'ArrowUp from nowhere focuses the last item');
  key(doc.activeElement, 'ArrowDown');
  assert.equal(doc.activeElement, items[0], 'wraps');
});

test('Escape closes the menu from anywhere, including an outside field', (t) => {
  const { doc, open, key, menuEl, hides } = setup(t);
  open();
  const field = doc.getElementById('field');
  field.focus();
  const event = key(field, 'Escape');
  assert.equal(event.defaultPrevented, true);
  assert.equal(menuEl(), null);
  assert.deepEqual(hides, ['hide']);
});

test('Tab from an item closes the menu and restores focus to restoreFocusTo', (t) => {
  const { doc, open, key, menuEl, trigger } = setup(t);
  open();
  key(doc.activeElement, 'Tab');
  assert.equal(menuEl(), null);
  assert.equal(doc.activeElement, trigger);
});

test('a mousedown on the anchor leaves the menu to the anchor; a mousedown elsewhere dismisses it', (t) => {
  const { window, doc, open, menuEl, trigger, hides } = setup(t);
  open();
  trigger.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.ok(menuEl(), 'the anchor owns its own toggle (the click that follows decides)');
  assert.deepEqual(hides, []);
  doc.getElementById('field').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  assert.equal(menuEl(), null, 'an outside mousedown dismisses');
  assert.deepEqual(hides, ['hide']);
});

test('onHide runs once per hide, including when a new show replaces the menu', (t) => {
  const { open, hides, menuEl } = setup(t);
  open();
  open();
  assert.deepEqual(hides, ['hide'], 'the replaced menu reported its hide once');
  assert.ok(menuEl());
  contextMenu.hide();
  contextMenu.hide();
  assert.deepEqual(hides, ['hide', 'hide'], 'a second hide with no menu is a no-op');
});

test('row 63 composer menus: heading, footer, glyph column, upward placement and focus on the checked row', (t) => {
  const { window, doc, trigger, picks } = setup(t);
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  trigger.getBoundingClientRect = () => ({ left: 40, right: 120, top: 700, bottom: 730, width: 80, height: 30 });
  contextMenu.show({
    anchorEl: trigger, rootEl: trigger, placement: 'above', focusChecked: true, className: 'composer-run-mode-menu',
    heading: 'Run mode', footer: 'Shift+Tab switches modes from the message box.',
    items: [
      { label: 'Ask', description: 'Asks first.', iconHtml: '<svg data-glyph="ask"></svg>', checked: false, value: 'ask', action: () => picks.push('ask') },
      { label: 'Plan', description: 'Plans first.', iconHtml: '<svg data-glyph="plan"></svg>', checked: true, value: 'plan', action: () => picks.push('plan') },
    ],
  });
  const menu = doc.querySelector('.inv-context-menu');
  assert.ok(menu.classList.contains('composer-run-mode-menu'));
  assert.equal(menu.getAttribute('aria-label'), 'Run mode', 'the heading names the menu');
  assert.equal(menu.firstElementChild.className, 'inv-context-menu-heading');
  assert.equal(menu.lastElementChild.className, 'inv-context-menu-footer');
  assert.equal(menu.lastElementChild.getAttribute('role'), 'presentation');
  const rows = [...menu.querySelectorAll('.inv-context-menu-item')];
  assert.deepEqual(rows.map((row) => row.getAttribute('data-value')), ['ask', 'plan']);
  assert.equal(rows[0].firstElementChild.className, 'inv-context-menu-icon');
  assert.equal(rows[0].firstElementChild.getAttribute('aria-hidden'), 'true');
  assert.ok(rows[0].querySelector('svg[data-glyph="ask"]'));
  assert.equal(doc.activeElement, rows[1], 'focusChecked opens on the current choice');
  // jsdom lays nothing out (height 0): the menu's bottom sits 6px above the anchor, aligned to its leading edge.
  assert.equal(menu.style.left, '40px');
  assert.equal(menu.style.top, '694px');
  rows[0].click();
  assert.deepEqual(picks, ['ask']);
});
