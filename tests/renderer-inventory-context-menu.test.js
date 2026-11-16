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

test('row 151 sectioned menus: a heading item is a line between rows that the arrows skip, and placement below opens under the leading edge', (t) => {
  const { doc, trigger, picks } = setup(t);
  trigger.getBoundingClientRect = () => ({ left: 40, right: 240, top: 20, bottom: 50, width: 200, height: 30 });
  contextMenu.show({ anchorEl: trigger, rootEl: trigger, placement: 'below', focusChecked: true, ariaLabel: 'Projects', items: [
    { heading: 'My projects' }, { label: 'Alpha', checked: false, action: () => picks.push('alpha') },
    { heading: '<b>Lab</b> team' }, { label: 'Site', checked: true, action: () => picks.push('site') }] });
  const menu = doc.querySelector('.inv-context-menu');
  assert.deepEqual([...menu.children].map((el) => [el.className.split(' ')[0], el.getAttribute('role'), el.textContent.trim()]), [
    ['inv-context-menu-heading', 'presentation', 'My projects'], ['inv-context-menu-item', 'menuitemradio', 'Alpha'],
    ['inv-context-menu-heading', 'presentation', '<b>Lab</b> team'], ['inv-context-menu-item', 'menuitemradio', 'Site']]);
  assert.equal(menu.querySelector('b'), null, 'a heading is text');
  assert.deepEqual([menu.getAttribute('aria-label'), menu.style.left, menu.style.top], ['Projects', '40px', '50px']);
  const items = [...menu.querySelectorAll('.inv-context-menu-item')];
  assert.equal(doc.activeElement, items[1]);
  doc.activeElement.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  assert.equal(doc.activeElement, items[0], 'the arrows move between rows, over the heading');
  items[0].click();
  assert.deepEqual(picks, ['alpha']);
});

// Row 123 slice 2a-6c: a row with `items` opens a submenu (the team menu's Export).
function nestedItems(picks) {
  return [{ label: 'Members', action: () => picks.push('members') }, { separator: true },
    { label: 'Export', items: [{ label: 'This conversation…', action: () => picks.push('one') }, { label: 'Every conversation…', action: () => picks.push('all') }] }];
}
const rows = (el) => [...el.querySelectorAll('.inv-context-menu-item')];

test('a nested row: keyboard opens it with ArrowRight or Enter, arrows stay inside, ArrowLeft and Esc go back to the row', (t) => {
  const picks = [];
  const { doc, open, menuEl, key } = setup(t, nestedItems(picks));
  open();
  const parent = rows(menuEl()).find((b) => b.textContent.startsWith('Export'));
  assert.deepEqual([parent.getAttribute('role'), parent.getAttribute('aria-haspopup'), parent.getAttribute('aria-expanded')], ['menuitem', 'menu', 'false']);
  parent.focus();
  key(parent, 'ArrowRight');
  const sub = doc.querySelector('.inv-context-menu--sub');
  assert.deepEqual([sub.getAttribute('role'), sub.getAttribute('aria-label'), parent.getAttribute('aria-expanded')], ['menu', 'Export', 'true']);
  assert.equal(doc.activeElement.textContent, 'This conversation…');
  key(doc.activeElement, 'ArrowDown');
  assert.equal(doc.activeElement.textContent, 'Every conversation…');
  key(doc.activeElement, 'ArrowDown');
  assert.equal(doc.activeElement.textContent, 'This conversation…', 'arrows wrap inside the submenu');
  key(doc.activeElement, 'ArrowLeft');
  assert.equal(doc.querySelector('.inv-context-menu--sub'), null);
  assert.deepEqual([doc.activeElement, parent.getAttribute('aria-expanded')], [parent, 'false']);
  parent.click();
  assert.equal(doc.activeElement.textContent, 'This conversation…', 'Enter or a click opens it and focuses the first choice');
  key(doc.activeElement, 'Escape');
  assert.ok(menuEl(), 'Esc in the submenu keeps the menu');
  assert.deepEqual([doc.querySelector('.inv-context-menu--sub'), parent.getAttribute('aria-expanded'), doc.activeElement], [null, 'false', parent], 'Esc closes the submenu only');
  parent.click();
  doc.activeElement.nextElementSibling.click();
  assert.deepEqual([picks, menuEl(), doc.querySelector('.inv-context-menu--sub')], [['all'], null, null], 'a choice runs and closes both');
});

test('a nested row: pointing opens it after a short delay, another row closes it, and a narrow window flips it before', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const picks = [];
  const { window, doc, open, menuEl } = setup(t, nestedItems(picks));
  const proto = window.HTMLElement.prototype;
  const real = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function rect() {
    if (this.classList.contains('inv-context-menu--sub')) return { left: 0, top: 0, right: 220, bottom: 80, width: 220, height: 80 };
    if (this.getAttribute('aria-haspopup') === 'menu') return { left: 400, top: 100, right: 600, bottom: 128, width: 200, height: 28 };
    return real.call(this);
  };
  t.after(() => { proto.getBoundingClientRect = real; });
  window.innerWidth = 680;
  open();
  const [members, parent] = rows(menuEl());
  parent.dispatchEvent(new window.MouseEvent('mouseenter'));
  assert.equal(doc.querySelector('.inv-context-menu--sub'), null, 'not at once');
  t.mock.timers.tick(200);
  const sub = doc.querySelector('.inv-context-menu--sub');
  assert.ok(sub, 'open after the delay');
  assert.deepEqual([sub.dataset.side, sub.style.left], ['before', '182px'], 'no room after the row: it opens before it');
  members.dispatchEvent(new window.MouseEvent('mouseenter'));
  sub.dispatchEvent(new window.MouseEvent('mouseenter'));
  t.mock.timers.tick(300);
  assert.ok(doc.querySelector('.inv-context-menu--sub'), 'moving onto the submenu keeps it open');
  members.dispatchEvent(new window.MouseEvent('mouseenter'));
  t.mock.timers.tick(200);
  assert.equal(doc.querySelector('.inv-context-menu--sub'), null, 'resting on another row closes it');
  window.innerWidth = 1400;
  parent.click();
  assert.equal(doc.querySelector('.inv-context-menu--sub').dataset.side, 'after');
  doc.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.deepEqual([menuEl(), doc.querySelector('.inv-context-menu--sub'), picks], [null, null, []], 'an outside click closes both');
});

test('a disabled nested row has no submenu and keeps its reason', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { window, doc, trigger, key } = setup(t);
  const picks = [];
  contextMenu.show({ anchorEl: trigger, rootEl: trigger, items: [{ label: 'Members', action: () => picks.push('members') },
    { label: 'Export', disabled: true, description: 'Needs the team online', items: [{ label: 'x', action: () => picks.push('x') }] }] });
  const row = doc.querySelectorAll('.inv-context-menu-item')[1];
  assert.deepEqual([row.disabled, row.hasAttribute('aria-haspopup'), row.textContent.includes('Needs the team online')], [true, false, true]);
  // What an enabled nested row does (the test above) must not happen here: click, ArrowRight, Enter and pointing open nothing.
  row.click();
  key(row, 'ArrowRight');
  key(row, 'Enter');
  row.dispatchEvent(new window.MouseEvent('mouseenter'));
  t.mock.timers.tick(400);
  assert.deepEqual([doc.querySelector('.inv-context-menu--sub'), picks, Boolean(doc.querySelector('.inv-context-menu'))], [null, [], true], 'no submenu, nothing run, the menu stays');
});
