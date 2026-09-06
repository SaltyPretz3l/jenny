const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createTabDragController } = require('../renderer/shell/renderer-workspace-tab-drag-utils');

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="container"></div></body></html>', {
    pretendToBeVisual: true,
  });
  global.window = dom.window;
  global.document = dom.window.document;
  return dom;
}

function buildRail(doc) {
  const rail = doc.createElement('div');
  rail.className = 'workspace-rail';
  // Stub pointer capture methods (JSDOM does not implement them)
  rail.setPointerCapture = () => {};
  rail.releasePointerCapture = () => {};
  doc.getElementById('container').appendChild(rail);

  const tabRefs = new Map();
  function addTab(id, title) {
    const tab = doc.createElement('div');
    tab.className = 'workspace-rail-tab';
    tab.dataset.sessionId = id;
    const btn = doc.createElement('button');
    btn.className = 'workspace-rail-tab-button';
    btn.dataset.workspaceActivate = id;
    const titleSpan = doc.createElement('span');
    titleSpan.className = 'workspace-rail-title';
    titleSpan.textContent = title;
    btn.appendChild(titleSpan);
    tab.appendChild(btn);
    rail.appendChild(tab);
    tabRefs.set(id, { el: tab, titleBtn: btn, titleSpan });
  }
  return { rail, tabRefs, addTab };
}

function pointerDown(el, opts) {
  el.dispatchEvent(new global.window.PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: 10, bubbles: true, ...opts }));
}
function pointerMove(el, opts) {
  el.dispatchEvent(new global.window.PointerEvent('pointermove', { pointerId: 1, clientX: 50, clientY: 10, bubbles: true, ...opts }));
}
function pointerUp(el, opts) {
  el.dispatchEvent(new global.window.PointerEvent('pointerup', { pointerId: 1, clientX: 50, clientY: 10, bubbles: true, ...opts }));
}
function pointerCancel(el, opts) {
  el.dispatchEvent(new global.window.PointerEvent('pointercancel', { pointerId: 1, bubbles: true, ...opts }));
}

test('drag past threshold calls onDragStart and onReorder', async (t) => {
  const dom = setupDom();
  t.after(async () => { delete global.window; delete global.document; await dom.window.close(); });
  const doc = dom.window.document;
  const { rail, tabRefs, addTab } = buildRail(doc);
  addTab('s1', 'Alpha');
  addTab('s2', 'Beta');

  const starts = [], reorders = [];
  const ctrl = createTabDragController({
    railEl: rail, tabRefs,
    onDragStart() { starts.push(1); },
    onReorder(id, idx) { reorders.push({ id, idx }); },
  });
  t.after(() => ctrl.dispose());

  const btn = doc.querySelector('[data-workspace-activate="s1"]');
  pointerDown(btn, { clientX: 10, clientY: 10 });
  pointerMove(rail, { clientX: 80, clientY: 10 }); // past threshold
  pointerUp(rail, { clientX: 80, clientY: 10 });
  await Promise.resolve();

  assert.equal(starts.length, 1, 'onDragStart called');
  assert.equal(reorders.length, 1, 'onReorder called');
});

test('drag below threshold does not commit', (t) => {
  const dom = setupDom();
  t.after(async () => { delete global.window; delete global.document; await dom.window.close(); });
  const doc = dom.window.document;
  const { rail, tabRefs, addTab } = buildRail(doc);
  addTab('s1', 'Alpha');

  const reorders = [];
  const ctrl = createTabDragController({
    railEl: rail, tabRefs,
    onDragStart() {},
    onReorder(id, idx) { reorders.push({ id, idx }); },
  });
  t.after(() => ctrl.dispose());

  const btn = doc.querySelector('[data-workspace-activate="s1"]');
  pointerDown(btn, { clientX: 10, clientY: 10 });
  pointerMove(rail, { clientX: 12, clientY: 10 }); // below threshold
  pointerUp(rail, { clientX: 12, clientY: 10 });

  assert.deepEqual(reorders, [], 'onReorder should not fire below threshold');
  assert.equal(doc.querySelector('.workspace-tab-drag-ghost'), null, 'no ghost created');
});

test('dragging class applied and removed', (t) => {
  const dom = setupDom();
  t.after(async () => { delete global.window; delete global.document; await dom.window.close(); });
  const doc = dom.window.document;
  const { rail, tabRefs, addTab } = buildRail(doc);
  addTab('s1', 'Alpha');
  addTab('s2', 'Beta');

  const ctrl = createTabDragController({
    railEl: rail, tabRefs,
    onDragStart() {},
    onReorder() {},
  });
  t.after(() => ctrl.dispose());

  const btn = doc.querySelector('[data-workspace-activate="s1"]');
  const tab = doc.querySelector('[data-session-id="s1"]');
  pointerDown(btn, { clientX: 10, clientY: 10 });
  pointerMove(rail, { clientX: 80, clientY: 10 });
  assert.ok(tab.classList.contains('dragging'), 'dragging class applied');
  assert.ok(doc.querySelector('.workspace-tab-drag-ghost'), 'ghost created');

  pointerUp(rail, { clientX: 80, clientY: 10 });
  assert.ok(!tab.classList.contains('dragging'), 'dragging class removed');
  assert.equal(doc.querySelector('.workspace-tab-drag-ghost'), null, 'ghost removed');
});

test('pointercancel aborts without reorder', (t) => {
  const dom = setupDom();
  t.after(async () => { delete global.window; delete global.document; await dom.window.close(); });
  const doc = dom.window.document;
  const { rail, tabRefs, addTab } = buildRail(doc);
  addTab('s1', 'Alpha');
  addTab('s2', 'Beta');

  const reorders = [];
  const ctrl = createTabDragController({
    railEl: rail, tabRefs,
    onDragStart() {},
    onReorder(id, idx) { reorders.push({ id, idx }); },
  });
  t.after(() => ctrl.dispose());

  const btn = doc.querySelector('[data-workspace-activate="s1"]');
  pointerDown(btn, { clientX: 10, clientY: 10 });
  pointerMove(rail, { clientX: 80, clientY: 10 });
  pointerCancel(rail);

  assert.deepEqual(reorders, [], 'no reorder on cancel');
  assert.equal(doc.querySelector('.workspace-tab-drag-ghost'), null, 'ghost cleaned up');
});

test('Escape during drag cancels', (t) => {
  const dom = setupDom();
  t.after(async () => { delete global.window; delete global.document; await dom.window.close(); });
  const doc = dom.window.document;
  const { rail, tabRefs, addTab } = buildRail(doc);
  addTab('s1', 'Alpha');
  addTab('s2', 'Beta');

  const reorders = [];
  const ctrl = createTabDragController({
    railEl: rail, tabRefs,
    onDragStart() {},
    onReorder(id, idx) { reorders.push({ id, idx }); },
  });
  t.after(() => ctrl.dispose());

  const btn = doc.querySelector('[data-workspace-activate="s1"]');
  pointerDown(btn, { clientX: 10, clientY: 10 });
  pointerMove(rail, { clientX: 80, clientY: 10 });
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  assert.deepEqual(reorders, [], 'no reorder on Escape');
  assert.equal(doc.querySelector('.workspace-tab-drag-ghost'), null, 'ghost cleaned up');
  assert.equal(ctrl.shouldSuppressClick(), true, 'the click following a committed drag cancellation is suppressed');
  assert.equal(ctrl.shouldSuppressClick(), false, 'Escape arms only one-shot suppression');
});

test('dispose is idempotent', (t) => {
  const dom = setupDom();
  t.after(async () => { delete global.window; delete global.document; await dom.window.close(); });
  const doc = dom.window.document;
  const { rail, tabRefs, addTab } = buildRail(doc);
  addTab('s1', 'Alpha');

  const ctrl = createTabDragController({
    railEl: rail, tabRefs,
    onDragStart() {},
    onReorder() {},
  });
  ctrl.dispose();
  ctrl.dispose(); // second dispose should not throw
  assert.equal(ctrl.shouldSuppressClick(), false, 'shouldSuppressClick returns false after double dispose');
});

test('shouldSuppressClick returns true once after committed drag', (t) => {
  const dom = setupDom();
  t.after(async () => { delete global.window; delete global.document; await dom.window.close(); });
  const doc = dom.window.document;
  const { rail, tabRefs, addTab } = buildRail(doc);
  addTab('s1', 'Alpha');
  addTab('s2', 'Beta');

  const ctrl = createTabDragController({
    railEl: rail, tabRefs,
    onDragStart() {},
    onReorder() {},
  });
  t.after(() => ctrl.dispose());

  const btn = doc.querySelector('[data-workspace-activate="s1"]');
  pointerDown(btn, { clientX: 10, clientY: 10 });
  pointerMove(rail, { clientX: 80, clientY: 10 });
  pointerUp(rail, { clientX: 80, clientY: 10 });

  assert.equal(ctrl.shouldSuppressClick(), true, 'first call returns true');
  assert.equal(ctrl.shouldSuppressClick(), false, 'second call returns false');
});
