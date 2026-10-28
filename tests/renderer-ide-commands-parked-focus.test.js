'use strict';

/* Row 82 real-app gate finding: IDE chords (Ctrl+Shift+P, F1, ...) did nothing while
 * focus sat on the page body (after Close All Editors) or the top rail's Workspace tab,
 * because the dispatcher listened only on #ideView. bindViewKeydown adds a document
 * listener for exactly those two spots. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { bindViewKeydown } = require('../renderer/features/renderer-ide-commands');

function setup() {
  const dom = new JSDOM(`<!doctype html><body>
    <header><nav id="topRail"><button id="ideTopRailTab">Workspace</button></nav></header>
    <div id="ideView"><button id="inside">x</button></div>
    <div id="overlay"><input id="paletteInput"></div></body>`);
  const doc = dom.window.document;
  const seen = [];
  const handler = (event) => { seen.push(event.target.id || event.target.tagName); };
  const unbind = bindViewKeydown(doc.getElementById('ideView'), handler);
  const press = (target) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true, bubbles: true }));
  return { dom, doc, seen, unbind, press };
}

test('chords reach the IDE handler from inside the view, the body and the top rail', (t) => {
  const { dom, doc, seen, press } = setup();
  t.after(() => dom.window.close());
  press(doc.getElementById('inside'));
  press(doc.body);
  press(doc.getElementById('ideTopRailTab'));
  assert.deepEqual(seen, ['inside', 'BODY', 'ideTopRailTab']);
});

test('keys typed into an overlay outside the view never reach the IDE handler', (t) => {
  const { dom, doc, seen, press } = setup();
  t.after(() => dom.window.close());
  press(doc.getElementById('paletteInput'));
  assert.deepEqual(seen, []);
});

test('a key with focus parked on the body never reaches the IDE behind an open modal', (t) => {
  // Code review 2026-10-26: Esc, ? and Ctrl chords ran behind a document-level dialog once a
  // click on its dead space dropped focus to the body.
  const { dom, doc, seen, press } = setup();
  t.after(() => dom.window.close());
  const modal = doc.createElement('div');
  modal.setAttribute('aria-modal', 'true');
  doc.body.appendChild(modal);
  press(doc.body);
  press(doc.getElementById('ideTopRailTab'));
  assert.deepEqual(seen, []);
  modal.remove();
  press(doc.body);
  assert.deepEqual(seen, ['BODY']);
});

test('a key inside the view runs the handler once, and unbind removes both listeners', (t) => {
  const { dom, doc, seen, unbind, press } = setup();
  t.after(() => dom.window.close());
  press(doc.getElementById('inside'));
  assert.equal(seen.length, 1);
  unbind();
  press(doc.getElementById('inside'));
  press(doc.body);
  assert.equal(seen.length, 1);
});
