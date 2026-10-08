'use strict';

// Leaving Settings tears down the Appearance surface-effect preview. Its
// controller used to be released because renderAll painted the Settings page
// (with visible:false) on every view; now the view switch itself runs that pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function trackListeners(host) {
  const bound = new Set();
  const add = host.addEventListener.bind(host);
  const remove = host.removeEventListener.bind(host);
  host.addEventListener = (type, handler, options) => { bound.add(handler); return add(type, handler, options); };
  host.removeEventListener = (type, handler, options) => { bound.delete(handler); return remove(type, handler, options); };
  return bound;
}

test('leaving Settings releases the Appearance effect preview controller', async (t) => {
  const { window, dispose } = await loadRendererApp({ appearance: { surfaceEffectId: 'context-weave' } });
  t.after(dispose);
  const doc = window.document;
  const host = doc.getElementById('appearanceSurfaceEffectPreview');
  const bound = trackListeners(host);

  doc.querySelector('[data-tab-id="settings"]').click();
  await waitForUi(window, 50);
  assert.equal(host.getAttribute('data-widget-modifier'), 'context-weave', 'the preview mounted the chosen effect');
  assert.ok(bound.size > 0, 'the preview controller binds pointer listeners while Settings is open');

  doc.querySelector('[data-tab-id="chat"]').click();
  await waitForUi(window, 50);
  assert.equal(window.__rendererState.ui.activeView, 'chat');
  assert.equal(bound.size, 0, 'the preview controller is released after leaving Settings');
});
