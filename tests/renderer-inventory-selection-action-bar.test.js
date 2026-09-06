const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSelectionActionBar } = require('../renderer/inventory/selection-action-bar');

function build() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="host" hidden></div></body></html>');
  const host = dom.window.document.getElementById('host');
  const bar = createSelectionActionBar({
    document: dom.window.document,
    hostId: 'test-selection-action-bar',
  });
  return { dom, host, bar };
}

test('mounts the toolbar scaffolding (F4)', () => {
  const { host, bar } = build();
  bar.mount(host);

  const root = host.querySelector('.selection-action-bar');
  assert.ok(root, 'bar root should mount');
  assert.equal(root.getAttribute('role'), 'toolbar');
  assert.equal(root.getAttribute('aria-label'), 'Selection actions');

  const count = host.querySelector('.selection-action-bar-count');
  assert.ok(count);
  assert.equal(count.tagName, 'OUTPUT');
  assert.equal(count.getAttribute('aria-live'), 'polite');
  assert.equal(count.textContent, '0 selected');

  const buttons = host.querySelectorAll('button[data-selection-action]');
  assert.equal(buttons.length, 9, 'copy-md, copy-plain, export-toggle, 4 menu items, delete-from-here, cancel');

  // Mounting should remove the host's hidden attribute.
  assert.equal(host.hasAttribute('hidden'), false);
});

test('unmount removes the bar and re-hides the host (F4)', () => {
  const { host, bar } = build();
  bar.mount(host);
  bar.unmount();
  assert.equal(host.querySelector('.selection-action-bar'), null);
  assert.equal(host.hasAttribute('hidden'), true);
});

test('setSelectionCount updates the count badge (F4)', () => {
  const { host, bar } = build();
  bar.mount(host);
  bar.setSelectionCount(1);
  assert.equal(host.querySelector('.selection-action-bar-count').textContent, '1 selected');
  bar.setSelectionCount(5);
  assert.equal(host.querySelector('.selection-action-bar-count').textContent, '5 selected');
});

test('Copy buttons emit copy-md and copy-plain (F5)', () => {
  const { host, bar } = build();
  bar.mount(host);
  const events = [];
  bar.on('copy-md', () => events.push('copy-md'));
  bar.on('copy-plain', () => events.push('copy-plain'));
  host.querySelector('[data-selection-action="copy-md"]').click();
  host.querySelector('[data-selection-action="copy-plain"]').click();
  assert.deepEqual(events, ['copy-md', 'copy-plain']);
});

test('Export toggle button opens and closes the format menu (F6)', () => {
  const { host, bar } = build();
  bar.mount(host);
  const toggle = host.querySelector('[data-selection-action="export-toggle"]');
  const menu = host.querySelector('.selection-action-bar-export-menu');
  assert.equal(menu.hasAttribute('hidden'), true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.click();
  assert.equal(menu.hasAttribute('hidden'), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  toggle.click();
  assert.equal(menu.hasAttribute('hidden'), true);
});

test('Choosing an export format emits the scoped event and closes menu (F6)', () => {
  const { host, bar } = build();
  bar.mount(host);
  const specific = [];
  bar.on('export:markdown', () => specific.push('markdown'));
  host.querySelector('[data-selection-action="export-toggle"]').click();
  host.querySelector('[data-selection-action="export:markdown"]').click();
  assert.deepEqual(specific, ['markdown']);
  // Menu collapses after selecting a format.
  assert.equal(host.querySelector('.selection-action-bar-export-menu').hasAttribute('hidden'), true);
});

test('Delete button emits delete-from-here (F4)', () => {
  const { host, bar } = build();
  bar.mount(host);
  let count = 0;
  bar.on('delete-from-here', () => { count += 1; });
  host.querySelector('[data-selection-action="delete-from-here"]').click();
  assert.equal(count, 1);
});

test('Cancel button emits cancel (F4)', () => {
  const { host, bar } = build();
  bar.mount(host);
  let count = 0;
  bar.on('cancel', () => { count += 1; });
  host.querySelector('[data-selection-action="cancel"]').click();
  assert.equal(count, 1);
});

test('Esc inside the bar collapses the export menu (F6)', () => {
  const { host, bar } = build();
  bar.mount(host);
  host.querySelector('[data-selection-action="export-toggle"]').click();
  const toggle = host.querySelector('[data-selection-action="export-toggle"]');
  const menu = host.querySelector('.selection-action-bar-export-menu');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(menu.hasAttribute('hidden'), false);
  const root = host.querySelector('.selection-action-bar');
  const win = root.ownerDocument.defaultView;
  root.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(menu.hasAttribute('hidden'), true);
});

test('setBusy disables every action button and flips aria-busy (F4)', () => {
  const { host, bar } = build();
  bar.mount(host);
  bar.setBusy(true);
  const root = host.querySelector('.selection-action-bar');
  assert.equal(root.getAttribute('aria-busy'), 'true');
  const buttons = host.querySelectorAll('button[data-selection-action]');
  buttons.forEach((btn) => {
    assert.equal(btn.hasAttribute('disabled'), true);
  });
  bar.setBusy(false);
  assert.equal(root.hasAttribute('aria-busy'), false);
});

test('dispose removes listeners and unmounts the bar (F4)', () => {
  const { host, bar } = build();
  bar.mount(host);
  bar.dispose();
  assert.equal(host.querySelector('.selection-action-bar'), null);
});
