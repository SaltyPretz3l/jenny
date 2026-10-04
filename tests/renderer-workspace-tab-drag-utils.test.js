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
  // A live drag's moves carry the held primary button (buttons: 1).
  el.dispatchEvent(new global.window.PointerEvent('pointermove', { pointerId: 1, buttons: 1, clientX: 50, clientY: 10, bubbles: true, ...opts }));
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

test('a release off the rail does not leave a phantom drag behind', (t) => {
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

  // A fast flick: the press lands on a tab, the first move and the release
  // happen off the rail, so the rail hears neither.
  pointerDown(doc.querySelector('[data-workspace-activate="s1"]'), { clientX: 10, clientY: 10 });
  // Hovering back over the rail with no button held must not start a drag.
  pointerMove(rail, { clientX: 80, clientY: 10, buttons: 0 });
  assert.equal(starts.length, 0, 'no drag starts from a buttonless hover');
  assert.equal(doc.querySelector('.workspace-tab-drag-ghost'), null, 'no phantom ghost');

  // And the next real press drags normally.
  pointerDown(doc.querySelector('[data-workspace-activate="s1"]'), { clientX: 10, clientY: 10 });
  pointerMove(rail, { clientX: 80, clientY: 10 });
  pointerUp(rail, { clientX: 80, clientY: 10 });
  assert.equal(starts.length, 1);
  assert.deepEqual(reorders.map((r) => r.id), ['s1']);
});

test('a new press replaces a stale uncommitted drag', (t) => {
  const dom = setupDom();
  t.after(async () => { delete global.window; delete global.document; await dom.window.close(); });
  const doc = dom.window.document;
  const { rail, tabRefs, addTab } = buildRail(doc);
  addTab('s1', 'Alpha');
  addTab('s2', 'Beta');

  const reorders = [];
  const ctrl = createTabDragController({ railEl: rail, tabRefs, onDragStart() {}, onReorder(id, idx) { reorders.push({ id, idx }); } });
  t.after(() => ctrl.dispose());

  pointerDown(doc.querySelector('[data-workspace-activate="s2"]'), { clientX: 60, clientY: 10 });
  // No move or release reached the rail; the next press starts fresh on s1.
  pointerDown(doc.querySelector('[data-workspace-activate="s1"]'), { clientX: 10, clientY: 10 });
  pointerMove(rail, { clientX: 80, clientY: 10 });
  pointerUp(rail, { clientX: 80, clientY: 10 });
  assert.deepEqual(reorders.map((r) => r.id), ['s1']);
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

/* Split view W2-1: a committed tab drag that leaves the rail for the chat view
 * (the optional `dropTarget` dep) becomes "open beside on that half". The
 * target's rect is read once per commit and once per re-entry, never per move;
 * `onHover` fires only when the hovered half changes. */
function buildDropTarget(doc, rect = { left: 0, top: 100, right: 400, bottom: 400, width: 400, height: 300 }) {
  const el = doc.createElement('section');
  doc.body.appendChild(el);
  const reads = [];
  el.getBoundingClientRect = () => { reads.push(1); return rect; };
  const hovers = [];
  const drops = [];
  return {
    el,
    reads,
    hovers,
    drops,
    target: { el, onHover(side) { hovers.push(side); }, onDrop(id, side) { drops.push([id, side]); } },
  };
}

function startDrag(doc, rail) {
  pointerDown(doc.querySelector('[data-workspace-activate="s1"]'), { clientX: 10, clientY: 10 });
  pointerMove(rail, { clientX: 80, clientY: 10 }); // commits inside the rail
}

function dropRig(t, dropTargetFor) {
  const dom = setupDom();
  t.after(async () => { delete global.window; delete global.document; await dom.window.close(); });
  const doc = dom.window.document;
  const { rail, tabRefs, addTab } = buildRail(doc);
  addTab('s1', 'Alpha');
  addTab('s2', 'Beta');
  const drop = buildDropTarget(doc);
  const reorders = [];
  const ctrl = createTabDragController({
    railEl: rail, tabRefs,
    onDragStart() {},
    onReorder(id, idx) { reorders.push({ id, idx }); },
    dropTarget: dropTargetFor ? dropTargetFor(drop.target) : drop.target,
  });
  t.after(() => ctrl.dispose());
  return { dom, doc, rail, drop, reorders, ctrl };
}

const marker = (doc) => doc.querySelector('.workspace-tab-insertion-marker');

test('drop target: hovering the view reports each half once, removes the marker, and pointerup drops instead of reordering', async (t) => {
  const { doc, rail, drop, reorders, ctrl } = dropRig(t);
  startDrag(doc, rail);
  assert.ok(marker(doc) !== null, 'inside the rail the insertion marker shows');
  assert.equal(drop.reads.length, 1, 'the target rect is read once, at commit');
  assert.deepEqual(drop.hovers, [], 'no hover while the pointer is in the rail');

  pointerMove(rail, { clientX: 100, clientY: 200 });
  assert.deepEqual(drop.hovers, ['left']);
  assert.equal(marker(doc), null, 'the insertion marker is removed over the view');
  pointerMove(rail, { clientX: 150, clientY: 250 });
  pointerMove(rail, { clientX: 199, clientY: 390 });
  assert.deepEqual(drop.hovers, ['left'], 'the same half fires nothing');
  pointerMove(rail, { clientX: 201, clientY: 200 });
  pointerMove(rail, { clientX: 390, clientY: 300 });
  assert.deepEqual(drop.hovers, ['left', 'right'], 'crossing the midpoint fires once');
  assert.equal(drop.reads.length, 1, 'no layout read per move');
  assert.equal(marker(doc), null, 'moves over the view never bring the marker back');

  pointerUp(rail, { clientX: 390, clientY: 300 });
  await Promise.resolve();
  assert.deepEqual(drop.drops, [['s1', 'right']]);
  assert.deepEqual(reorders, [], 'a drop on the view never reorders');
  assert.deepEqual(drop.hovers, ['left', 'right', null], 'the hover clears before the drop');
  assert.equal(doc.querySelector('.workspace-tab-drag-ghost'), null, 'ghost cleaned up');
  assert.equal(doc.querySelector('[data-session-id="s1"]').classList.contains('dragging'), false);
  assert.equal(ctrl.shouldSuppressClick(), true, 'the click after a drop is swallowed like a reorder');
});

test('drop target: leaving the view restores the rail marker path; re-entering reads the rect again', async (t) => {
  const { doc, rail, drop, reorders } = dropRig(t);
  startDrag(doc, rail);
  pointerMove(rail, { clientX: 100, clientY: 200 });
  assert.deepEqual(drop.hovers, ['left']);

  pointerMove(rail, { clientX: 80, clientY: 10 });
  assert.deepEqual(drop.hovers, ['left', null], 'leaving the view clears the hover');
  assert.ok(marker(doc) !== null, 'back over the rail the marker returns');

  pointerMove(rail, { clientX: 300, clientY: 200 });
  assert.equal(drop.reads.length, 2, 're-entry reads the rect once more');
  assert.deepEqual(drop.hovers, ['left', null, 'right']);
  pointerMove(rail, { clientX: 80, clientY: 10 });

  pointerUp(rail, { clientX: 80, clientY: 10 });
  await Promise.resolve();
  assert.deepEqual(drop.drops, [], 'a release over the rail is not a drop');
  assert.deepEqual(reorders, [{ id: 's1', idx: 1 }], 'it reorders exactly as without a drop target');
  assert.deepEqual(drop.hovers, ['left', null, 'right', null], 'nothing more fires once the hover is clear');
});

test('drop target: Escape mid-drag over the view cancels with onHover(null) and drops nothing', async (t) => {
  const { dom, doc, rail, drop, reorders } = dropRig(t);
  startDrag(doc, rail);
  pointerMove(rail, { clientX: 300, clientY: 200 });
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  pointerUp(rail, { clientX: 300, clientY: 200 });
  await Promise.resolve();
  assert.deepEqual(drop.hovers, ['right', null]);
  assert.deepEqual(drop.drops, []);
  assert.deepEqual(reorders, []);
  assert.equal(doc.querySelector('.workspace-tab-drag-ghost'), null);
});

test('drop target: pointercancel over the view clears the hover', async (t) => {
  const { doc, rail, drop, reorders } = dropRig(t);
  startDrag(doc, rail);
  pointerMove(rail, { clientX: 100, clientY: 200 });
  pointerCancel(rail);
  await Promise.resolve();
  assert.deepEqual(drop.hovers, ['left', null]);
  assert.deepEqual(drop.drops, []);
  assert.deepEqual(reorders, []);
});

test('drop target: a getter is resolved at commit; a null answer leaves the reorder path untouched', async (t) => {
  let live = null;
  const { doc, rail, drop, reorders } = dropRig(t, () => () => live);
  startDrag(doc, rail);
  pointerMove(rail, { clientX: 100, clientY: 200 });
  assert.deepEqual(drop.hovers, [], 'no target at commit: the view is not a drop zone');
  assert.ok(marker(doc) !== null, 'the marker path runs as before');
  pointerUp(rail, { clientX: 100, clientY: 200 });
  await Promise.resolve();
  assert.equal(reorders.length, 1);
  assert.equal(drop.reads.length, 0, 'no rect read without a target');

  live = drop.target;
  startDrag(doc, rail);
  pointerMove(rail, { clientX: 100, clientY: 200 });
  pointerUp(rail, { clientX: 100, clientY: 200 });
  await Promise.resolve();
  assert.deepEqual(drop.drops, [['s1', 'left']], 'the next drag resolves the now-live target');
});

test('drop target: the visual half comes from the rect midpoint wherever the view sits', (t) => {
  const dom = setupDom();
  t.after(async () => { delete global.window; delete global.document; await dom.window.close(); });
  const doc = dom.window.document;
  const { rail, tabRefs, addTab } = buildRail(doc);
  addTab('s1', 'Alpha');
  addTab('s2', 'Beta');
  const drop = buildDropTarget(doc, { left: 500, top: 100, right: 900, bottom: 400, width: 400, height: 300 });
  const ctrl = createTabDragController({ railEl: rail, tabRefs, onReorder() {}, dropTarget: drop.target });
  t.after(() => ctrl.dispose());
  startDrag(doc, rail);
  pointerMove(rail, { clientX: 300, clientY: 200 });
  assert.deepEqual(drop.hovers, [], 'left of the view is not inside it');
  pointerMove(rail, { clientX: 690, clientY: 200 });
  pointerMove(rail, { clientX: 710, clientY: 200 });
  assert.deepEqual(drop.hovers, ['left', 'right']);
});
