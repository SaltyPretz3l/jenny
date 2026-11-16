const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createHelpOverlay } = require('../renderer/inventory/help-overlay');

function buildOverlay(body) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + (body || '<button id="trigger" type="button">Open</button>')
    + '</body></html>');
  const overlay = createHelpOverlay({ document: dom.window.document, hostId: 'test-overlay' });
  return { dom, overlay };
}

test('opens and exposes dialog with proper ARIA scaffolding (E7)', () => {
  const { dom, overlay } = buildOverlay();
  overlay.open({
    title: 'Test Help',
    titleId: 'testHelpTitle',
    bodyHtml: '<p class="overlay-body-marker">body content</p>',
    closeLabel: 'Close',
  });

  const host = dom.window.document.getElementById('test-overlay');
  assert.ok(host, 'host element should be appended to body');
  assert.equal(host.hidden, false, 'host should be visible after open');
  const dialog = host.querySelector('.inv-help-overlay-dialog');
  assert.ok(dialog, 'dialog element should be rendered');
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'testHelpTitle');
  const title = host.querySelector('#testHelpTitle');
  assert.ok(title);
  assert.equal(title.textContent, 'Test Help');
  assert.ok(host.querySelector('.overlay-body-marker'), 'body content rendered');
  assert.equal(overlay.isOpen(), true);
});

test('Esc keydown closes the overlay and restores focus (E7)', () => {
  const { dom, overlay } = buildOverlay();
  const trigger = dom.window.document.getElementById('trigger');
  trigger.focus();
  assert.equal(dom.window.document.activeElement, trigger);

  overlay.open({ title: 'Help', bodyHtml: '<p>body</p>' });
  assert.equal(overlay.isOpen(), true);

  const escEvent = new dom.window.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  dom.window.document.dispatchEvent(escEvent);

  assert.equal(overlay.isOpen(), false, 'Esc should close the overlay');
  assert.equal(dom.window.document.activeElement, trigger, 'focus should return to the original trigger');
});

test('clicking the scrim background closes the overlay (E7)', () => {
  const { dom, overlay } = buildOverlay();
  overlay.open({ title: 'Help', bodyHtml: '<p>body</p>' });

  const host = dom.window.document.getElementById('test-overlay');
  const mousedown = new dom.window.MouseEvent('mousedown', { bubbles: true });
  host.dispatchEvent(mousedown);

  assert.equal(overlay.isOpen(), false);
});

test('clicking the close button closes the overlay (E7)', () => {
  const { dom, overlay } = buildOverlay();
  overlay.open({ title: 'Help', bodyHtml: '<p>body</p>', closeLabel: 'Close shortcuts' });

  const host = dom.window.document.getElementById('test-overlay');
  const closeBtn = host.querySelector('[data-help-overlay-close]');
  assert.ok(closeBtn);
  assert.equal(closeBtn.getAttribute('aria-label'), 'Close shortcuts');
  assert.equal(closeBtn.getAttribute('title'), 'Close shortcuts');

  closeBtn.click();
  assert.equal(overlay.isOpen(), false);
});

test('focus traps inside the dialog on open (E7)', () => {
  const { dom, overlay } = buildOverlay();
  overlay.open({ title: 'Help', bodyHtml: '<p>body</p>' });
  const host = dom.window.document.getElementById('test-overlay');
  const closeBtn = host.querySelector('[data-help-overlay-close]');
  assert.equal(dom.window.document.activeElement, closeBtn, 'close button should receive focus on open');
});

test('destroy removes the host element from the DOM (E7)', () => {
  const { dom, overlay } = buildOverlay();
  overlay.open({ title: 'Help', bodyHtml: '<p>body</p>' });
  overlay.destroy();
  assert.equal(dom.window.document.getElementById('test-overlay'), null);
  assert.equal(overlay.isOpen(), false);
});

test('onClose callback fires when overlay closes (E7)', () => {
  const { overlay } = buildOverlay();
  let closeCount = 0;
  overlay.open({
    title: 'Help',
    bodyHtml: '<p>body</p>',
    onClose: () => { closeCount += 1; },
  });
  overlay.close();
  assert.equal(closeCount, 1);
  // Second close is a no-op (already closed).
  overlay.close();
  assert.equal(closeCount, 1);
});

test('headerHtml, size, initialFocusSelector and onRender extend the dialog (wide variant)', () => {
  const { dom, overlay } = buildOverlay();
  const doc = dom.window.document;
  const rendered = [];
  overlay.open({
    title: 'Wide',
    titleId: 'wideTitle',
    headerHtml: '<input id="extraField" type="text" aria-label="Extra">',
    size: 'wide',
    initialFocusSelector: '#extraField',
    bodyHtml: '<p>body</p>',
    onRender: (dialog) => { rendered.push(dialog); },
  });
  const dialog = doc.querySelector('.inv-help-overlay-dialog');
  assert.ok(dialog.classList.contains('inv-help-overlay-dialog--wide'));
  const header = dialog.querySelector('.inv-help-overlay-header');
  const children = Array.from(header.children);
  assert.deepEqual(children.map((el) => el.className), [
    'inv-help-overlay-title',
    'inv-help-overlay-header-extra',
    'inv-help-overlay-close',
  ]);
  assert.ok(children[1].querySelector('#extraField'));
  assert.equal(doc.activeElement, doc.getElementById('extraField'));
  assert.deepEqual(rendered, [dialog], 'onRender is called once with the dialog');
});

test('an unmatched initialFocusSelector falls back to the close button and a throwing onRender is swallowed', () => {
  const { dom, overlay } = buildOverlay();
  overlay.open({
    title: 'Help',
    bodyHtml: '<p>body</p>',
    size: 'huge',
    initialFocusSelector: '#nope',
    onRender: () => { throw new Error('boom'); },
  });
  const doc = dom.window.document;
  assert.equal(overlay.isOpen(), true);
  assert.equal(doc.activeElement, doc.querySelector('[data-help-overlay-close]'));
  assert.equal(doc.querySelector('.inv-help-overlay-dialog--wide'), null, 'unknown sizes are ignored');
  assert.equal(doc.querySelector('.inv-help-overlay-header-extra'), null, 'no header extra without headerHtml');
});

test('open() with only title and bodyHtml behaves as before the extensions', () => {
  const { dom, overlay } = buildOverlay();
  overlay.open({ title: 'Plain', bodyHtml: '<p>body</p>' });
  const doc = dom.window.document;
  assert.equal(doc.querySelector('.inv-help-overlay-dialog').className, 'inv-help-overlay-dialog');
  assert.equal(doc.activeElement, doc.querySelector('[data-help-overlay-close]'));
  assert.equal(doc.querySelector('.inv-help-overlay-header').children.length, 2);
});
