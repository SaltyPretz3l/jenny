const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const chip = require('../renderer/inventory/chip');
const popover = require('../renderer/inventory/popover');

/* ── Chip rendering ── */

test('chip renders button with label and count slot', () => {
  const html = chip({ id: 'tools', label: 'Tools', count: '4/5' });
  assert.ok(html.startsWith('<button'), 'renders a real button');
  assert.ok(html.includes('type="button"'), 'non-submitting button');
  assert.ok(html.includes('class="inv-chip"'), 'base class');
  assert.ok(html.includes('data-inv-chip="tools"'), 'data id');
  assert.ok(html.includes('<span class="inv-chip-label">Tools</span>'), 'label slot');
  assert.ok(html.includes('<span class="inv-chip-count">4/5</span>'), 'count slot');
});

test('chip omits count slot when count is empty', () => {
  const html = chip({ id: 'tools', label: 'Tools' });
  assert.ok(!html.includes('inv-chip-count'), 'no count slot');
});

test('chip hasPopup emits aria-haspopup and collapsed aria-expanded', () => {
  const html = chip({ id: 'tools', label: 'Tools', hasPopup: true, ariaControls: 'toolsPopover' });
  assert.ok(html.includes('aria-haspopup="dialog"'));
  assert.ok(html.includes('aria-expanded="false"'));
  assert.ok(html.includes('aria-controls="toolsPopover"'));
});

test('chip escapes label, count, and title', () => {
  const html = chip({ label: '<b>x</b>', count: '"1"', title: "<'t'>" });
  assert.ok(!html.includes('<b>x</b>'));
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(html.includes('&quot;1&quot;'));
});

test('chip renders trusted icon html inside aria-hidden slot', () => {
  const html = chip({ label: 'Tools', iconHtml: '<svg viewBox="0 0 16 16"></svg>' });
  assert.ok(html.includes('<span class="inv-chip-icon" aria-hidden="true"><svg viewBox="0 0 16 16"></svg></span>'));
});

test('chip disabled state renders modifier and disabled attribute', () => {
  const html = chip({ label: 'Tools', disabled: true });
  assert.ok(html.includes('inv-chip--disabled'));
  assert.ok(html.includes(' disabled'));
});

test('chip strips unsafe className tokens and ids', () => {
  const html = chip({ label: 'x', className: 'ok " onclick="alert(1)', id: 'bad id!' });
  assert.ok(html.includes('ok'));
  assert.ok(!html.includes('onclick='));
  assert.ok(!html.includes('data-inv-chip'), 'invalid id token dropped');
});

test('chip pressed state renders aria-pressed and the on modifier', () => {
  const on = chip({ id: 'auto', label: 'Auto-run', pressed: true });
  assert.ok(on.includes('aria-pressed="true"'));
  assert.ok(on.includes('inv-chip--on'));

  const off = chip({ id: 'auto', label: 'Auto-run', pressed: false });
  assert.ok(off.includes('aria-pressed="false"'));
  assert.ok(!off.includes('inv-chip--on'));

  const plain = chip({ id: 'auto', label: 'Auto-run' });
  assert.ok(!plain.includes('aria-pressed'), 'non-toggle chips carry no aria-pressed');
});

/* ── Chip imperative helpers ── */

test('chip.setCount updates, creates, and removes the count slot', () => {
  const dom = new JSDOM(`<div id="root">${chip({ id: 'tools', label: 'Tools', count: '4/5' })}</div>`);
  const { document } = dom.window;
  const chipEl = document.querySelector('.inv-chip');

  chip.setCount(chipEl, '2/5');
  assert.equal(chipEl.querySelector('.inv-chip-count').textContent, '2/5');

  chip.setCount(chipEl, '');
  assert.equal(chipEl.querySelector('.inv-chip-count'), null, 'empty count removes slot');

  chip.setCount(chipEl, '5/5');
  assert.equal(chipEl.querySelector('.inv-chip-count').textContent, '5/5', 'slot recreated');
});

test('chip.setPressed syncs aria-pressed and on modifier', () => {
  const dom = new JSDOM(`<div>${chip({ id: 'auto', label: 'Auto-run', pressed: false })}</div>`);
  const chipEl = dom.window.document.querySelector('.inv-chip');

  chip.setPressed(chipEl, true);
  assert.equal(chipEl.getAttribute('aria-pressed'), 'true');
  assert.ok(chipEl.classList.contains('inv-chip--on'));

  chip.setPressed(chipEl, false);
  assert.equal(chipEl.getAttribute('aria-pressed'), 'false');
  assert.ok(!chipEl.classList.contains('inv-chip--on'));
});

test('chip.setExpanded syncs aria-expanded and open modifier', () => {
  const dom = new JSDOM(`<div>${chip({ id: 'tools', label: 'Tools', hasPopup: true })}</div>`);
  const chipEl = dom.window.document.querySelector('.inv-chip');

  chip.setExpanded(chipEl, true);
  assert.equal(chipEl.getAttribute('aria-expanded'), 'true');
  assert.ok(chipEl.classList.contains('inv-chip--open'));

  chip.setExpanded(chipEl, false);
  assert.equal(chipEl.getAttribute('aria-expanded'), 'false');
  assert.ok(!chipEl.classList.contains('inv-chip--open'));
});

/* ── Popover rendering ── */

test('popover renders hidden dialog shell with trusted contents', () => {
  const html = popover({ id: 'tools', domId: 'toolsPopover', ariaLabel: 'Session tools', trustedHtml: '<p>hi</p>' });
  assert.ok(html.includes('class="inv-popover"'));
  assert.ok(html.includes('id="toolsPopover"'));
  assert.ok(html.includes('data-inv-popover="tools"'));
  assert.ok(html.includes('role="dialog"'));
  assert.ok(html.includes('aria-modal="false"'));
  assert.ok(html.includes('aria-label="Session tools"'));
  assert.ok(html.includes(' hidden>'));
  assert.ok(html.includes('<p>hi</p>'));
});

test('popover prefers labelledBy over ariaLabel', () => {
  const html = popover({ labelledBy: 'someTitle', ariaLabel: 'ignored' });
  assert.ok(html.includes('aria-labelledby="someTitle"'));
  assert.ok(!html.includes('aria-label="ignored"'));
});

/* ── Popover open/close behavior ── */

function buildPopoverDom() {
  const markup = '<div id="root">'
    + chip({ id: 'tools', domId: 'toolsChip', label: 'Tools', hasPopup: true, ariaControls: 'toolsPopover' })
    + popover({ id: 'tools', domId: 'toolsPopover', ariaLabel: 'Session tools', trustedHtml: '<button type="button" id="firstAction">A</button>' })
    + '<button type="button" id="outside">outside</button>'
    + '</div>';
  const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, { pretendToBeVisual: true });
  const { document } = dom.window;
  return {
    dom,
    document,
    chipEl: document.getElementById('toolsChip'),
    popEl: document.getElementById('toolsPopover'),
  };
}

test('popover.open reveals dialog, syncs trigger, and focuses first focusable', () => {
  const { document, chipEl, popEl } = buildPopoverDom();

  popover.open(popEl, { trigger: chipEl });
  assert.equal(popEl.hidden, false);
  assert.equal(chipEl.getAttribute('aria-expanded'), 'true');
  assert.ok(chipEl.classList.contains('inv-chip--open'), 'chip open affordance synced');
  assert.equal(document.activeElement.id, 'firstAction', 'focus moved into popover');
});

test('popover.close hides dialog, resets trigger, and can restore focus', () => {
  const { document, chipEl, popEl } = buildPopoverDom();

  popover.open(popEl, { trigger: chipEl });
  popover.close(popEl, { restoreFocus: true });
  assert.equal(popEl.hidden, true);
  assert.equal(chipEl.getAttribute('aria-expanded'), 'false');
  assert.ok(!chipEl.classList.contains('inv-chip--open'));
  assert.equal(document.activeElement.id, 'toolsChip', 'focus restored to trigger');
});

test('popover.toggle flips open state', () => {
  const { chipEl, popEl } = buildPopoverDom();

  popover.toggle(popEl, { trigger: chipEl });
  assert.equal(popover.isOpen(popEl), true);
  popover.toggle(popEl, { trigger: chipEl });
  assert.equal(popover.isOpen(popEl), false);
});

test('popover dispatches inv-popover-toggle on open and close', () => {
  const { document, chipEl, popEl } = buildPopoverDom();
  const events = [];
  document.getElementById('root').addEventListener('inv-popover-toggle', (event) => {
    events.push(event.detail);
  });

  popover.open(popEl, { trigger: chipEl });
  popover.close(popEl);
  assert.deepEqual(events, [
    { id: 'tools', open: true },
    { id: 'tools', open: false },
  ]);
});

test('initPopoverHandlers closes on Escape and restores trigger focus', () => {
  const { dom, document, chipEl, popEl } = buildPopoverDom();
  popover.initPopoverHandlers(document);

  popover.open(popEl, { trigger: chipEl });
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(popEl.hidden, true, 'Escape closes');
  assert.equal(document.activeElement.id, 'toolsChip', 'focus restored');
});

test('initPopoverHandlers closes on outside click but not inside or trigger clicks', () => {
  const { dom, document, chipEl, popEl } = buildPopoverDom();
  popover.initPopoverHandlers(document);

  popover.open(popEl, { trigger: chipEl });
  document.getElementById('firstAction').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(popEl.hidden, false, 'inside click keeps it open');

  chipEl.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(popEl.hidden, false, 'trigger click is the toggler, not click-away');

  document.getElementById('outside').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(popEl.hidden, true, 'outside click closes');
});

test('initPopoverHandlers installs once per root', () => {
  const { document } = buildPopoverDom();
  popover.initPopoverHandlers(document);
  popover.initPopoverHandlers(document);
  assert.equal(document.__invPopoverHandlersInstalled, true);
});

/* ── Barrel wiring ── */

test('inventory barrel exposes actionButton, chip, and popover and installs popover handlers', () => {
  const prevInventory = global.inventory;
  const prevDocument = global.document;
  const prevHandlersInstalled = global.__inventoryHandlersInstalled;
  const prevActionButton = global.inventoryActionButton;
  const prevChip = global.inventoryChip;
  const prevPopover = global.inventoryPopover;

  const dom = new JSDOM('<div></div>', { pretendToBeVisual: true });
  global.document = dom.window.document;
  global.__inventoryHandlersInstalled = false;
  global.inventoryActionButton = require('../renderer/inventory/action-button');
  global.inventoryChip = chip;
  global.inventoryPopover = popover;

  delete require.cache[require.resolve('../renderer/inventory/index')];
  const inventory = require('../renderer/inventory/index');

  assert.equal(typeof inventory.actionButton, 'function', 'actionButton reachable via barrel');
  assert.equal(typeof inventory.chip, 'function', 'chip reachable via barrel');
  assert.equal(typeof inventory.popover, 'function', 'popover reachable via barrel');
  assert.equal(dom.window.document.__invPopoverHandlersInstalled, true, 'popover delegation installed once');

  global.inventory = prevInventory;
  global.document = prevDocument;
  global.__inventoryHandlersInstalled = prevHandlersInstalled;
  global.inventoryActionButton = prevActionButton;
  global.inventoryChip = prevChip;
  global.inventoryPopover = prevPopover;
});
