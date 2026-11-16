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

test('the drawer panel starts below the title bar, clear of the window controls that stack above it', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'inventory', 'inventory-drawer.css'), 'utf8');
  const panel = css.match(/\.inv-drawer-panel \{([^}]*)\}/)[1];
  assert.match(panel, /margin-top: var\(--titlebar-height, 0px\)/);
  assert.match(panel, /height: calc\(100% - var\(--titlebar-height, 0px\)\)/);
  const scrim = css.match(/\.inv-drawer-scrim \{([^}]*)\}/)[1];
  assert.match(scrim, /margin-top: var\(--titlebar-height, 0px\)/, 'the scrim leaves the title bar evenly undimmed instead of dimming only its left part');
  const tier = css.match(/\.inv-drawer-host \{([^}]*)\}/)[1];
  assert.match(tier, /z-index: calc\(var\(--z-popover\) - 1\)/, 'the drawer stays below the window controls tier this offset accounts for');
});

test('drawer content never widens the panel: one shrinkable column and no sideways scroll', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'inventory', 'inventory-drawer.css'), 'utf8');
  const body = css.match(/\.inv-drawer-body \{([^}]*)\}/)[1];
  assert.match(body, /grid-template-columns: minmax\(0, 1fr\)/, 'an implicit auto track grows to the widest unwrapped line');
  const panel = css.match(/\.inv-drawer-panel \{([^}]*)\}/)[1];
  assert.match(panel, /overflow: hidden auto/, 'the panel scrolls down only');
});

test('API provider model rows wrap their details under the ID instead of one wide line', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'styles', 'settings-api-providers.css'), 'utf8');
  // Every block whose selector list ends in this selector, joined.
  const rule = (selector) => [...css.matchAll(new RegExp(`(?:^|\\n)${selector.replace(/[.>-]/g, '\\$&')} \\{([^}]*)\\}`, 'g'))]
    .map((match) => match[1]).join('\n');
  assert.match(rule('.api-providers-model'), /grid-template-columns: auto minmax\(0, 1fr\);/);
  const meta = rule('.api-providers-model-meta');
  assert.match(meta, /grid-column: 2;/);
  assert.doesNotMatch(meta, /nowrap/, 'one unwrapped details line pushed the drawer past its panel');
  assert.match(rule('.api-providers-models-foot'), /flex-wrap: wrap;/);
});
