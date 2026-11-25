'use strict';

// new-test-file: the Needs you badge is its own module (renderer-attention-inbox-flyout.js, which once also held the flyout dialog)
/**
 * tests/renderer-attention-inbox-flyout.test.js
 *
 * Row 158 gate -- the titlebar badge's DOM. The module knows nothing about
 * rows. What the inbox SHOWS is the inbox view's gate
 * (tests/renderer-attention-inbox-view.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createAttentionInboxBadge } = require('../renderer/shell/renderer-attention-inbox-flyout');
const inventoryActionButton = require('../renderer/inventory/action-button');

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
