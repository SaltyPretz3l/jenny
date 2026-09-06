'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createOverlayManager } = require('../renderer/shell/renderer-overlay-manager');
const { createLifecycle, renderStepModal } = require('../renderer/inventory/step-modal');

function buildDom() {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<button id="trigger">Open setup</button>'
    + '<main id="appShell"></main>'
    + '<div id="modalRoot"></div>'
    + '</body></html>');
  return { dom, documentRef: dom.window.document };
}

test('renderStepModal exposes a focus fallback and associates its summary', () => {
  const html = renderStepModal({ id: 'endpoint', title: 'Endpoint', summary: 'Choose a local endpoint.' });
  assert.match(html, /tabindex="-1"/);
  assert.match(html, /aria-describedby="endpoint-summary"/);
  assert.match(html, /id="endpoint-summary"/);
});

test('managed lifecycle traps ownership in the overlay manager and restores background/focus', async () => {
  const { dom, documentRef } = buildDom();
  const trigger = documentRef.getElementById('trigger');
  const appShell = documentRef.getElementById('appShell');
  const modalRoot = documentRef.getElementById('modalRoot');
  modalRoot.innerHTML = renderStepModal({
    id: 'endpoint',
    title: 'Endpoint',
    actions: [{ id: 'save', label: 'Save', variant: 'primary' }],
  });
  trigger.focus();
  const manager = createOverlayManager({ documentRef });
  let lifecycle;
  lifecycle = createLifecycle({
    documentRef,
    mountRoot: modalRoot,
    overlayManager: manager,
    inertTargets: [appShell],
  });

  assert.equal(lifecycle.open({ id: 'setup-endpoint', onRequestClose: () => lifecycle.close() }), true);
  await Promise.resolve();
  assert.equal(manager.isOpen('setup-endpoint'), true);
  assert.equal(appShell.hasAttribute('inert'), true);
  assert.equal(documentRef.activeElement.getAttribute('data-step-modal-action'), 'save');

  documentRef.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }));
  assert.equal(lifecycle.isOpen(), false);
  assert.equal(manager.getDepth(), 0);
  assert.equal(appShell.hasAttribute('inert'), false);
  assert.equal(documentRef.activeElement, trigger);
  dom.window.close();
});

test('fallback lifecycle owns Escape, inert restoration, and disposal when the manager is missing', async () => {
  const { dom, documentRef } = buildDom();
  const appShell = documentRef.getElementById('appShell');
  const modalRoot = documentRef.getElementById('modalRoot');
  modalRoot.innerHTML = renderStepModal({
    id: 'workspace',
    title: 'Workspace',
    actions: [{ id: 'cancel', label: 'Cancel' }],
  });
  const logs = [];
  let closeRequests = 0;
  const lifecycle = createLifecycle({
    documentRef,
    mountRoot: modalRoot,
    inertTargets: () => [appShell],
    appendClientLog: (...args) => logs.push(args),
  });
  lifecycle.open({ id: 'setup-workspace', onRequestClose: () => { closeRequests += 1; lifecycle.close(); } });
  lifecycle.dispose();
  lifecycle.dispose();
  await Promise.resolve();

  documentRef.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }));
  assert.equal(closeRequests, 0, 'dispose removed the fallback listener');
  assert.equal(appShell.hasAttribute('inert'), false);
  assert.equal(lifecycle.open({ id: 'later' }), false);
  assert.ok(logs.some((entry) => entry[1] === 'step_modal.overlay_manager_unavailable'));
  dom.window.close();
});
