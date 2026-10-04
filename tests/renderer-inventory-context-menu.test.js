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
