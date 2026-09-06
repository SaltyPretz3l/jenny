'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const { createDrawer } = require('../renderer/inventory/drawer');

test('drawer traps focus, closes on Escape, restores focus, and disposes its host', () => {
  const dom = new JSDOM('<!doctype html><body><button id="origin">Open</button></body>',
    { pretendToBeVisual: true });
  const documentRef = dom.window.document;
  const origin = documentRef.getElementById('origin');
  origin.focus();
  const drawer = createDrawer({ documentRef, id: 'testDrawer' });
  assert.equal(drawer.open({ title: 'Details', bodyHtml: '<button id="first">First</button><button id="last">Last</button>',
    restoreFocusTo: origin }), true);
  assert.equal(documentRef.activeElement.getAttribute('aria-label'), 'Close details');
  assert.equal(documentRef.activeElement.getAttribute('title'), 'Close details');
  documentRef.getElementById('last').focus();
  documentRef.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true,
    cancelable: true }));
  assert.equal(documentRef.activeElement.getAttribute('aria-label'), 'Close details');
  documentRef.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true,
    cancelable: true }));
  assert.equal(drawer.isOpen(), false);
  assert.equal(documentRef.activeElement, origin);
  drawer.dispose();
  assert.equal(documentRef.getElementById('testDrawer'), null);
});

test('drawer integrates with the overlay manager close contract', () => {
  const dom = new JSDOM('<!doctype html><body><button id="origin">Open</button></body>',
    { pretendToBeVisual: true });
  const calls = [];
  let requestClose;
  const overlayManager = { open(config) { calls.push(['open', config.id]); requestClose = config.onRequestClose;
    return true; }, close(id) { calls.push(['close', id]); } };
  const drawer = createDrawer({ documentRef: dom.window.document, overlayManager, id: 'managedDrawer' });
  drawer.open({ title: 'Managed', bodyHtml: '<p>Body</p>',
    restoreFocusTo: dom.window.document.getElementById('origin') });
  assert.deepEqual(calls, [['open', 'managedDrawer']]);
  requestClose();
  assert.deepEqual(calls, [['open', 'managedDrawer'], ['close', 'managedDrawer']]);
  drawer.dispose();
});
