'use strict';

// Wave-R remediation (queue #18, item 3): the Artifact Panel V2 toolbar's
// "Delete artifact" used to call deleteSelectedArtifact() directly on click
// -- no confirmation, immediate on-disk delete. This module gates that call
// behind a danger-confirm dialog, matching the Model Library's Remove-model
// pattern (inv-step-modal, tone "danger", naming the item + "This cannot be
// undone"). RED-FIRST: these assert the confirm/cancel/dismiss contract in
// isolation, before wiring into the artifacts manager.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createArtifactDeleteConfirm } = require('../renderer/features/renderer-artifact-delete-confirm');
const stepModal = require('../renderer/inventory/step-modal');

function makeHarness(t, { artifact = null, performDelete } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="appShell"><button id="backgroundAction">Background</button></main></body></html>');
  const documentRef = dom.window.document;
  const deleteCalls = [];
  const controller = createArtifactDeleteConfirm({
    documentRef,
    stepModal,
    getSelectedArtifact: () => artifact,
    performDelete: performDelete || (async (target) => { deleteCalls.push(target); }),
  });
  controller.bind();
  t.after(() => controller.dispose());
  return { dom, documentRef, controller, deleteCalls };
}

function fixtureArtifact(overrides = {}) {
  return {
    id: 'artifact-1',
    sessionId: 'session-1',
    generatedFile: { displayPath: '.jenny/artifacts/session-1/notes.md', fileName: 'notes.md' },
    ...overrides,
  };
}

function getModal(documentRef) {
  return documentRef.querySelector('[data-step-modal="artifact-panel-confirm-delete"]');
}

test('open() with no selected artifact does not render a modal', (t) => {
  const { documentRef, controller } = makeHarness(t, { artifact: null });
  controller.open();
  assert.equal(getModal(documentRef), null);
  assert.equal(controller.isOpen(), false);
});

test('open() renders a danger confirm naming the artifact, with "This cannot be undone"', (t) => {
  const { documentRef, controller } = makeHarness(t, { artifact: fixtureArtifact() });
  controller.open();
  const modal = getModal(documentRef);
  assert.ok(modal, 'expected the confirm modal to render');
  assert.match(modal.querySelector('.inv-step-modal').className, /inv-step-modal--danger/);
  assert.match(modal.textContent, /Delete artifact\?/);
  assert.match(modal.textContent, /notes\.md/);
  assert.match(modal.textContent, /This cannot be undone/);
  assert.ok(modal.querySelector('[data-step-modal-action="cancel"]'));
  assert.ok(modal.querySelector('[data-step-modal-action="confirm"]'));
  assert.equal(controller.isOpen(), true);
});

test('open() renders an artifact label with entities exactly once', (t) => {
  const artifact = fixtureArtifact({
    generatedFile: { displayPath: 'report & notes.md', fileName: 'report & notes.md' },
  });
  const { documentRef, controller } = makeHarness(t, { artifact });
  controller.open();
  assert.equal(
    documentRef.querySelector('.inv-step-modal-summary').textContent,
    'This deletes "report & notes.md" from disk. This cannot be undone.'
  );
});

test('open() activates modal focus and background inert lifecycle', async (t) => {
  const { documentRef, controller } = makeHarness(t, { artifact: fixtureArtifact() });
  const backgroundAction = documentRef.getElementById('backgroundAction');
  backgroundAction.focus();

  controller.open();
  await Promise.resolve();

  assert.equal(documentRef.getElementById('appShell').hasAttribute('inert'), true);
  assert.equal(getModal(documentRef).contains(documentRef.activeElement), true);

  controller.close();
  assert.equal(documentRef.getElementById('appShell').hasAttribute('inert'), false);
  assert.equal(documentRef.activeElement, backgroundAction);
});

test('Cancel closes the modal without invoking performDelete (artifact intact)', (t) => {
  const { documentRef, controller, deleteCalls } = makeHarness(t, { artifact: fixtureArtifact() });
  controller.open();
  documentRef.querySelector('[data-step-modal-action="cancel"]').click();
  assert.equal(getModal(documentRef), null, 'modal removed on cancel');
  assert.equal(controller.isOpen(), false);
  assert.equal(deleteCalls.length, 0, 'cancel must not delete');
});

test('Escape closes the modal without invoking performDelete', (t) => {
  const { documentRef, controller, deleteCalls } = makeHarness(t, { artifact: fixtureArtifact() });
  controller.open();
  documentRef.dispatchEvent(new documentRef.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(getModal(documentRef), null);
  assert.equal(deleteCalls.length, 0);
});

test('backdrop click closes the modal; clicking inside the dialog panel does not', (t) => {
  const { documentRef, controller } = makeHarness(t, { artifact: fixtureArtifact() });
  controller.open();
  documentRef.querySelector('.inv-step-modal-summary').click();
  assert.equal(controller.isOpen(), true, 'click inside the dialog panel must not dismiss it');
  documentRef.querySelector('[data-step-modal="artifact-panel-confirm-delete"]').click();
  assert.equal(controller.isOpen(), false, 'backdrop click dismisses');
});

test('Delete/confirm invokes performDelete exactly once with the pending artifact and removes the modal', async (t) => {
  const artifact = fixtureArtifact({ id: 'artifact-9', sessionId: 'session-9' });
  const { documentRef, controller, deleteCalls } = makeHarness(t, { artifact });
  controller.open();
  documentRef.querySelector('[data-step-modal-action="confirm"]').click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(getModal(documentRef), null, 'modal removed on confirm');
  assert.equal(controller.isOpen(), false);
  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0].id, 'artifact-9');
  assert.equal(deleteCalls[0].sessionId, 'session-9');
});

test('a rejected performDelete does not throw out of confirm()', async (t) => {
  const { documentRef, controller } = makeHarness(t, {
    artifact: fixtureArtifact(),
    performDelete: async () => { throw new Error('delete failed'); },
  });
  controller.open();
  documentRef.querySelector('[data-step-modal-action="confirm"]').click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(getModal(documentRef), null);
});

test('dispose() removes a still-open modal and unbinds listeners', (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const documentRef = dom.window.document;
  const controller = createArtifactDeleteConfirm({
    documentRef,
    stepModal,
    getSelectedArtifact: () => fixtureArtifact(),
    performDelete: async () => {},
  });
  controller.bind();
  controller.open();
  assert.ok(getModal(documentRef));
  controller.dispose();
  assert.equal(getModal(documentRef), null);
  assert.equal(controller.isOpen(), false);
});
