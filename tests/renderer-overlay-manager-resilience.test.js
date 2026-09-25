'use strict';

// Re-render resilience and the owner close path (batch-3 renderer findings):
// split from renderer-overlay-manager.test.js, which sits at the 600-line
// test-file ratchet.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createOverlayManager } = require('../renderer/shell/renderer-overlay-manager.js');

function buildDom(bodyHtml) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>' + bodyHtml + '</body></html>');
  const doc = dom.window.document;
  for (const el of doc.querySelectorAll('button, input, a, select, textarea, [tabindex]')) {
    Object.defineProperty(el, 'offsetParent', { value: {}, configurable: true });
  }
  return { dom, doc };
}

function isInert(el) {
  return el.inert === true || el.hasAttribute('inert');
}

test('an entry whose root left the DOM without close() is dropped and releases its inert targets', () => {
  const { doc } = buildDom('<div id="appShell"><button id="invoker">open</button></div><div id="root"><button>x</button></div>');
  const manager = createOverlayManager({ documentRef: doc });
  const appShell = doc.getElementById('appShell');
  const root = doc.getElementById('root');
  assert.equal(manager.open({ id: 'leaked', root, onRequestClose() {}, inertTargets: [appShell] }), true);
  assert.equal(isInert(appShell), true);

  // Chrome re-rendered under the overlay and dropped its root; the owner never
  // called close(). The stale entry must not pin the shell for the session.
  root.remove();
  assert.equal(manager.getDepth(), 0);
  assert.equal(manager.isOpen('leaked'), false);
  assert.equal(manager.isOpen(), false);
  assert.equal(isInert(appShell), false);
  manager.dispose();
});

test('requestClose runs the owner close path the way Escape does', () => {
  const { doc } = buildDom('<div id="root"><button>x</button></div>');
  const manager = createOverlayManager({ documentRef: doc });
  const reasons = [];
  manager.open({
    id: 'launcher',
    root: doc.getElementById('root'),
    onRequestClose(reason) { reasons.push(reason); manager.close('launcher'); },
  });
  assert.equal(manager.requestClose('launcher', 'capture_chord'), true);
  assert.deepEqual(reasons, ['capture_chord']);
  assert.equal(manager.getDepth(), 0);
  assert.equal(manager.requestClose('launcher'), false, 'an id that is not on the stack reports false');
  manager.dispose();
});
