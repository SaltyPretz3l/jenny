'use strict';

// new-test-file: the Needs you flyout is a new surface (its own module, renderer-attention-inbox-flyout.js)
/**
 * tests/renderer-attention-inbox-flyout.test.js
 *
 * Row 158 gate -- the dialog beside the collapsed Chats strip and the titlebar
 * badge's DOM. The module knows nothing about rows: these cases pin how the
 * dialog opens, where it sits, and every way it closes, plus that it leaves no
 * element or listener behind. What it SHOWS is the inbox view's gate
 * (tests/renderer-attention-inbox-view.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createAttentionInboxFlyout, createAttentionInboxBadge } = require('../renderer/shell/renderer-attention-inbox-flyout');
const inventoryActionButton = require('../renderer/inventory/action-button');

function harness(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<button id="anchor" aria-expanded="false">mark</button>'
    + '<button id="opener">badge</button>'
    + '<input id="elsewhere">'
    + '</body></html>', { url: 'https://jenny.local/' });
  const { window } = dom;
  const { document } = window;
  window.innerWidth = options.width || 1000;
  window.innerHeight = options.height || 700;
  const registered = new Map();
  const track = (target, label) => {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type, handler, capture) => {
      registered.set(`${label}:${type}`, (registered.get(`${label}:${type}`) || 0) + 1);
      return add(type, handler, capture);
    };
    target.removeEventListener = (type, handler, capture) => {
      registered.set(`${label}:${type}`, (registered.get(`${label}:${type}`) || 0) - 1);
      return remove(type, handler, capture);
    };
  };
  track(document, 'document');
  track(window, 'window');
  const closes = [];
  const flyout = createAttentionInboxFlyout({ documentRef: document, windowRef: window, onClose: () => closes.push('closed') });
  const anchor = document.getElementById('anchor');
  const opener = document.getElementById('opener');
  // The content the inbox would have rendered: one title button to land on, one decision.
  const content = flyout.contentHost();
  content.innerHTML = '<button class="attention-inbox__open" id="first-title">Chat</button>'
    + '<button class="attention-inbox__action" id="allow">Allow</button>';
  const element = document.getElementById('attentionInboxFlyout');
  const stubRect = (node, rect) => { node.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, width: 0, height: 0, ...rect }); };
  const press = (target, type = 'pointerdown') => target.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  const escape = () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return { dom, window, document, flyout, anchor, opener, element, content, closes, registered, stubRect, press, escape };
}

test('the dialog is built once, hidden, as a labelled non-modal dialog on the body', () => {
  const h = harness();
  assert.equal(h.element.parentElement, h.document.body);
  assert.equal(h.element.hidden, true);
  assert.equal(h.element.getAttribute('role'), 'dialog');
  assert.equal(h.element.getAttribute('aria-modal'), 'false');
  assert.equal(h.element.getAttribute('aria-label'), 'Needs you');
  assert.equal(h.element.className, 'attention-inbox-flyout');
  assert.equal(h.content.className, 'attention-inbox attention-inbox--flyout');
  assert.equal(h.flyout.contentHost(), h.content, 'one content host, however often it is asked for');
  assert.equal(h.document.querySelectorAll('#attentionInboxFlyout').length, 1);
  h.flyout.dispose();
  h.window.close();
});

test('open shows the dialog, marks the anchor expanded and lands on the first title, never a decision', () => {
  const h = harness();
  assert.equal(h.flyout.open(h.anchor, { opener: h.opener }), true);
  assert.equal(h.flyout.isOpen(), true);
  assert.equal(h.element.hidden, false);
  assert.equal(h.anchor.getAttribute('aria-expanded'), 'true');
  assert.equal(h.document.activeElement, h.document.getElementById('first-title'));
  assert.notEqual(h.document.activeElement, h.document.getElementById('allow'));
  assert.equal(h.flyout.contains(h.document.getElementById('allow')), true);
  assert.equal(h.flyout.contains(h.anchor), false);
  h.flyout.dispose();
  h.window.close();
});

test('opening an open dialog only repositions it: no second set of listeners, no focus grab', () => {
  const h = harness();
  h.flyout.open(h.anchor, { opener: h.opener });
  h.document.getElementById('elsewhere').focus();
  h.flyout.open(h.anchor, { opener: h.opener });
  assert.equal(h.document.activeElement, h.document.getElementById('elsewhere'));
  assert.equal(h.registered.get('document:keydown'), 1);
  assert.equal(h.registered.get('document:pointerdown'), 1);
  assert.equal(h.registered.get('window:resize'), 1);
  h.flyout.dispose();
  h.window.close();
});

test('Escape closes the dialog and returns focus to whatever opened it', () => {
  const h = harness();
  h.flyout.open(h.anchor, { opener: h.opener });
  h.escape();
  assert.equal(h.flyout.isOpen(), false);
  assert.equal(h.element.hidden, true);
  assert.equal(h.anchor.getAttribute('aria-expanded'), 'false');
  assert.equal(h.document.activeElement, h.opener, 'the titlebar badge asked, so it gets focus back');
  assert.deepEqual(h.closes, ['closed']);

  h.flyout.open(h.anchor);
  h.escape();
  assert.equal(h.document.activeElement, h.anchor, 'with no opener the anchor is the way back');
  h.escape();
  assert.deepEqual(h.closes, ['closed', 'closed'], 'Escape on a closed dialog does nothing');

  // Escape typed somewhere else closes the dialog but leaves the caret where it is.
  h.flyout.open(h.anchor, { opener: h.opener });
  const elsewhere = h.document.getElementById('elsewhere');
  elsewhere.focus();
  h.escape();
  assert.equal(h.flyout.isOpen(), false);
  assert.equal(h.document.activeElement, elsewhere, 'focus outside the dialog is not pulled to the opener');
  h.flyout.dispose();
  h.window.close();
});

test('a press outside closes it and keeps focus where it was; inside, on the anchor or on the opener it stays open', () => {
  const h = harness();
  h.flyout.open(h.anchor, { opener: h.opener });
  h.press(h.document.getElementById('allow'));
  h.press(h.element);
  h.press(h.anchor);
  h.press(h.opener);
  assert.equal(h.flyout.isOpen(), true, 'pointer presses inside, on the anchor and on the opener never close it');
  h.document.getElementById('elsewhere').focus();
  h.press(h.document.getElementById('elsewhere'));
  assert.equal(h.flyout.isOpen(), false);
  assert.equal(h.document.activeElement, h.document.getElementById('elsewhere'), 'focus is not moved by an outside press');
  assert.equal(h.anchor.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(h.closes, ['closed']);
  h.flyout.dispose();
  h.window.close();
});

test('it sits beside the anchor on the reading side, inside the window, and follows a resize', () => {
  const h = harness({ width: 1000, height: 700 });
  h.stubRect(h.element, { width: 320, height: 200 });
  h.stubRect(h.anchor, { left: 10, right: 66, top: 100 });
  h.flyout.open(h.anchor);
  assert.equal(h.element.style.left, '74px', 'LTR: the anchor\'s right edge plus 8');
  assert.equal(h.element.style.top, '100px');
  assert.equal(h.element.style.maxHeight, '584px', 'the window height less the top less 16');

  h.stubRect(h.anchor, { left: 800, right: 900, top: 600 });
  h.window.dispatchEvent(new h.window.Event('resize'));
  assert.equal(h.element.style.left, '672px', 'clamped 8px inside the right edge');
  assert.equal(h.element.style.top, '492px', 'clamped so the whole dialog fits');
  assert.equal(h.element.style.maxHeight, '192px');
  h.flyout.close({ restoreFocus: false });

  // A resize that lands after the strip hid closes the dialog instead of parking it in a corner.
  h.flyout.open(h.anchor);
  h.anchor.hidden = true;
  h.window.dispatchEvent(new h.window.Event('resize'));
  assert.equal(h.flyout.isOpen(), false, 'a hidden anchor closes the dialog');
  h.anchor.hidden = false;

  h.document.documentElement.dir = 'rtl';
  h.stubRect(h.anchor, { left: 944, right: 990, top: 40 });
  h.flyout.open(h.anchor);
  assert.equal(h.element.style.left, '616px', 'RTL: the dialog\'s right edge is 8px before the anchor\'s left');
  h.flyout.close({ restoreFocus: false });
  h.stubRect(h.anchor, { left: 100, right: 150, top: 40 });
  h.flyout.open(h.anchor);
  assert.equal(h.element.style.left, '8px', 'RTL clamps 8px inside the left edge');
  h.flyout.dispose();
  h.window.close();
});

test('closing detaches every open-time listener, and a resize or Escape afterwards does nothing', () => {
  const h = harness();
  h.stubRect(h.element, { width: 320, height: 200 });
  h.stubRect(h.anchor, { left: 10, right: 66, top: 100 });
  h.flyout.open(h.anchor, { opener: h.opener });
  h.flyout.close({ restoreFocus: false });
  assert.equal(h.registered.get('document:keydown'), 0);
  assert.equal(h.registered.get('document:pointerdown'), 0);
  assert.equal(h.registered.get('window:resize'), 0);
  const before = h.element.style.left;
  h.stubRect(h.anchor, { left: 300, right: 360, top: 100 });
  h.window.dispatchEvent(new h.window.Event('resize'));
  h.escape();
  assert.equal(h.element.style.left, before, 'a closed dialog is not repositioned');
  assert.deepEqual(h.closes, ['closed']);
  h.flyout.dispose();
  h.window.close();
});

test('dispose removes the element and its listeners, and is safe twice', () => {
  const h = harness();
  h.flyout.open(h.anchor, { opener: h.opener });
  h.flyout.dispose();
  assert.equal(h.document.getElementById('attentionInboxFlyout'), null);
  assert.equal(h.registered.get('document:keydown'), 0);
  assert.equal(h.registered.get('document:pointerdown'), 0);
  assert.equal(h.registered.get('window:resize'), 0);
  assert.equal(h.anchor.getAttribute('aria-expanded'), 'false');
  assert.equal(h.flyout.isOpen(), false);
  const closesAfterDispose = h.closes.length;
  h.escape();
  assert.equal(h.closes.length, closesAfterDispose, 'a later Escape does nothing');
  assert.equal(h.flyout.open(h.anchor), false, 'a disposed dialog does not reopen');
  assert.equal(h.document.getElementById('attentionInboxFlyout'), null);
  h.flyout.dispose();
  h.window.close();
});

test('the badge is built beside its anchor, counted, hidden at zero, and rebuilt when torn out', () => {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>', { url: 'https://jenny.local/' });
  const { document } = dom.window;
  let clicks = 0;
  const badge = createAttentionInboxBadge({
    anchor: document.getElementById('slot'), actionButton: inventoryActionButton, onClick: () => { clicks += 1; },
  });
  badge.sync(0);
  assert.equal(badge.element(), null, 'nothing waits: no badge is built');
  badge.sync(2);
  const node = document.getElementById('attentionInboxBadge');
  assert.equal(node.previousElementSibling.id, 'slot');
  assert.equal(node.querySelector('.attention-inbox-badge__count').textContent, '2');
  assert.equal(node.getAttribute('aria-label'), '2 things need you');
  node.click();
  assert.equal(clicks, 1);
  badge.sync(0);
  assert.equal(node.hidden, true);
  node.remove();
  assert.equal(badge.tornOut(), true, 'something else removed it: it is forgotten');
  badge.sync(1);
  assert.notEqual(document.getElementById('attentionInboxBadge'), node, 'and a fresh one is built on the next sync');
  node.click();
  assert.equal(clicks, 1, 'the torn-out badge\'s listener was detached');
  badge.dispose();
  assert.equal(document.getElementById('attentionInboxBadge'), null);
  dom.window.close();
});
