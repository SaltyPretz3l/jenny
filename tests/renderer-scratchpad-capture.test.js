const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const textField = require('../renderer/inventory/text-field.js');
const { createScratchpadCaptureController } = require('../renderer/features/renderer-scratchpad-capture.js');

function setup(onCapture, overrides = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const documentRef = dom.window.document;
  const toasts = [];
  const logs = [];
  const controller = createScratchpadCaptureController({
    documentRef,
    textField,
    onCapture,
    showToastMessage: (msg, meta) => toasts.push([msg, meta]),
    appendClientLog: (...args) => logs.push(args),
    ...overrides,
  });
  return { dom, documentRef, controller, toasts, logs };
}

function keydown(documentRef, target, key, extra = {}) {
  target.dispatchEvent(new documentRef.defaultView.KeyboardEvent('keydown', { key, bubbles: true, ...extra }));
}

test('open() mounts the popover, isOpen flips, and the input is focused', () => {
  const { documentRef, controller } = setup(() => Promise.resolve({ ok: true }));
  assert.equal(controller.isOpen(), false);
  assert.equal(controller.open(), true);
  assert.equal(controller.isOpen(), true);
  const root = documentRef.querySelector('.scratchpad-capture');
  assert.ok(root);
  assert.equal(root.hidden, false);
  assert.equal(documentRef.activeElement, documentRef.querySelector('#scratchpadCaptureInput'));
});

test('Enter submits trimmed text, toasts success, and closes', async () => {
  const captured = [];
  const { documentRef, controller, toasts } = setup((text, options) => {
    captured.push([text, options]);
    return Promise.resolve({ ok: true, noteTitle: 'Note 1' });
  });
  controller.open();
  const input = documentRef.querySelector('#scratchpadCaptureInput');
  input.value = '  hello world  ';
  keydown(documentRef, input, 'Enter');
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(captured, [['hello world', {}]]);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0][0], /Added to Note 1\./);
  assert.equal(toasts[0][1].tone, 'success');
  assert.equal(controller.isOpen(), false);
});

test('empty input shows an error and does not call onCapture', () => {
  let called = false;
  const { documentRef, controller } = setup(() => { called = true; return Promise.resolve({ ok: true }); });
  controller.open();
  controller.submit();
  assert.equal(called, false);
  assert.match(documentRef.querySelector('[data-capture-status]').textContent, /Type something/);
  assert.equal(controller.isOpen(), true);
});

test('a failed capture keeps the popover open and surfaces the error (no toast)', async () => {
  const { documentRef, controller, toasts } = setup(() => Promise.resolve({ error: 'Notes are unavailable.' }));
  controller.open();
  documentRef.querySelector('#scratchpadCaptureInput').value = 'x';
  controller.submit();
  await new Promise((r) => setImmediate(r));

  assert.equal(controller.isOpen(), true);
  assert.equal(toasts.length, 0);
  assert.match(documentRef.querySelector('[data-capture-status]').textContent, /unavailable/);
});

test('a thrown onCapture is caught, logged, and reported inline', async () => {
  const { documentRef, controller, toasts, logs } = setup(() => Promise.reject(new Error('boom')));
  controller.open();
  documentRef.querySelector('#scratchpadCaptureInput').value = 'x';
  controller.submit();
  await new Promise((r) => setImmediate(r));

  assert.equal(controller.isOpen(), true);
  assert.equal(toasts.length, 0);
  assert.match(documentRef.querySelector('[data-capture-status]').textContent, /Could not save/);
  assert.ok(logs.some((entry) => entry[1] === 'scratchpad.capture_failed'));
});

test('Escape and backdrop click close the popover', () => {
  const { documentRef, controller } = setup(() => Promise.resolve({ ok: true }));
  controller.open();
  const root = documentRef.querySelector('.scratchpad-capture');
  keydown(documentRef, root, 'Escape');
  assert.equal(controller.isOpen(), false);

  controller.open();
  documentRef.querySelector('[data-capture-dismiss]')
    .dispatchEvent(new documentRef.defaultView.MouseEvent('click', { bubbles: true }));
  assert.equal(controller.isOpen(), false);
});

test('dispose removes the node and stops responding', () => {
  const { documentRef, controller } = setup(() => Promise.resolve({ ok: true }));
  controller.open();
  assert.ok(documentRef.querySelector('.scratchpad-capture'));
  controller.dispose();
  assert.equal(documentRef.querySelector('.scratchpad-capture'), null);
  assert.equal(controller.isOpen(), false);
});

test('open() is a no-op when onCapture is missing', () => {
  const { documentRef, controller } = setup(undefined);
  assert.equal(controller.open(), false);
  assert.equal(documentRef.querySelector('.scratchpad-capture'), null);
});

test('a stale capture that resolves after close+reopen is ignored (no clobber, no toast)', async () => {
  let resolveCapture;
  const { documentRef, controller, toasts } = setup(() => new Promise((res) => { resolveCapture = res; }));
  controller.open();
  documentRef.querySelector('#scratchpadCaptureInput').value = 'first';
  controller.submit();              // in-flight
  controller.close();               // user dismisses before it resolves
  controller.open();                // reopens a fresh session
  documentRef.querySelector('#scratchpadCaptureInput').value = 'second';

  resolveCapture({ ok: true, noteTitle: 'Note 1' }); // the OLD submit resolves now
  await new Promise((r) => setImmediate(r));

  assert.equal(toasts.length, 0, 'stale result does not toast');
  assert.equal(controller.isOpen(), true, 'the reopened popover stays open');
  assert.equal(documentRef.querySelector('#scratchpadCaptureInput').value, 'second', 'reopened input is preserved');
});

test('open() after dispose is a no-op', () => {
  const { documentRef, controller } = setup(() => Promise.resolve({ ok: true }));
  controller.dispose();
  assert.equal(controller.open(), false);
  assert.equal(documentRef.querySelector('.scratchpad-capture'), null);
});
