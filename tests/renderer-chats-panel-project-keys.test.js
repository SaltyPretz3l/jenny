'use strict';

// Chats sidebar grouped by project (row 74, S3): header toggles join the roving
// keyboard order. Up/Down/Home/End walk headers and rows in DOM order; Right/Left
// open and close a project; ContextMenu on a header opens its menu; Left on a
// depth-0 row inside a project section returns to the header. Date-mode rows keep
// their old behavior.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createShellEventBindings } = require('../renderer/shell/renderer-shell-event-utils.js');

function row(id, { depth = 0, parent = '' } = {}) {
  return `<li class="conversation-item session-row" data-session-id="${id}" data-tree-depth="${depth}"${parent ? ` data-tree-parent-id="${parent}"` : ''}>`
    + `<button data-session-open="${id}" data-session-id="${id}">${id}</button></li>`;
}

function section(id, expanded, rows) {
  return `<section class="conversation-group project-group" data-chats-group="recent_project:${id}" data-project-id="${id}" data-collapsed="${!expanded}">`
    + '<div class="project-header">'
    + `<button class="project-header__toggle" data-project-toggle="${id}" aria-expanded="${expanded}" tabindex="0">${id}</button>`
    + `<button data-project-new="${id}" tabindex="-1">+</button><button data-project-menu="${id}" aria-haspopup="menu" tabindex="-1">...</button>`
    + `</div><ul class="group-items">${rows.join('')}</ul></section>`;
}

const PROJECT_HTML = section('alpha', true, [row('a1'), row('a2')])
  + section('beta', false, [])
  + section('gamma', true, [row('g1'), row('g1c', { depth: 1, parent: 'g1' })]);

const DATE_HTML = '<section class="conversation-group"><h3 class="group-label">Today</h3><ul class="group-items">'
  + row('d1') + row('d2') + '</ul></section>';

function makeHarness(t, html, { dir = '' } = {}) {
  const dom = new JSDOM(`<!doctype html><html${dir ? ` dir="${dir}"` : ''}><body><div id="groups">${html}</div></body></html>`, { pretendToBeVisual: true });
  const { window } = dom;
  const previous = { window: global.window, AbortController: global.AbortController };
  global.window = window;
  global.AbortController = window.AbortController;
  const roving = [];
  const menus = [];
  const bindings = createShellEventBindings({
    state: { ui: {} },
    dom: { conversationGroups: window.document.getElementById('groups') },
    callbacks: {
      setRovingChatSession: (id) => roving.push(id),
      openSessionRowMenu: (payload) => menus.push(payload),
      renderSessions() {},
    },
    constants: { TOAST_SOURCE: {} },
  });
  bindings.bind();
  t.after(() => {
    bindings.dispose();
    window.close();
    global.window = previous.window;
    global.AbortController = previous.AbortController;
  });
  const doc = window.document;
  const q = (selector) => doc.querySelector(selector);
  const press = (el, keyName, init = {}) => {
    el.focus();
    const event = new window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(event);
    return event;
  };
  return { window, doc, q, press, roving, menus };
}

const toggle = (id) => `[data-project-toggle="${id}"]`;
const open = (id) => `[data-session-open="${id}"]`;

test('Down from the last row of a project lands on the next project header; roving is untouched', (t) => {
  const h = makeHarness(t, PROJECT_HTML);
  h.press(h.q(open('a2')), 'ArrowDown');
  assert.equal(h.doc.activeElement, h.q(toggle('beta')));
  assert.deepEqual(h.roving, [], 'a header does not become the roving row');
});

test('Up from a header lands on the previous row and sets it roving', (t) => {
  const h = makeHarness(t, PROJECT_HTML);
  h.press(h.q(toggle('beta')), 'ArrowUp');
  assert.equal(h.doc.activeElement, h.q(open('a2')));
  assert.deepEqual(h.roving, ['a2']);
});

test('Home and End from a header reach the first and last stops', (t) => {
  const h = makeHarness(t, PROJECT_HTML);
  h.press(h.q(toggle('beta')), 'End');
  assert.equal(h.doc.activeElement, h.q(open('g1c')));
  h.press(h.q(open('g1c')), 'Home');
  assert.equal(h.doc.activeElement, h.q(toggle('alpha')));
});

test('Right on a collapsed header clicks its toggle; on an open header it focuses the first row', (t) => {
  const h = makeHarness(t, PROJECT_HTML);
  let clicks = 0;
  h.q(toggle('beta')).addEventListener('click', () => { clicks += 1; });
  const event = h.press(h.q(toggle('beta')), 'ArrowRight');
  assert.equal(clicks, 1);
  assert.equal(event.defaultPrevented, true);
  h.press(h.q(toggle('alpha')), 'ArrowRight');
  assert.equal(h.doc.activeElement, h.q(open('a1')));
  assert.deepEqual(h.roving, ['a1']);
});

test('Left on an open header clicks its toggle; on a collapsed header it does nothing', (t) => {
  const h = makeHarness(t, PROJECT_HTML);
  const clicks = { alpha: 0, beta: 0 };
  h.q(toggle('alpha')).addEventListener('click', () => { clicks.alpha += 1; });
  h.q(toggle('beta')).addEventListener('click', () => { clicks.beta += 1; });
  h.press(h.q(toggle('alpha')), 'ArrowLeft');
  h.press(h.q(toggle('beta')), 'ArrowLeft');
  assert.deepEqual(clicks, { alpha: 1, beta: 0 });
});

test('RTL mirrors the header open and close keys', (t) => {
  const h = makeHarness(t, PROJECT_HTML, { dir: 'rtl' });
  let clicks = 0;
  h.q(toggle('beta')).addEventListener('click', () => { clicks += 1; });
  h.press(h.q(toggle('beta')), 'ArrowRight');
  assert.equal(clicks, 0, 'Right closes in RTL, nothing to close here');
  h.press(h.q(toggle('beta')), 'ArrowLeft');
  assert.equal(clicks, 1);
});

test('ContextMenu and Shift+F10 on a header click its menu button', (t) => {
  const h = makeHarness(t, PROJECT_HTML);
  let clicks = 0;
  h.q('[data-project-menu="gamma"]').addEventListener('click', () => { clicks += 1; });
  const first = h.press(h.q(toggle('gamma')), 'ContextMenu');
  const second = h.press(h.q(toggle('gamma')), 'F10', { shiftKey: true });
  assert.equal(clicks, 2);
  assert.equal(first.defaultPrevented && second.defaultPrevented, true);
  assert.deepEqual(h.menus, [], 'the row menu is not opened for a header');
});

test('modifier chords on a header are ignored', (t) => {
  const h = makeHarness(t, PROJECT_HTML);
  let clicks = 0;
  h.q(toggle('beta')).addEventListener('click', () => { clicks += 1; });
  h.press(h.q(toggle('beta')), 'ArrowRight', { ctrlKey: true });
  assert.equal(clicks, 0);
});

test('Left on a depth-0 row inside a project section focuses its header; a child row still goes to its parent', (t) => {
  const h = makeHarness(t, PROJECT_HTML);
  const event = h.press(h.q(open('a2')), 'ArrowLeft');
  assert.equal(h.doc.activeElement, h.q(toggle('alpha')));
  assert.equal(event.defaultPrevented, true);
  h.press(h.q(open('g1c')), 'ArrowLeft');
  assert.equal(h.doc.activeElement, h.q(open('g1')), 'linked-chat Left is unchanged');
});

test('date-mode rows keep their old keys: Left does nothing, Down walks rows only', (t) => {
  const h = makeHarness(t, DATE_HTML);
  const event = h.press(h.q(open('d1')), 'ArrowLeft');
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.doc.activeElement, h.q(open('d1')));
  h.press(h.q(open('d1')), 'ArrowDown');
  assert.equal(h.doc.activeElement, h.q(open('d2')));
  assert.deepEqual(h.roving, ['d2']);
});
