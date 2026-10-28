'use strict';

/* Shared tab-strip events (IDE tabs overhaul, row 81 slice E): one delegated
 * event layer for the primary strip and every group strip, driven against
 * hand-built contract DOM (no dependency on the markup builder). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeTabsController } = require('../renderer/features/renderer-ide-tabs-controller');

function tabHtml(path, { active = false, surface = false } = {}) {
  if (surface) {
    return `<div class="ide-tab ide-tab--active ide-tab--surface" data-ide-surface-tab="${path}">`
      + `<button class="ide-tab-label" role="tab" aria-selected="true" tabindex="0" data-ide-surface-label="${path}">`
      + `<span class="ide-tab-name">${path}</span></button>`
      + `<span class="ide-tab-slot"><button class="ide-tab-close" data-ide-surface-close="${path}" tabindex="-1">x</button></span></div>`;
  }
  return `<div class="ide-tab${active ? ' ide-tab--active' : ''}" data-ide-tab="${path}" draggable="true">`
    + `<button class="ide-tab-label" role="tab" data-ide-tab-path="${path}" aria-selected="${active}" tabindex="${active ? 0 : -1}">`
    + `<span class="ide-tab-name">${path}</span></button>`
    + `<span class="ide-tab-slot"><button class="ide-tab-close" data-ide-tab-close="${path}" tabindex="-1">x</button></span></div>`;
}

// The contract markup (plan section 4), without the markup builder.
function makeRig({ dir = '', tabs = ['a.js', 'b.js', 'c.js'], active = 'a.js', surface = '' } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="root"${dir ? ` dir="${dir}"` : ''}></div></body>`);
  const document = dom.window.document;
  const rootEl = document.getElementById('root');
  rootEl.innerHTML = '<div class="ide-tabbar"><div class="ide-tabstrip" role="tablist">'
    + tabs.map((path) => tabHtml(path, { active: path === active })).join('')
    + (surface ? tabHtml(surface, { surface: true }) : '')
    + '</div><button class="ide-tabstrip-count" data-ide-tab-overflow hidden>+1</button>'
    + '<div class="ide-editor-actions" role="toolbar"><button class="ide-editor-action" data-ide-editor-action="split-right">s</button>'
    + '<button class="ide-editor-action" data-ide-editor-action="more">m</button></div></div>';
  const tabbar = rootEl.querySelector('.ide-tabbar');
  const strip = rootEl.querySelector('.ide-tabstrip');
  return { dom, win: dom.window, document, rootEl, tabbar, strip };
}

function stubTabRects(strip) {
  [...strip.querySelectorAll('.ide-tab')].forEach((tab, index) => {
    tab.getBoundingClientRect = () => ({ left: index * 100, width: 100, right: index * 100 + 100, top: 0, bottom: 30, height: 30 });
  });
}

function press(rig, element, key) {
  const event = new rig.win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

// ── Primary controller on the shared events (written red against the old handlers) ──

function makeController(rig, extraCallbacks = {}) {
  const menus = [];
  const previous = globalThis.inventoryContextMenu;
  globalThis.inventoryContextMenu = { show: (options) => menus.push(options) };
  const ide = { openTabs: [...rig.strip.querySelectorAll('[data-ide-tab]')].map((el) => ({ path: el.dataset.ideTab, kind: 'file' })), activeTabPath: 'a.js' };
  const log = [];
  const controller = createIdeTabsController({
    getDom: () => ({ ideTabStrip: rig.strip, ideView: rig.rootEl }),
    getIde: () => ide,
    callbacks: {
      activateTab: (path) => log.push(['activate', path]),
      closeTab: (path) => log.push(['close', path]),
      renderTabs: () => log.push(['render']),
      ...extraCallbacks,
    },
  });
  controller.bindEvents();
  const restore = () => {
    controller.dispose();
    if (previous === undefined) delete globalThis.inventoryContextMenu;
    else globalThis.inventoryContextMenu = previous;
  };
  return { controller, menus, log, ide, restore };
}

test('primary strip: a keyboard context menu anchors at the tab, a pointer one at the pointer', (t) => {
  const rig = makeRig();
  const { menus, restore } = makeController(rig);
  t.after(restore);
  const label = rig.strip.querySelector('[data-ide-tab-path="b.js"]');
  label.dispatchEvent(new rig.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 12 }));
  label.dispatchEvent(new rig.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
  assert.equal(menus[0].anchorX, 40);
  assert.equal(menus[0].anchorY, 12);
  assert.equal(menus[1].anchorEl, rig.strip.querySelector('[data-ide-tab="b.js"]'));
  assert.equal(menus[1].anchorX, undefined, 'no 0,0 pointer anchor for the keyboard menu');
});

test('primary strip: arrow keys mirror inside a dir=rtl ancestor', (t) => {
  const rig = makeRig({ dir: 'rtl' });
  const { restore } = makeController(rig);
  t.after(restore);
  const labels = [...rig.strip.querySelectorAll('.ide-tab-label')];
  labels[0].focus();
  press(rig, labels[0], 'ArrowLeft');
  assert.equal(rig.document.activeElement, labels[1], 'ArrowLeft moves to the next tab in RTL');
  press(rig, labels[1], 'ArrowRight');
  assert.equal(rig.document.activeElement, labels[0]);
});

test('primary controller: reorderTabToIndex clamps into the tab pinned or unpinned partition', (t) => {
  const rig = makeRig({ tabs: ['p1.js', 'p2.js', 'a.js', 'b.js', 'c.js'] });
  const { controller, ide, log, restore } = makeController(rig);
  t.after(restore);
  ide.openTabs = [
    { path: 'p1.js', kind: 'file', pinned: true },
    { path: 'p2.js', kind: 'file', pinned: true },
    { path: 'a.js', kind: 'file' },
    { path: 'g.js', kind: 'file', group: 'editor-2' },
    { path: 'b.js', kind: 'file' },
    { path: 'c.js', kind: 'file' },
  ];
  const order = () => ide.openTabs.map((tab) => tab.path);
  // An unpinned tab dropped at index 0 stops at the first unpinned slot.
  assert.equal(controller.reorderTabToIndex('c.js', 0), true);
  assert.deepEqual(order(), ['p1.js', 'p2.js', 'c.js', 'a.js', 'g.js', 'b.js']);
  // A pinned tab dropped past the end stays inside the pinned block.
  assert.equal(controller.reorderTabToIndex('p1.js', 99), true);
  assert.deepEqual(order(), ['p2.js', 'p1.js', 'c.js', 'a.js', 'g.js', 'b.js']);
  // The index excludes the moved tab: a.js dropped past the end is the last primary slot.
  assert.equal(controller.reorderTabToIndex('a.js', 99), true);
  assert.deepEqual(order(), ['p2.js', 'p1.js', 'c.js', 'g.js', 'b.js', 'a.js']);
  // A drop that changes nothing neither renders nor persists; unknown and group tabs are refused.
  log.length = 0;
  assert.equal(controller.reorderTabToIndex('a.js', 99), false);
  assert.equal(controller.reorderTabToIndex('nope.js', 0), false);
  assert.equal(controller.reorderTabToIndex('g.js', 0), false);
  assert.deepEqual(log, []);
  assert.equal(controller.reorderTabToIndex('b.js', 2), true);
  assert.deepEqual(log, [['render']]);
});

test('primary controller: the own strip reorders on drop, a foreign tab goes to onDropTab, a surface x closes its surface', (t) => {
  const rig = makeRig({ surface: 'preview' });
  const dropped = [];
  const surfaces = [];
  const { ide, restore } = makeController(rig, { onDropTab: (payload, index) => dropped.push([payload, index]), onCloseSurface: (surface) => surfaces.push(surface) });
  t.after(restore);
  rig.strip.querySelector('[data-ide-surface-close="preview"]').click();
  assert.deepEqual(surfaces, ['preview']);
  stubTabRects(rig.strip);
  const dataTransfer = (store) => ({ types: Object.keys(store), setData: (k, v) => { store[k] = v; }, getData: (k) => store[k] || '' });
  const start = new rig.win.Event('dragstart', { bubbles: true });
  const store = {};
  start.dataTransfer = dataTransfer(store);
  rig.strip.querySelector('[data-ide-tab="a.js"]').dispatchEvent(start);
  const own = new rig.win.Event('drop', { bubbles: true, cancelable: true });
  own.clientX = 210;
  own.dataTransfer = dataTransfer(store);
  rig.strip.dispatchEvent(own);
  assert.deepEqual(ide.openTabs.map((tab) => tab.path), ['b.js', 'a.js', 'c.js']);
  assert.deepEqual(dropped, []);

  const foreign = new rig.win.Event('drop', { bubbles: true, cancelable: true });
  foreign.clientX = 5;
  foreign.dataTransfer = dataTransfer({ 'application/x-jenny-editor-tab': JSON.stringify({ path: 'x.js', fromGroup: 'editor-2' }) });
  rig.strip.dispatchEvent(foreign);
  assert.deepEqual(dropped, [[{ path: 'x.js', fromGroup: 'editor-2' }, 0]]);
});

test('primary controller: double-click keeps a preview tab open, otherwise toggles the pin', (t) => {
  const rig = makeRig();
  const { ide, log, restore } = makeController(rig);
  t.after(restore);
  ide.openTabs = [
    { path: 'a.js', kind: 'file', transientPreview: true },
    { path: 'b.js', kind: 'file' },
    { path: 'c.js', kind: 'file' },
  ];
  const dbl = (path) => rig.strip.querySelector(`[data-ide-tab-path="${path}"]`).dispatchEvent(new rig.win.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  dbl('a.js');
  assert.equal(ide.openTabs[0].transientPreview, undefined);
  assert.notEqual(ide.openTabs[0].pinned, true, 'keep open does not pin');
  dbl('a.js');
  assert.equal(ide.openTabs[0].pinned, true, 'a second double-click pins it');
  dbl('c.js');
  assert.deepEqual(ide.openTabs.map((tab) => tab.path), ['a.js', 'c.js', 'b.js'], 'pinned tabs sort first');
  assert.equal(log.filter((entry) => entry[0] === 'render').length, 3);
});

test('primary controller: the open-tabs list anchors on the trigger and lists tabs, bulk closes and reopen', (t) => {
  const rig = makeRig();
  const calls = [];
  const { menus, ide, restore } = makeController(rig, {
    isDirty: (path) => path === 'b.js',
    closeSaved: () => calls.push('saved'),
    closeAll: () => calls.push('all'),
    reopenClosedTab: () => calls.push('reopen'),
    activateTab: (path) => calls.push(`activate:${path}`),
  });
  t.after(restore);
  ide.openTabs = [{ path: 'src/a.js', kind: 'file' }, { path: 'b.js', kind: 'file' }, { path: 'diff://x', kind: 'diff', label: 'Diff x' }];
  ide.activeTabPath = 'b.js';
  const chip = rig.tabbar.querySelector('[data-ide-tab-overflow]');
  chip.click();
  assert.equal(menus.length, 1);
  assert.equal(menus[0].anchorEl, chip);
  assert.deepEqual(menus[0].items.map((item) => item.label || '-'), ['a.js', 'b.js', 'Diff x', '-', 'Close Saved', 'Close All', 'Reopen Closed Tab']);
  assert.equal(menus[0].items[0].description, 'src');
  assert.equal(menus[0].items[1].checked, true);
  assert.equal(menus[0].items[1].shortcutHint, '●');
  [0, 4, 5, 6].forEach((at) => menus[0].items[at].action());
  assert.deepEqual(calls, ['activate:src/a.js', 'saved', 'all', 'reopen']);
});

test('primary controller: the tab menu offers Keep Open and Close to the Right, disabled at the end', (t) => {
  const rig = makeRig();
  const closed = [];
  const { menus, ide, restore } = makeController(rig, { closeToRight: (path) => closed.push(path) });
  t.after(restore);
  ide.openTabs = [{ path: 'a.js', kind: 'file', transientPreview: true }, { path: 'b.js', kind: 'file' }, { path: 'c.js', kind: 'file' }];
  const open = (path) => rig.strip.querySelector(`[data-ide-tab-path="${path}"]`)
    .dispatchEvent(new rig.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 3, clientY: 4 }));
  open('a.js');
  const first = menus.at(-1).items;
  assert.equal(first[0].label, 'Keep Open');
  const toRight = first.find((item) => item.label === 'Close to the Right');
  assert.equal(toRight.disabled, false);
  assert.ok(first.findIndex((item) => item.label === 'Close Others') < first.indexOf(toRight));
  assert.ok(first.indexOf(toRight) < first.findIndex((item) => item.label === 'Close Saved'));
  toRight.action();
  assert.deepEqual(closed, ['a.js']);
  first[0].action();
  assert.equal(ide.openTabs[0].transientPreview, undefined);
  open('c.js');
  const last = menus.at(-1).items;
  assert.equal(last.find((item) => item.label === 'Close to the Right').disabled, true);
  assert.equal(last.some((item) => item.label === 'Keep Open'), false);
  assert.equal(last.some((item) => /Split/.test(item.label || '')), false, 'no separate Split Right item');
});

// ── The shared events module itself ──

const { createIdeTabStripEvents, buildOpenTabsMenuItems } = require('../renderer/features/renderer-ide-tab-strip-events');
const TAB_MIME = 'application/x-jenny-editor-tab';

function bindEvents(rig, extra = {}, groupId = '') {
  const log = [];
  const record = (name) => (...args) => log.push([name, ...args]);
  const events = createIdeTabStripEvents({
    root: rig.tabbar,
    getStrip: () => rig.strip,
    groupId,
    callbacks: {
      onActivate: record('activate'),
      onClose: record('close'),
      onCloseSurface: record('closeSurface'),
      onDoubleClick: record('dblclick'),
      onContextMenu: record('menu'),
      onOverflow: record('overflow'),
      onDropTab: record('drop'),
      ...extra,
    },
  });
  return { events, log };
}

function dragEvent(win, type, { types = [TAB_MIME], data = {}, clientX = 0 } = {}) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  const store = { ...data };
  event.clientX = clientX;
  event.dataTransfer = {
    types,
    effectAllowed: '',
    dropEffect: '',
    setData(mime, value) { store[mime] = value; },
    getData(mime) { return store[mime] || ''; },
    store,
  };
  return event;
}

test('click routes the overflow chip, surface close, tab close and activation; editor actions only when handled', () => {
  const rig = makeRig({ surface: 'preview' });
  const { events, log } = bindEvents(rig);
  rig.tabbar.querySelector('[data-ide-tab-overflow]').click();
  rig.strip.querySelector('[data-ide-surface-close]').click();
  rig.strip.querySelector('[data-ide-tab-close="b.js"]').click();
  rig.strip.querySelector('[data-ide-tab-path="c.js"]').click();
  rig.strip.querySelector('[data-ide-surface-label]').click();
  rig.tabbar.querySelector('[data-ide-editor-action="more"]').click();
  assert.deepEqual(log.map((entry) => entry.slice(0, 2).map((v) => (typeof v === 'string' ? v : 'el'))), [
    ['overflow', 'el'], ['closeSurface', 'preview'], ['close', 'b.js'], ['activate', 'c.js'],
  ]);
  events.dispose();
  const handled = [];
  const second = bindEvents(rig, { onEditorAction: (action, el) => handled.push([action, el.getAttribute('data-ide-editor-action')]) });
  rig.tabbar.querySelector('[data-ide-editor-action="split-right"]').click();
  assert.deepEqual(handled, [['split-right', 'split-right']]);
  second.events.dispose();
});

test('middle-click closes a tab (a surface tab closes its surface); other buttons do nothing', () => {
  const rig = makeRig({ surface: 'file_map' });
  const { log } = bindEvents(rig);
  const aux = (el, button) => {
    const event = new rig.win.MouseEvent('auxclick', { button, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
  };
  assert.equal(aux(rig.strip.querySelector('[data-ide-tab-path="b.js"]'), 1).defaultPrevented, true);
  aux(rig.strip.querySelector('[data-ide-tab-path="c.js"]'), 2);
  aux(rig.strip.querySelector('[data-ide-surface-label]'), 1);
  assert.deepEqual(log, [['close', 'b.js'], ['closeSurface', 'file_map']]);
});

test('double-click reports the tab path, never from the close button', () => {
  const rig = makeRig();
  const { log } = bindEvents(rig);
  const dbl = (el) => el.dispatchEvent(new rig.win.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  dbl(rig.strip.querySelector('[data-ide-tab-close="b.js"]'));
  dbl(rig.strip.querySelector('[data-ide-tab-path="b.js"]'));
  dbl(rig.strip.querySelector('.ide-tab-name'));
  assert.deepEqual(log, [['dblclick', 'b.js'], ['dblclick', 'a.js']]);
});

test('context menu: keyboard invocation anchors at the tab, pointer at the pointer, surface tabs have none', () => {
  const rig = makeRig({ surface: 'preview' });
  const { log } = bindEvents(rig);
  const label = rig.strip.querySelector('[data-ide-tab-path="b.js"]');
  const pointer = new rig.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 12 });
  label.dispatchEvent(pointer);
  const keyboard = new rig.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
  label.dispatchEvent(keyboard);
  const surface = new rig.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
  rig.strip.querySelector('[data-ide-surface-label]').dispatchEvent(surface);
  assert.equal(pointer.defaultPrevented && keyboard.defaultPrevented, true);
  assert.equal(surface.defaultPrevented, false);
  assert.deepEqual(log[0], ['menu', 'b.js', { anchorX: 40, anchorY: 12 }]);
  assert.equal(log[1][2].anchorEl, label.closest('.ide-tab'));
  assert.equal(log.length, 2);
});

test('arrow keys, Home and End rove over every role=tab label with wrap', () => {
  const rig = makeRig({ surface: 'preview' });
  bindEvents(rig);
  const labels = [...rig.strip.querySelectorAll('[role="tab"]')];
  assert.equal(labels.length, 4, 'the surface tab is part of the roving set');
  labels[0].focus();
  assert.equal(press(rig, labels[0], 'ArrowRight').defaultPrevented, true);
  assert.equal(rig.document.activeElement, labels[1]);
  press(rig, labels[1], 'End');
  assert.equal(rig.document.activeElement, labels[3]);
  press(rig, labels[3], 'ArrowRight');
  assert.equal(rig.document.activeElement, labels[0], 'wraps forward');
  press(rig, labels[0], 'ArrowLeft');
  assert.equal(rig.document.activeElement, labels[3], 'wraps backward');
  press(rig, labels[3], 'Home');
  assert.equal(rig.document.activeElement, labels[0]);
  assert.equal(press(rig, labels[0], 'a').defaultPrevented, false);
});

test('RTL mirrors the arrow keys', () => {
  const rig = makeRig({ dir: 'rtl' });
  bindEvents(rig);
  const labels = [...rig.strip.querySelectorAll('[role="tab"]')];
  labels[0].focus();
  press(rig, labels[0], 'ArrowLeft');
  assert.equal(rig.document.activeElement, labels[1]);
  press(rig, labels[1], 'ArrowRight');
  assert.equal(rig.document.activeElement, labels[0]);
});

function overflowing(strip, { scrollWidth = 600, clientWidth = 200 } = {}) {
  Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(strip, 'clientWidth', { configurable: true, value: clientWidth });
}

function wheel(rig, init) {
  const event = new rig.win.Event('wheel', { bubbles: true, cancelable: true });
  Object.assign(event, { deltaX: 0, deltaY: 0, deltaMode: 0 }, init);
  rig.strip.querySelector('[data-ide-tab-path="a.js"]').dispatchEvent(event);
  return event;
}

test('a vertical wheel over an overflowing strip scrolls it sideways and claims the gesture', () => {
  const rig = makeRig();
  bindEvents(rig);
  overflowing(rig.strip);
  rig.strip.scrollLeft = 10;
  assert.equal(wheel(rig, { deltaY: 40 }).defaultPrevented, true);
  assert.equal(rig.strip.scrollLeft, 50);
  assert.equal(wheel(rig, { deltaY: 3, deltaMode: 1 }).defaultPrevented, true);
  assert.equal(rig.strip.scrollLeft, 98, 'line-mode deltas scale up');
  assert.equal(wheel(rig, { deltaY: 4, deltaX: 30 }).defaultPrevented, false, 'a horizontal-dominant wheel is left alone');
});

test('the wheel is left alone without overflow, and the sign flips in RTL', () => {
  const rig = makeRig();
  bindEvents(rig);
  overflowing(rig.strip, { scrollWidth: 100, clientWidth: 200 });
  assert.equal(wheel(rig, { deltaY: 40 }).defaultPrevented, false);
  const rtl = makeRig({ dir: 'rtl' });
  bindEvents(rtl);
  overflowing(rtl.strip);
  rtl.strip.scrollLeft = -10;
  wheel(rtl, { deltaY: 40 });
  assert.equal(rtl.strip.scrollLeft, -50);
});

test('scroll and resize bursts recount the overflow once per frame, and dispose stops them', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { pretendToBeVisual: true });
  const observed = [];
  let observerCallback = null;
  let disconnected = 0;
  dom.window.ResizeObserver = class {
    constructor(callback) { observerCallback = callback; }
    observe(el) { observed.push(el); }
    disconnect() { disconnected += 1; }
  };
  const root = dom.window.document.getElementById('root');
  root.innerHTML = '<div class="ide-tabbar"><div class="ide-tabstrip" role="tablist"></div></div>';
  const rig = { win: dom.window, tabbar: root.firstChild, strip: root.querySelector('.ide-tabstrip') };
  const previous = globalThis.rendererIdeTabs;
  const synced = [];
  globalThis.rendererIdeTabs = { ...require('../renderer/features/renderer-ide-tabs'), syncTabOverflow: (strip) => synced.push(strip) };
  try {
    const { events } = bindEvents(rig);
    assert.deepEqual(observed, [rig.strip]);
    const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(resolve));
    rig.strip.dispatchEvent(new dom.window.Event('scroll'));
    rig.strip.dispatchEvent(new dom.window.Event('scroll'));
    observerCallback();
    await frame();
    assert.equal(synced.length, 1, 'three triggers, one recount');
    assert.equal(synced[0], rig.strip);
    rig.strip.dispatchEvent(new dom.window.Event('scroll'));
    events.dispose();
    await frame();
    assert.equal(synced.length, 1, 'a pending recount is cancelled by dispose');
    assert.equal(disconnected, 1);
    rig.strip.dispatchEvent(new dom.window.Event('scroll'));
    await frame();
    assert.equal(synced.length, 1, 'the scroll listener is gone');
  } finally {
    if (previous === undefined) delete globalThis.rendererIdeTabs;
    else globalThis.rendererIdeTabs = previous;
  }
});

test('dragstart writes the payload with this strip group, marks the tab, and the tab own dragend clears the drag', () => {
  const rig = makeRig();
  const { events } = bindEvents(rig, {}, 'editor-2');
  const tab = rig.strip.querySelector('[data-ide-tab="b.js"]');
  const start = dragEvent(rig.win, 'dragstart', { types: [] });
  tab.dispatchEvent(start);
  assert.deepEqual(JSON.parse(start.dataTransfer.store[TAB_MIME]), { path: 'b.js', fromGroup: 'editor-2' });
  assert.equal(start.dataTransfer.store['text/plain'], 'b.js');
  assert.equal(start.dataTransfer.effectAllowed, 'move');
  assert.equal(tab.classList.contains('ide-tab--dragging'), true);
  assert.equal(events.isDragging(), true);
  // The tab leaves the document (re-rendered into another group): its dragend never bubbles.
  tab.remove();
  tab.dispatchEvent(new rig.win.Event('dragend'));
  assert.equal(events.isDragging(), false, 'the listener on the tab itself ended the drag');
});

test('the drop caret sits before the tab at the drop index, moves with the pointer and leaves with the drag', () => {
  const rig = makeRig();
  const { events } = bindEvents(rig);
  stubTabRects(rig.strip);
  const caret = () => rig.strip.querySelector('.ide-tab-drop-caret');
  const nextOf = () => caret()?.nextElementSibling?.getAttribute('data-ide-tab') ?? null;
  const dragged = rig.strip.querySelector('[data-ide-tab="a.js"]');
  dragged.dispatchEvent(dragEvent(rig.win, 'dragstart', { types: [] }));
  assert.equal(events.isDragging(), true);
  const over = dragEvent(rig.win, 'dragover', { clientX: 260 });
  rig.strip.querySelector('[data-ide-tab="c.js"]').dispatchEvent(over);
  assert.equal(over.defaultPrevented, true);
  assert.equal(rig.strip.querySelectorAll('.ide-tab-drop-caret').length, 1);
  assert.equal(nextOf(), null, 'past the last tab: the caret closes the strip');
  assert.equal(caret().previousElementSibling.getAttribute('data-ide-tab'), 'c.js');
  rig.strip.dispatchEvent(dragEvent(rig.win, 'dragover', { clientX: 210 }));
  assert.equal(nextOf(), 'c.js', 'own tab skipped: b.js midpoint passed, c.js not');
  assert.equal(rig.strip.querySelectorAll('.ide-tab-drop-caret').length, 1, 'one caret, moved');
  assert.equal(rig.strip.getAttribute('data-ide-drop'), null, 'an own drag shows the caret, not the strip mark');
  rig.strip.dispatchEvent(dragEvent(rig.win, 'dragover', { clientX: 5 }));
  assert.equal(nextOf(), 'b.js', 'the first slot is before b.js once a.js is skipped');
  rig.strip.dispatchEvent(dragEvent(rig.win, 'dragend'));
  assert.equal(caret(), null);
  assert.equal(dragged.classList.contains('ide-tab--dragging'), false);
  assert.equal(events.isDragging(), false);
});

test('a foreign tab arms the strip drop mark; leaving or dropping clears the mark and the caret', () => {
  const rig = makeRig();
  const { log } = bindEvents(rig, {}, 'editor-2');
  stubTabRects(rig.strip);
  rig.strip.dispatchEvent(dragEvent(rig.win, 'dragover', { clientX: 120 }));
  assert.equal(rig.strip.getAttribute('data-ide-drop'), 'tabs');
  assert.equal(rig.strip.querySelectorAll('.ide-tab-drop-caret').length, 1);
  rig.strip.dispatchEvent(dragEvent(rig.win, 'dragleave'));
  assert.equal(rig.strip.getAttribute('data-ide-drop'), null);
  assert.equal(rig.strip.querySelector('.ide-tab-drop-caret'), null);
  const files = dragEvent(rig.win, 'dragover', { types: ['Files'] });
  rig.strip.dispatchEvent(files);
  assert.equal(files.defaultPrevented, false, 'OS file drags are not tab drags');
  rig.strip.dispatchEvent(dragEvent(rig.win, 'dragover', { clientX: 120 }));
  const drop = dragEvent(rig.win, 'drop', { clientX: 120, data: { [TAB_MIME]: JSON.stringify({ path: 'x.js', fromGroup: 'editor-3' }) } });
  rig.strip.dispatchEvent(drop);
  assert.equal(drop.defaultPrevented, true);
  assert.deepEqual(log, [['drop', { path: 'x.js', fromGroup: 'editor-3' }, 1]]);
  const plain = dragEvent(rig.win, 'drop', { types: ['Files'] });
  rig.strip.dispatchEvent(plain);
  assert.equal(plain.defaultPrevented, false, 'a drop without a tab payload or local drag is ignored');
  assert.equal(log.length, 1);
  assert.equal(rig.strip.getAttribute('data-ide-drop'), null);
  assert.equal(rig.strip.querySelector('.ide-tab-drop-caret'), null);
});

test('the drop index excludes the own dragged tab only for a drop from this strip, mirrored in RTL', () => {
  const rig = makeRig();
  const { log } = bindEvents(rig, {}, 'editor-2');
  stubTabRects(rig.strip);
  const drop = (path, fromGroup, clientX) => rig.strip.dispatchEvent(dragEvent(rig.win, 'drop', { clientX, data: { [TAB_MIME]: JSON.stringify({ path, fromGroup }) } }));
  drop('a.js', 'editor-2', 210); // a.js (own) between b and c: final place 1
  drop('a.js', 'editor-3', 210); // the same path from elsewhere counts every tab: 2
  drop('a.js', 'editor-2', 60);
  assert.deepEqual(log.map((entry) => entry[2]), [1, 2, 0]);
  const rtl = makeRig({ dir: 'rtl' });
  const second = bindEvents(rtl);
  stubTabRects(rtl.strip);
  rtl.strip.dispatchEvent(dragEvent(rtl.win, 'drop', { clientX: 120, data: { [TAB_MIME]: JSON.stringify({ path: 'x.js', fromGroup: 'editor-2' }) } }));
  assert.deepEqual(second.log.map((entry) => entry[2]), [2]);
});

test('drags outside the tabbar are left to the owner (the group stage)', () => {
  const dom = new JSDOM('<!doctype html><body><section id="g"><div class="ide-tabbar"><div class="ide-tabstrip" role="tablist"></div></div><div id="stage"></div></section></body>');
  const section = dom.window.document.getElementById('g');
  const strip = section.querySelector('.ide-tabstrip');
  strip.setAttribute('data-ide-drop', 'tabs');
  const log = [];
  createIdeTabStripEvents({ root: section, getStrip: () => strip, groupId: 'editor-2', callbacks: { onDropTab: (...args) => log.push(args) } });
  const stage = dom.window.document.getElementById('stage');
  const over = dragEvent(dom.window, 'dragover');
  stage.dispatchEvent(over);
  assert.equal(over.defaultPrevented, false);
  assert.equal(strip.getAttribute('data-ide-drop'), null, 'the strip mark stands down over the stage');
  stage.dispatchEvent(dragEvent(dom.window, 'drop', { data: { [TAB_MIME]: JSON.stringify({ path: 'x.js', fromGroup: '' }) } }));
  assert.deepEqual(log, []);
});

test('dispose removes every listener', () => {
  const rig = makeRig();
  const added = [];
  const removed = [];
  const rawAdd = rig.tabbar.addEventListener.bind(rig.tabbar);
  const rawRemove = rig.tabbar.removeEventListener.bind(rig.tabbar);
  rig.tabbar.addEventListener = (type, handler, options) => { added.push([type, handler]); return rawAdd(type, handler, options); };
  rig.tabbar.removeEventListener = (type, handler, options) => { removed.push([type, handler]); return rawRemove(type, handler, options); };
  const { events, log } = bindEvents(rig);
  assert.ok(added.length >= 10, 'click, auxclick, dblclick, contextmenu, keydown and drag x5 (the wheel binds on the strip)');
  events.dispose();
  for (const [type, handler] of added) assert.ok(removed.some(([t, h]) => t === type && h === handler), type);
  rig.strip.querySelector('[data-ide-tab-path="b.js"]').click();
  rig.strip.querySelector('[data-ide-tab-path="b.js"]').dispatchEvent(new rig.win.MouseEvent('dblclick', { bubbles: true }));
  assert.deepEqual(log, []);
  events.dispose(); // idempotent
});

test('buildOpenTabsMenuItems: one row per tab, then the bulk closes and reopen', () => {
  const calls = [];
  const items = buildOpenTabsMenuItems({
    tabs: [{ path: 'src/a.js' }, { path: 'b.js' }],
    activePath: 'b.js',
    isDirty: (path) => path === 'src/a.js',
    displayName: (tab) => tab.path.split('/').pop(),
    folderOf: (tab) => tab.path.split('/').slice(0, -1).join('/'),
    onActivate: (path) => calls.push(['activate', path]),
    onCloseSaved: () => calls.push(['saved']),
    onCloseAll: () => calls.push(['all']),
    onReopenClosed: () => calls.push(['reopen']),
  });
  assert.deepEqual(items.map((item) => item.label || '-'), ['a.js', 'b.js', '-', 'Close Saved', 'Close All', 'Reopen Closed Tab']);
  assert.equal(items[0].description, 'src');
  assert.equal(items[0].shortcutHint, '●');
  assert.equal(items[0].checked, false);
  assert.equal('description' in items[1], false, 'no folder, no description');
  assert.equal('shortcutHint' in items[1], false, 'clean tabs carry no dot');
  assert.equal(items[1].checked, true);
  assert.equal(items[2].separator, true);
  assert.equal(items[5].shortcutHint, 'Ctrl+Shift+T');
  items[0].action();
  items[3].action();
  items[4].action();
  items[5].action();
  assert.deepEqual(calls, [['activate', 'src/a.js'], ['saved'], ['all'], ['reopen']]);
  const bare = buildOpenTabsMenuItems({ tabs: [{ path: 'x.js' }] });
  assert.deepEqual(bare.map((item) => item.label || '-'), ['x.js', '-', 'Close Saved', 'Close All'], 'no reopen row without the callback');
  assert.deepEqual(buildOpenTabsMenuItems({ tabs: [] }), []);
});
