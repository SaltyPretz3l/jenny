'use strict';

/* Workspace workbench move-anywhere (W4): the pointer drag of a tab or strip button
 * (threshold, targets from cached rects, drop, every cancel path, click swallow, RTL,
 * focus on the moved tab, dispose) and the keyboard "Move next to" menu with the
 * openMoveMenu / getFocusedView API. JSDOM has no layout, so rects are stubbed. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { setup, twoBottomLayout, model, ops } = require('./helpers/ide-workbench-harness');
const dnd = require('../renderer/features/renderer-ide-workbench-dnd');
const treeOps = require('../renderer/features/renderer-ide-workbench-tree');

function rect(l, t, r, b) {
  return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t, x: l, y: t };
}

function stubRect(el, r) {
  if (!el) return;
  Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => r });
}

// Root 1000x800. L = rail 0..300; editor 300..900 x 0..400; B1 400..600; B2 600..800; R = strip 900..1000.
// Tabs are 100px wide (90 in L); mirrored inside their header when `rtl`.
function stubGeometry(rig, rtl) {
  stubRect(rig.rootEl, rect(0, 0, 1000, 800));
  const tabs = (stackId, x0, x1, top) => {
    const stack = rig.stackEl(stackId);
    const head = stack && stack.querySelector('.wb-stack-header');
    if (!head) return;
    stubRect(head, rect(x0, top, x1, top + 32));
    head.querySelectorAll('[data-wb-tab]').forEach((tab, i) => {
      const w = stackId === 'L' ? 90 : 100;
      stubRect(tab, rtl ? rect(x1 - (i + 1) * w, top, x1 - i * w, top + 32) : rect(x0 + i * w, top, x0 + (i + 1) * w, top + 32));
    });
  };
  stubRect(rig.stackEl('L'), rect(0, 0, 300, 800));
  tabs('L', 0, 300, 0);
  stubRect(rig.stackEl('B1'), rect(300, 400, 900, 600));
  tabs('B1', 300, 900, 400);
  stubRect(rig.stackEl('B2'), rect(300, 600, 900, 800));
  tabs('B2', 300, 900, 600);
  stubRect(rig.stackEl('R'), rect(900, 0, 1000, 800));
  stubRect(rig.q('.wb-stack--editor'), rect(300, 0, 900, 400));
}

function ptr(rig, type, target, x, y) {
  const ev = new rig.win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  target.dispatchEvent(ev);
  return ev;
}

function dragRig(opts) {
  const rig = setup(Object.assign({ layout: twoBottomLayout() }, opts));
  stubGeometry(rig, Boolean(opts && opts.rtl));
  return rig;
}

function begin(rig, el, x0, y0, x, y) {
  ptr(rig, 'pointerdown', el, x0, y0);
  ptr(rig, 'pointermove', rig.win, x, y);
}

function indicator(rig) {
  return rig.q('.wb-drop-indicator');
}

function assertClean(rig, el) {
  assert.equal(indicator(rig), null, 'indicator removed');
  assert.equal(rig.rootEl.classList.contains('wb-dragging'), false, 'root class removed');
  assert.equal(el.hasAttribute('data-wb-drag-source'), false, 'source attribute removed');
}

function views(rig, stackId) {
  const found = rig.state.layout && model.findStack(rig.state.layout, stackId);
  return found ? found.views : null;
}

test('threshold: a 3px move is not a drag and the click still activates the tab', () => {
  const rig = dragRig();
  const tab = rig.tab('search');
  begin(rig, tab, 100, 10, 103, 10);
  assert.equal(indicator(rig), null);
  assert.equal(rig.rootEl.classList.contains('wb-dragging'), false);
  assert.equal(tab.hasAttribute('data-wb-drag-source'), false);
  ptr(rig, 'pointerup', rig.win, 103, 10);
  rig.click(tab);
  assert.equal(rig.state.commits.length, 1, 'only the activation committed');
  assert.equal(rig.wb.getActiveView('search'), 'search');
});

test('drag to another stack tab row: pointer capture, root class, source mark, tabs indicator, moveView at the gap', () => {
  const rig = dragRig();
  const tab = rig.tab('search');
  const captured = [];
  tab.setPointerCapture = (id) => captured.push(id);
  const before = rig.state.layout;
  begin(rig, tab, 100, 10, 360, 410);
  assert.deepEqual(captured, [1]);
  assert.equal(rig.rootEl.classList.contains('wb-dragging'), true);
  assert.equal(tab.getAttribute('data-wb-drag-source'), 'true');
  const ind = indicator(rig);
  assert.equal(ind.parentNode, rig.rootEl);
  assert.equal(ind.getAttribute('data-wb-drop'), 'tabs');
  assert.equal(ind.getAttribute('aria-hidden'), 'true');
  assert.deepEqual([ind.style.left, ind.style.top, ind.style.width, ind.style.height], ['399px', '400px', '2px', '32px']);
  assert.equal(rig.qa('.wb-drop-indicator').length, 1);
  ptr(rig, 'pointermove', rig.win, 380, 415);
  assert.equal(rig.qa('.wb-drop-indicator').length, 1, 'one overlay, repainted');

  ptr(rig, 'pointerup', rig.win, 380, 415);
  assert.equal(rig.state.commits.length, 1);
  assert.ok(ops.isLayoutEqual(rig.state.layout, ops.moveView(before, 'search', { stackId: 'B1', index: 1 })));
  assert.deepEqual(views(rig, 'B1'), ['terminal', 'search', 'run', 'test-output']);
  assert.equal(rig.wb.getActiveView('B1'), 'search');
  assert.equal(rig.doc.activeElement, rig.tab('search'), 'focus lands on the moved tab');
  assertClean(rig, tab);
});

test('drag within the same tab row indexes after the view left; the no-op gap commits nothing', () => {
  const rig = dragRig();
  begin(rig, rig.tab('terminal'), 350, 410, 480, 415);
  assert.equal(indicator(rig).style.left, '499px', 'after the last tab');
  ptr(rig, 'pointerup', rig.win, 480, 415);
  assert.deepEqual(views(rig, 'B1'), ['run', 'terminal', 'test-output']);

  const same = dragRig();
  begin(same, same.tab('terminal'), 350, 410, 360, 410);
  assert.equal(indicator(same).getAttribute('data-wb-drop'), 'tabs');
  ptr(same, 'pointerup', same.win, 360, 410);
  assert.equal(same.state.commits.length, 0, 'dropping back where it was changes nothing');
});

test('drag onto a stack body appends and the indicator covers the stack', () => {
  const rig = dragRig();
  begin(rig, rig.tab('search'), 100, 10, 600, 500);
  const ind = indicator(rig);
  assert.equal(ind.getAttribute('data-wb-drop'), 'stack');
  assert.deepEqual([ind.style.left, ind.style.top, ind.style.width, ind.style.height], ['300px', '400px', '600px', '200px']);
  ptr(rig, 'pointerup', rig.win, 600, 500);
  assert.deepEqual(views(rig, 'B1'), ['terminal', 'run', 'test-output', 'search']);
});

test('drag from a strip button onto a stack body moves that view', () => {
  const rig = dragRig();
  const strip = rig.strip('chat');
  begin(rig, strip, 950, 100, 600, 700);
  assert.equal(strip.getAttribute('data-wb-drag-source'), 'true');
  assert.equal(indicator(rig).getAttribute('data-wb-drop'), 'stack');
  ptr(rig, 'pointerup', rig.win, 600, 700);
  assert.deepEqual(views(rig, 'B2'), ['problems', 'test-runner', 'chat']);
});

test('edge bands: left, right and bottom commit the edge moves and win over a stack body', () => {
  const cases = [
    ['edge-left', 10, 300, { edge: 'left' }, ['0px', '0px', '40px', '800px']],
    ['edge-right', 990, 300, { edge: 'right' }, ['960px', '0px', '40px', '800px']],
    ['edge-bottom', 500, 790, { edge: 'bottom' }, ['0px', '760px', '1000px', '40px']],
  ];
  cases.forEach(([kind, x, y, target, box]) => {
    const rig = dragRig();
    const before = rig.state.layout;
    begin(rig, rig.tab('terminal'), 350, 410, x, y);
    const ind = indicator(rig);
    assert.equal(ind.getAttribute('data-wb-drop'), kind);
    assert.deepEqual([ind.style.left, ind.style.top, ind.style.width, ind.style.height], box, kind);
    ptr(rig, 'pointerup', rig.win, x, y);
    assert.equal(rig.state.commits.length, 1, kind);
    assert.ok(ops.isLayoutEqual(rig.state.layout, ops.moveView(before, 'terminal', target)), kind);
  });
});

test('a tab row beats the edge band it overlaps', () => {
  const rig = dragRig();
  begin(rig, rig.tab('terminal'), 350, 410, 10, 10);
  assert.equal(indicator(rig).getAttribute('data-wb-drop'), 'tabs', 'the rail tab row at the left edge');
});

test('the editor is not a target for Search (F4), nor is empty space outside the root', () => {
  const rig = dragRig();
  begin(rig, rig.tab('search'), 100, 10, 500, 200);
  assert.equal(indicator(rig), null);
  ptr(rig, 'pointerup', rig.win, 500, 200);
  assert.equal(rig.state.commits.length, 0);
  assertClean(rig, rig.tab('search'));

  begin(rig, rig.tab('search'), 100, 10, 360, 410);
  assert.ok(indicator(rig));
  ptr(rig, 'pointermove', rig.win, -50, -50);
  assert.equal(indicator(rig), null, 'removed when over no target');
  ptr(rig, 'pointerup', rig.win, -50, -50);
  assert.equal(rig.state.commits.length, 0);
});

test('an outside pointer release clears an inside target without dropping', (t) => {
  const rig = dragRig();
  rig.wb.dispose();
  const drops = [];
  const drag = dnd.createDnd({ getRoot: () => rig.rootEl, isRtl: () => false, drop: (...args) => drops.push(args) });
  t.after(() => { drag.dispose(); rig.win.close(); });
  const tab = rig.tab('search');
  const released = [];
  tab.releasePointerCapture = (id) => released.push(id);
  drag.onPointerDown({ target: tab, button: 0, pointerId: 1, clientX: 100, clientY: 10 });
  ptr(rig, 'pointermove', rig.win, 360, 410);
  assert.ok(indicator(rig), 'inside move has a target');
  ptr(rig, 'pointerup', rig.win, 1100, 410);
  assert.deepEqual(drops, [], 'outside release must not drop on the cached inside target');
  assertClean(rig, tab);
  assert.deepEqual(released, [1]);
  ptr(rig, 'pointermove', rig.win, 360, 410);
  ptr(rig, 'pointerup', rig.win, 360, 410);
  assert.deepEqual(drops, [], 'the finished drag cannot be resumed');
  assertClean(rig, tab);
  for (const [i, coordinate] of [undefined, NaN, Infinity].entries()) {
    drag.onPointerDown({ target: tab, button: 0, pointerId: 1, clientX: 100, clientY: 10 });
    ptr(rig, 'pointermove', rig.win, 360, 410);
    const release = new rig.win.Event('pointerup');
    Object.defineProperties(release, { clientX: { value: coordinate }, clientY: { value: 410 } });
    rig.win.dispatchEvent(release);
    assert.deepEqual(drops.at(-1), ['search', { stackId: 'B1', index: 1 }], 'non-finite release retains the cached target');
    assert.equal(drops.length, i + 1);
    assertClean(rig, tab);
  }
});

test('Esc cancels: nothing commits and everything is cleaned up', () => {
  const rig = dragRig();
  const tab = rig.tab('search');
  begin(rig, tab, 100, 10, 360, 410);
  assert.ok(indicator(rig));
  const esc = new rig.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  rig.win.dispatchEvent(esc);
  assert.equal(esc.defaultPrevented, true);
  assertClean(rig, tab);
  ptr(rig, 'pointermove', rig.win, 600, 500);
  ptr(rig, 'pointerup', rig.win, 600, 500);
  assert.equal(rig.state.commits.length, 0);
  assert.equal(indicator(rig), null, 'a cancelled drag stays cancelled');
});

test('Esc before the threshold is left alone', () => {
  const rig = dragRig();
  ptr(rig, 'pointerdown', rig.tab('search'), 100, 10);
  const esc = new rig.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  rig.win.dispatchEvent(esc);
  assert.equal(esc.defaultPrevented, false);
  ptr(rig, 'pointerup', rig.win, 100, 10);
});

test('pointercancel and lost pointer capture cancel with no commit', () => {
  const rig = dragRig();
  const tab = rig.tab('search');
  begin(rig, tab, 100, 10, 360, 410);
  rig.win.dispatchEvent(new rig.win.Event('pointercancel'));
  assertClean(rig, tab);
  ptr(rig, 'pointerup', rig.win, 360, 410);
  assert.equal(rig.state.commits.length, 0);

  begin(rig, tab, 100, 10, 360, 410);
  assert.ok(indicator(rig));
  tab.dispatchEvent(new rig.win.Event('lostpointercapture'));
  assertClean(rig, tab);
  ptr(rig, 'pointerup', rig.win, 360, 410);
  assert.equal(rig.state.commits.length, 0);
});

test('the click after a real drag is swallowed once, then clicks work again', async () => {
  const rig = dragRig();
  begin(rig, rig.tab('search'), 100, 10, -50, -50);
  ptr(rig, 'pointerup', rig.win, -50, -50);
  rig.click(rig.tab('search'));
  assert.equal(rig.state.commits.length, 0, 'the follow-up click did not activate the tab');
  assert.equal(rig.wb.getActiveView('search'), 'explorer');
  await new Promise((resolve) => setTimeout(resolve, 20));
  rig.click(rig.tab('search'));
  assert.equal(rig.state.commits.length, 1, 'the swallow was one-shot');
  assert.equal(rig.wb.getActiveView('search'), 'search');
});

test('after an Esc cancel the release click is swallowed and the next press disarms', () => {
  const rig = dragRig();
  begin(rig, rig.tab('search'), 100, 10, 360, 410);
  rig.win.dispatchEvent(new rig.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  ptr(rig, 'pointerup', rig.win, 360, 410);
  rig.click(rig.tab('search'));
  assert.equal(rig.state.commits.length, 0);

  begin(rig, rig.tab('search'), 100, 10, 360, 410);
  rig.win.dispatchEvent(new rig.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  ptr(rig, 'pointerdown', rig.tab('explorer'), 10, 10);
  ptr(rig, 'pointerup', rig.win, 10, 10);
  rig.click(rig.tab('search'));
  assert.equal(rig.state.commits.length, 1, 'a fresh press cleared the stale swallow');
});

test('dispose mid-drag removes every window listener and cleans the DOM', () => {
  const rig = dragRig();
  const live = [];
  const add = rig.win.addEventListener.bind(rig.win);
  const remove = rig.win.removeEventListener.bind(rig.win);
  const same = (a, b) => a.type === b.type && a.fn === b.fn && a.cap === b.cap;
  const entry = (type, fn, opt) => ({ type, fn, cap: opt === true || Boolean(opt && opt.capture) });
  rig.win.addEventListener = (type, fn, opt) => {
    live.push(entry(type, fn, opt));
    add(type, fn, opt);
  };
  rig.win.removeEventListener = (type, fn, opt) => {
    const at = live.findIndex((e) => same(e, entry(type, fn, opt)));
    if (at >= 0) live.splice(at, 1);
    remove(type, fn, opt);
  };
  const tab = rig.tab('search');
  begin(rig, tab, 100, 10, 360, 410);
  assert.ok(live.length >= 4, 'drag listeners attached');
  rig.wb.dispose();
  assert.equal(live.length, 0, 'left behind: ' + live.map((e) => e.type).join(','));
  assertClean(rig, tab);
  ptr(rig, 'pointerup', rig.win, 360, 410);
  assert.equal(rig.state.commits.length, 0);
});

test('RTL mirrors the insertion index and the indicator', () => {
  const rig = dragRig({ rtl: true });
  begin(rig, rig.tab('search'), 100, 10, 840, 410);
  const ind = indicator(rig);
  assert.equal(ind.getAttribute('data-wb-drop'), 'tabs');
  assert.equal(ind.style.left, '799px');
  ptr(rig, 'pointerup', rig.win, 840, 410);
  assert.deepEqual(views(rig, 'B1'), ['terminal', 'search', 'run', 'test-output'], 'after the first (rightmost) tab');

  const left = dragRig({ rtl: true });
  begin(left, left.tab('search'), 100, 10, 620, 410);
  ptr(left, 'pointerup', left.win, 620, 410);
  assert.deepEqual(views(left, 'B1'), ['terminal', 'run', 'test-output', 'search'], 'left of the last tab is the end in RTL');
});

test('a window resize re-measures the cached rects', () => {
  const rig = dragRig();
  begin(rig, rig.tab('search'), 100, 10, 600, 500);
  assert.equal(indicator(rig).style.width, '600px');
  stubRect(rig.stackEl('B1'), rect(300, 400, 700, 600));
  rig.win.dispatchEvent(new rig.win.Event('resize'));
  assert.equal(indicator(rig).style.width, '400px');
  ptr(rig, 'pointerup', rig.win, 600, 500);
  assert.equal(rig.state.commits.length, 1);
});

test('measure and resolveTarget: hidden stacks are skipped and a point outside the root is no target', () => {
  const rig = dragRig();
  stubRect(rig.stackEl('B2'), rect(0, 0, 0, 0));
  const zones = dnd.measure(rig.rootEl);
  assert.deepEqual(zones.stacks.map((s) => s.id).sort(), ['B1', 'L', 'R']);
  assert.equal(dnd.resolveTarget(zones, 2000, 10, false, 'search'), null);
  assert.equal(dnd.resolveTarget(zones, 500, 200, false, 'search'), null, 'the editor');
  assert.equal(dnd.resolveTarget(zones, 500, 500, false, 'search').kind, 'stack');
});

test('a pointer in the lower half of an editor group docks the view below it', () => {
  const rig = dragRig();
  const before = rig.state.layout;
  begin(rig, rig.tab('terminal'), 350, 410, 600, 350);
  const ind = indicator(rig);
  assert.equal(ind.getAttribute('data-wb-drop'), 'group');
  assert.deepEqual([ind.style.left, ind.style.top, ind.style.width, ind.style.height], ['300px', '200px', '600px', '200px']);
  assert.deepEqual(dnd.resolveTarget(dnd.measure(rig.rootEl), 600, 350, false, 'terminal').drop, { group: 'editor-1', side: 'bottom' });
  ptr(rig, 'pointerup', rig.win, 600, 350);
  assert.equal(rig.state.commits.length, 1);
  assert.ok(ops.isLayoutEqual(rig.state.layout, ops.moveView(before, 'terminal', { group: 'editor-1', side: 'bottom' })));
  assert.notEqual(model.findView(rig.state.layout, 'terminal').stackId, 'B1', 'a new stack under the group');
});

test('beside falls back to below when the group row has no room', (t) => {
  const rig = dragRig();
  t.after(() => { rig.wb.dispose(); rig.win.close(); });
  const zones = dnd.measure(rig.rootEl);
  const below = { kind: 'group', drop: { group: 'editor-1', side: 'bottom' }, rect: { l: 300, t: 200, r: 900, b: 400 } };
  assert.deepEqual(dnd.resolveTarget(zones, 880, 200, false, 'terminal', () => false), below);
  assert.equal(dnd.resolveTarget(zones, 880, 200, false, 'terminal', () => true).drop.side, 'right');
  assert.deepEqual(dnd.resolveTarget(zones, 600, 20, false, 'terminal', () => false), {
    kind: 'group', drop: { group: 'editor-1', side: 'top' }, rect: { l: 300, t: 0, r: 900, b: 200 },
  });
  assert.deepEqual(dnd.resolveTarget(zones, 320, 200, true, 'terminal', () => false), below);
});

test('createDnd forwards besideFits on moves and resize', (t) => {
  const rig = dragRig();
  rig.wb.dispose();
  const calls = [];
  const drops = [];
  let fits = false;
  const drag = dnd.createDnd({
    getRoot: () => rig.rootEl,
    isRtl: () => false,
    besideFits: (groupId, viewId) => { calls.push([groupId, viewId]); return fits; },
    drop: (viewId, target) => drops.push([viewId, target]),
  });
  t.after(() => { drag.dispose(); rig.win.close(); });
  const tab = rig.tab('terminal');
  drag.onPointerDown({ target: tab, button: 0, pointerId: 1, clientX: 350, clientY: 410 });
  ptr(rig, 'pointermove', rig.win, 880, 200);
  const assertBelow = () => {
    const ind = indicator(rig);
    assert.equal(ind.getAttribute('data-wb-drop'), 'group');
    assert.deepEqual([ind.style.left, ind.style.top, ind.style.width, ind.style.height], ['300px', '200px', '600px', '200px']);
  };
  assertBelow();
  fits = true;
  ptr(rig, 'pointermove', rig.win, 880, 200);
  assert.equal(indicator(rig).style.left, '600px');
  fits = false;
  rig.win.dispatchEvent(new rig.win.Event('resize'));
  assertBelow();
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ['editor-1', 'terminal']));
  ptr(rig, 'pointerup', rig.win, 880, 200);
  assert.deepEqual(drops, [['terminal', { group: 'editor-1', side: 'bottom' }]]);
});

test('workbench drag uses the group row width inside a column: narrow docks below, wide beside', (t) => {
  for (const [width, available, side] of [[1000, 668, 'bottom'], [1800, 1468, 'right']]) {
    const rig = setup({ layout: ops.addEditorGroup(twoBottomLayout(), 'editor-1', 'right', 400, 'editor-2') });
    t.after(() => { rig.wb.dispose(); rig.win.close(); });
    stubGeometry(rig);
    stubRect(rig.rootEl, rect(0, 0, width, 800));
    rig.wb.render();
    stubGeometry(rig);
    stubRect(rig.rootEl, rect(0, 0, width, 800));
    stubRect(rig.stackEl('editor-1'), rect(300, 0, 600, 400));
    stubRect(rig.stackEl('editor-2'), rect(600, 0, 900, 400));
    const solved = rig.state.rendered.at(-1).solved;
    assert.equal(solved.sizes.c, available, 'column width from the real solver');
    assert.equal(solved.sizes['editor-1'] + solved.sizes['editor-2'], available, 'row children store widths');
    assert.equal(solved.sizes['split-1'], 450, 'row itself stores its height');
    assert.equal(2 * model.EDITOR_MIN_WIDTH + model.VIEW_CATALOG.terminal.minWidth, 960);
    const before = rig.state.layout;
    begin(rig, rig.tab('terminal'), 350, 410, 880, 200);
    const ind = indicator(rig);
    assert.deepEqual([ind.style.left, ind.style.top, ind.style.width, ind.style.height],
      side === 'bottom' ? ['600px', '200px', '300px', '200px'] : ['750px', '0px', '150px', '400px']);
    ptr(rig, 'pointerup', rig.win, 880, 200);
    assert.equal(rig.state.commits.length, 1);
    assert.ok(ops.isLayoutEqual(rig.state.layout, ops.moveView(before, 'terminal', { group: 'editor-2', side })), side);
    assert.equal(rig.stackEl(rig.stackOf('terminal')).getAttribute('data-state'), 'open');
  }
});

test('the nearest side wins, mirrored in RTL; Files, Search and Git get no group target', () => {
  const zones = dnd.measure(dragRig().rootEl);
  const at = (x, y, rtl, viewId) => dnd.resolveTarget(zones, x, y, rtl, viewId || 'terminal');
  assert.deepEqual(at(320, 200, false).drop, { group: 'editor-1', side: 'left' });
  assert.deepEqual(at(320, 200, false).rect, { l: 300, t: 0, r: 600, b: 400 });
  assert.deepEqual(at(880, 200, false).drop, { group: 'editor-1', side: 'right' });
  assert.deepEqual(at(600, 20, false).drop, { group: 'editor-1', side: 'top' });
  assert.deepEqual(at(320, 200, true).drop, { group: 'editor-1', side: 'right' }, 'the physical left half is the row end in RTL');
  assert.deepEqual(at(320, 200, true).rect, { l: 300, t: 0, r: 600, b: 400 }, 'the indicator stays under the pointer');
  assert.deepEqual(at(880, 200, true).drop, { group: 'editor-1', side: 'left' });
  ['explorer', 'search', 'source-control'].forEach((v) => assert.equal(at(600, 350, false, v), null, v));

  const rig = dragRig();
  begin(rig, rig.tab('explorer'), 10, 10, 600, 350);
  assert.equal(indicator(rig), null);
  ptr(rig, 'pointerup', rig.win, 600, 350);
  assert.equal(rig.state.commits.length, 0);
});

test('an edge band over an editor group still wins', () => {
  const rig = dragRig();
  stubRect(rig.stackEl('L'), rect(0, 0, 0, 0));
  stubRect(rig.stackEl('R'), rect(0, 0, 0, 0));
  stubRect(rig.q('.wb-stack--editor'), rect(0, 0, 1000, 400));
  const zones = dnd.measure(rig.rootEl);
  assert.equal(dnd.resolveTarget(zones, 990, 200, false, 'terminal').kind, 'edge-right');
  assert.equal(dnd.resolveTarget(zones, 10, 200, false, 'terminal').kind, 'edge-left');
  assert.deepEqual(dnd.resolveTarget(zones, 900, 200, false, 'terminal').drop, { group: 'editor-1', side: 'right' });
  begin(rig, rig.tab('terminal'), 350, 410, 990, 200);
  assert.equal(indicator(rig).getAttribute('data-wb-drop'), 'edge-right');
});

/* ----------------------------------------------------------------- keyboard menu and API */

test('Move menu: next-to items for the other stacks, the own stack excluded, then edges, then reset', () => {
  const rig = dragRig();
  assert.equal(rig.wb.openMoveMenu('search'), true);
  const menu = rig.state.menus.at(-1);
  assert.equal(menu.anchorEl, rig.tab('search'));
  assert.equal(menu.ariaLabel, 'Move View to…', 'the menu has an accessible name');
  assert.deepEqual(
    menu.items.map((i) => i.label || 'sep'),
    ['Move next to Terminal', 'Move next to Problems', 'Move next to Chat', 'sep', 'Move to left side', 'Move to right side', 'Move to bottom', 'sep', 'Reset layout'],
  );
  const before = rig.state.layout;
  menu.items[1].action();
  assert.equal(rig.state.commits.length, 1);
  assert.ok(ops.isLayoutEqual(rig.state.layout, ops.moveView(before, 'search', { stackId: 'B2' })));
  assert.deepEqual(views(rig, 'B2'), ['problems', 'test-runner', 'search']);
});

test('Move menu: unavailable stacks are not offered and a lone stack has no next-to items', () => {
  const rig = dragRig({ unavailable: ['problems', 'test-runner'] });
  rig.wb.openMoveMenu('search');
  assert.deepEqual(
    rig.state.menus.at(-1).items.map((i) => i.label || 'sep').slice(0, 3),
    ['Move next to Terminal', 'Move next to Chat', 'sep'],
  );
  const lone = setup({ unavailable: ['terminal', 'problems', 'run', 'test-runner', 'test-output', 'chat', 'changes'] });
  lone.wb.openMoveMenu('explorer');
  assert.equal(lone.state.menus.at(-1).items[0].label, 'Move to left side', 'no separator without next-to items');
});

test('Move menu: the keyboard twin of a group drop docks the view below or beside each editor group', () => {
  const rig = dragRig();
  rig.wb.openMoveMenu('terminal');
  const items = rig.state.menus.at(-1).items;
  const labels = items.map((i) => i.label || 'sep');
  assert.deepEqual(labels.slice(labels.indexOf('Move below editor'), labels.indexOf('Move below editor') + 3), ['Move below editor', 'Move beside editor', 'sep']);
  const before = rig.state.layout;
  items[labels.indexOf('Move below editor')].action();
  assert.ok(ops.isLayoutEqual(rig.state.layout, ops.moveView(before, 'terminal', { group: 'editor-1', side: 'bottom' })));
  // With two groups and room for both moves, each is named by its own number.
  stubRect(rig.rootEl, rect(0, 0, 1800, 800));
  rig.setLayout(ops.addEditorGroup(rig.state.layout, 'editor-1', 'right', 400, 'editor-2'));
  rig.wb.render();
  assert.equal(ops.besideFits(rig.state.layout, rig.state.rendered.at(-1).solved, 1800, 'editor-2', 'problems', 1), true);
  rig.wb.openMoveMenu('problems');
  const two = rig.state.menus.at(-1).items.map((i) => i.label || 'sep');
  ['Move below Editor group 1', 'Move beside Editor group 1', 'Move below Editor group 2', 'Move beside Editor group 2'].forEach((l) => assert.ok(two.includes(l), l));
  rig.wb.openMoveMenu('search');
  assert.ok(!rig.state.menus.at(-1).items.some((i) => /below|beside/.test(i.label || '')), 'Files, Search and Git never dock beside a group (F4)');
});

test('Move beside at a narrow solver width commits the pointer bottom fallback with one row per group', (t) => {
  const rig = setup({ layout: ops.addEditorGroup(twoBottomLayout(), 'editor-1', 'right', 400, 'editor-2') });
  t.after(() => { rig.wb.dispose(); rig.win.close(); });
  stubGeometry(rig);
  rig.wb.render();
  stubGeometry(rig);
  stubRect(rig.stackEl('editor-1'), rect(300, 0, 600, 400));
  stubRect(rig.stackEl('editor-2'), rect(600, 0, 900, 400));
  const before = rig.state.layout;
  const solved = rig.state.rendered.at(-1).solved;
  assert.equal(solved.sizes.c, 668, 'real solver width cannot hold another view beside two groups');
  assert.equal(ops.besideFits(before, solved, 1000, 'editor-2', 'terminal', 1), false);
  begin(rig, rig.tab('terminal'), 350, 410, 880, 200);
  ptr(rig, 'pointerup', rig.win, 880, 200);
  const pointerLayout = rig.state.layout;
  assert.ok(ops.isLayoutEqual(pointerLayout, ops.moveView(before, 'terminal', { group: 'editor-2', side: 'bottom' })));
  rig.setLayout(before);
  rig.wb.render();
  assert.equal(rig.wb.openMoveMenu('terminal'), true);
  const items = rig.state.menus.at(-1).items;
  items.find((item) => item.label === 'Move beside Editor group 2').action();
  assert.ok(ops.isLayoutEqual(rig.state.layout, pointerLayout), 'keyboard beside and pointer drop commit the same bottom layout');
  for (const n of [1, 2]) {
    assert.equal(items.filter((item) => item.label === 'Move below Editor group ' + n || item.label === 'Move beside Editor group ' + n).length, 1,
      'only one row for group ' + n);
  }
  const commits = [];
  const noFitItems = treeOps.menuItems({ model, ops, viewId: 'terminal', getLayout: () => before,
    tr: (_key, fallback, params) => fallback.replace('{group}', params && params.group).replace('{n}', params && params.n),
    commit: (next) => commits.push(next) });
  assert.ok(noFitItems.some((item) => item.label === 'Move below Editor group 2'), 'without a fit callback both rows remain');
  noFitItems.find((item) => item.label === 'Move beside Editor group 2').action();
  assert.ok(ops.isLayoutEqual(commits[0], ops.moveView(before, 'terminal', { group: 'editor-2', side: 'right' })));
});

test('openMoveMenu anchors on a strip button, and returns false for a view with no control', () => {
  const rig = dragRig();
  assert.equal(rig.wb.openMoveMenu('chat'), true);
  assert.equal(rig.state.menus.at(-1).anchorEl, rig.strip('chat'));
  const opened = rig.state.menus.length;
  assert.equal(rig.wb.openMoveMenu('nope'), false);
  assert.equal(rig.state.menus.length, opened);
});

test('getFocusedView: the focused stack, else the most recently used views stack, else null', () => {
  const rig = dragRig();
  const outside = rig.doc.getElementById('outside');
  outside.focus();
  assert.equal(rig.wb.getFocusedView(), null, 'nothing used yet');

  rig.click(rig.tab('run'));
  outside.focus();
  assert.equal(rig.wb.getFocusedView(), 'run', 'lastUsed fallback');

  rig.tab('search').focus();
  assert.equal(rig.wb.getFocusedView(), 'explorer', 'the focused stack wins; a view in its tab row reports the active view');
  rig.tab('terminal').focus();
  assert.equal(rig.wb.getFocusedView(), 'run');

  rig.doc.getElementById('mainInput').focus();
  assert.equal(rig.wb.getFocusedView(), 'run', 'the editor is not a views stack: the most recent views stack answers');
});

test('RTL edge bands follow the page: the left band is the row end, the right band its start', () => {
  [['edge-left', 10, { edge: 'right' }], ['edge-right', 990, { edge: 'left' }]].forEach(([kind, x, target]) => {
    const rig = dragRig({ rtl: true });
    const before = rig.state.layout;
    begin(rig, rig.tab('terminal'), 350, 410, x, 300);
    assert.equal(indicator(rig).getAttribute('data-wb-drop'), kind, 'the indicator stays on the band under the pointer');
    ptr(rig, 'pointerup', rig.win, x, 300);
    assert.ok(ops.isLayoutEqual(rig.state.layout, ops.moveView(before, 'terminal', target)), kind);
  });
});