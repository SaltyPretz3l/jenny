'use strict';

// new-test-file: a new surface (row 150 slice C5): the sketch frame host's "Pin" action module
// (renderer/features/renderer-sketch-pin.js), over jsdom with a fake host in the shape renderer-sketch-frame-host.js gives.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const sketchPin = require('../renderer/features/renderer-sketch-pin');

const SOURCE = 'title Sign in\nuser User @user\napp App\nuser -> app';
const GLOBALS = ['rendererChatMessageActionBindings', 'rendererAppPaneComposition'];

function setup(t, { flag = true, source = SOURCE } = {}) {
  const dom = new JSDOM('<!doctype html><body><div class="chat-pane" data-pane-id="1"><div class="markdown-sketch-block" id="b1"></div></div><div class="markdown-sketch-block" id="b2"></div></body>', { url: 'https://jenny.invalid/' });
  const saved = Object.fromEntries(GLOBALS.map((name) => [name, globalThis[name]]));
  const opened = [];
  globalThis.rendererChatMessageActionBindings = { pinEnabled: () => flag, openPinMenu: (args) => { opened.push(args); return true; } };
  globalThis.rendererAppPaneComposition = { getPaneComposition: () => ({ getPaneSessionId: (id) => `session-${id}` }) };
  t.after(() => {
    for (const name of GLOBALS) { if (saved[name] === undefined) delete globalThis[name]; else globalThis[name] = saved[name]; }
    dom.window.close();
  });
  const doc = dom.window.document;
  const listeners = [];
  const actions = [];
  const sources = new Map();
  const host = {
    onDrawn(listener) { listeners.push(listener); return () => { listeners.splice(listeners.indexOf(listener), 1); }; },
    addAction(block, element, order) { element.setAttribute('data-sketch-order', String(order)); block.appendChild(element); actions.push({ block, element, order }); return true; },
    sourceOf: (block) => sources.get(block) ?? source,
  };
  return { doc, host, opened, actions, listeners, sources, draw: (id) => listeners.slice().forEach((listener) => listener({ block: doc.getElementById(id) })) };
}

test('each drawing gets one Pin button at order 40 while the flag is on, and none with it off', (t) => {
  const on = setup(t);
  const detach = sketchPin.attach(on.host);
  on.draw('b1');
  on.draw('b2');
  assert.deepEqual(on.actions.map((entry) => [entry.block.id, entry.order]), [['b1', 40], ['b2', 40]]);
  const button = on.actions[0].element;
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.textContent.trim(), 'Pin');
  assert.equal(button.getAttribute('title'), 'Pin this drawing to a board');
  assert.equal(button.getAttribute('type'), 'button');
  // A second draw of the same block replaces its button.
  on.draw('b1');
  assert.equal(on.doc.querySelectorAll('#b1 button').length, 1);
  detach();
  const off = setup(t, { flag: false });
  sketchPin.attach(off.host);
  off.draw('b1');
  assert.deepEqual(off.actions, []);
});

test('clicking opens the picker with the drawing\'s source and its title, from the chat\'s pane', (t) => {
  const s = setup(t);
  sketchPin.attach(s.host);
  s.draw('b1');
  s.draw('b2');
  s.actions[0].element.click();
  assert.equal(s.opened.length, 1);
  const call = s.opened[0];
  assert.deepEqual(call.item, { kind: 'diagram', scene: SOURCE, title: 'Sign in' });
  assert.equal(call.anchorEl, s.actions[0].element);
  assert.equal(call.rootEl, s.doc.getElementById('b1'));
  assert.equal(call.sessionId, 'session-1', 'the pane the block sits in, not "the active chat"');
  assert.equal(call.windowRef, s.doc.defaultView);
  s.actions[1].element.click();
  assert.equal(s.opened[1].sessionId, undefined, 'a block outside a pane (docked, or a board) leaves the chat to the entry');
  s.sources.set(s.doc.getElementById('b2'), 'user User @user\napp App');
  s.actions[1].element.click();
  assert.equal(s.opened[2].item.title, '');
  s.sources.set(s.doc.getElementById('b2'), `title ${'t'.repeat(300)}\napp App`);
  s.actions[1].element.click();
  assert.equal(s.opened[3].item.title.length, 120);
  s.sources.set(s.doc.getElementById('b2'), '');
  s.actions[1].element.click();
  assert.equal(s.opened.length, 4, 'a drawing with no source pins nothing');
});

test('detach removes every button and listener, and a later drawing gets none', (t) => {
  const s = setup(t);
  const detach = sketchPin.attach(s.host);
  s.draw('b1');
  s.draw('b2');
  assert.equal(s.doc.querySelectorAll('button').length, 2);
  const [first] = s.actions;
  detach();
  assert.equal(s.doc.querySelectorAll('button').length, 0);
  assert.deepEqual(s.listeners, []);
  first.element.click();
  assert.deepEqual(s.opened, [], 'a removed button does nothing');
  detach(); // twice is harmless
  assert.equal(typeof sketchPin.attach(s.host), 'function');
});
