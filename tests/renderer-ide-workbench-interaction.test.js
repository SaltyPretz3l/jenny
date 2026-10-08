'use strict';

/* Workspace workbench interaction: tab click/roving, collapse and strips, sash keyboard and
 * pointer, the More menu, maximize, focus safety, revealView and dispose. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { setup, twoBottomLayout, model, ops } = require('./helpers/ide-workbench-harness');

function sizeOf(layout, splitId, index) {
  let found = null;
  (function walk(node) {
    if (node.t !== 'split') return;
    if (node.id === splitId) found = node.children[index].size;
    node.children.forEach((c) => walk(c.node));
  })(layout.root);
  return found;
}

function pointer(rig, el, type, x, y = 0) {
  const target = type === 'pointerdown' ? el : rig.win;
  target.dispatchEvent(new rig.win.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 }));
}

test('a tab click commits setActiveView and un-hides the right host', () => {
  const rig = setup();
  rig.click(rig.tab('search'));
  assert.equal(rig.state.commits.length, 1);
  assert.ok(ops.isLayoutEqual(rig.state.layout, model.setActiveView(model.createDefaultLayout(), 'search')));
  assert.equal(rig.wb.hostFor('search').hidden, false);
  assert.equal(rig.wb.hostFor('explorer').hidden, true);
  assert.equal(rig.tab('search').getAttribute('aria-selected'), 'true');
  rig.click(rig.tab('search'));
  assert.equal(rig.state.commits.length, 1, 'no-op click does not commit');
});

test('a tab click on a collapsed header stack reveals it', () => {
  const rig = setup();
  rig.click(rig.tab('problems'));
  const stack = rig.state.layout.root.children[1].node.children[1].node;
  assert.equal(stack.active, 'problems');
  assert.equal(stack.collapsed, false);
  assert.equal(rig.stackEl('stack-2').getAttribute('data-state'), 'open');
  assert.equal(rig.stackEl('stack-2').querySelector('.wb-stack-body').hidden, false);
});

test('arrow, Home and End keys rove the tabs, activating and re-focusing', () => {
  const rig = setup();
  rig.tab('explorer').focus();
  const ev = rig.key(rig.tab('explorer'), 'ArrowRight');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(rig.state.layout.root.children[0].node.active, 'search');
  assert.equal(rig.doc.activeElement, rig.tab('search'));
  rig.key(rig.tab('search'), 'End');
  assert.equal(rig.doc.activeElement, rig.tab('source-control'));
  rig.key(rig.tab('source-control'), 'ArrowRight');
  assert.equal(rig.doc.activeElement, rig.tab('explorer'), 'wraps');
  rig.key(rig.tab('explorer'), 'ArrowLeft');
  assert.equal(rig.doc.activeElement, rig.tab('source-control'));
  rig.key(rig.tab('source-control'), 'Home');
  assert.equal(rig.doc.activeElement, rig.tab('explorer'));
  assert.equal(rig.state.layout.root.children[0].node.active, 'explorer');
  const before = rig.state.commits.length;
  const ignored = rig.key(rig.tab('explorer'), 'ArrowRight', { ctrlKey: true });
  assert.equal(ignored.defaultPrevented, false);
  assert.equal(rig.state.commits.length, before);
});

test('arrow keys are mirrored under dir=rtl', () => {
  const rig = setup({ rtl: true });
  rig.tab('explorer').focus();
  rig.key(rig.tab('explorer'), 'ArrowRight');
  assert.equal(rig.doc.activeElement, rig.tab('source-control'));
  assert.equal(rig.state.layout.root.children[0].node.active, 'source-control');
});

test('collapse turns a row stack into a strip; a strip click reveals it', () => {
  const rig = setup();
  rig.click(rig.action('stack-1', 'collapse'));
  assert.equal(rig.state.layout.root.children[0].node.collapsed, true);
  const stack = rig.stackEl('stack-1');
  assert.equal(stack.getAttribute('data-state'), 'collapsed');
  assert.equal(stack.querySelectorAll('.wb-strip-btn').length, 3);
  assert.equal(stack.querySelector('.wb-stack-header'), null);
  assert.equal(stack.querySelector('.wb-stack-body').hidden, true);
  assert.equal(rig.q('[data-wb-cell="split-1:0"]').style.flex, '0 0 32px');
  rig.click(rig.strip('search'));
  const node = rig.state.layout.root.children[0].node;
  assert.equal(node.active, 'search');
  assert.equal(node.collapsed, false);
  assert.equal(rig.stackEl('stack-1').getAttribute('data-state'), 'open');
  assert.equal(rig.wb.hostFor('search').hidden, false);
  assert.ok(rig.tab('search'));
});

test('sash keyboard: arrows step 16 px, Home clamps to the minimum, End grows by 400', () => {
  const rig = setup();
  const sash = rig.sash('split-1:0');
  const ev = rig.key(sash, 'ArrowRight');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(sizeOf(rig.state.layout, 'split-1', 0), 316);
  rig.key(rig.sash('split-1:0'), 'ArrowLeft');
  rig.key(rig.sash('split-1:0'), 'ArrowLeft');
  assert.equal(sizeOf(rig.state.layout, 'split-1', 0), 284);
  const before = rig.state.commits.length;
  rig.key(rig.sash('split-1:0'), 'ArrowDown');
  assert.equal(rig.state.commits.length, before, 'wrong-axis arrow is ignored');
  const min = model.minExtent(rig.state.layout.root.children[0].node, 'row', 1);
  rig.key(rig.sash('split-1:0'), 'Home');
  assert.equal(sizeOf(rig.state.layout, 'split-1', 0), min);
  assert.equal(rig.q('[data-wb-cell="split-1:0"]').style.flex, '0 0 ' + min + 'px');
  rig.key(rig.sash('split-1:0'), 'ArrowLeft');
  assert.equal(sizeOf(rig.state.layout, 'split-1', 0), min, 'cannot shrink below the minimum');
  rig.key(rig.sash('split-1:0'), 'End');
  assert.equal(sizeOf(rig.state.layout, 'split-1', 0), min + 400);
});

test('sash keyboard mirrors under rtl and for a fixed cell after the sash', () => {
  const rtl = setup({ rtl: true });
  rtl.key(rtl.sash('split-1:0'), 'ArrowRight');
  assert.equal(sizeOf(rtl.state.layout, 'split-1', 0), 284);

  const rig = setup({ layout: model.revealView(model.createDefaultLayout(), 'chat') });
  const sash = rig.sash('split-1:1');
  assert.ok(sash, 'sash beside the open dock');
  rig.key(sash, 'ArrowRight');
  assert.equal(sizeOf(rig.state.layout, 'split-1', 2), 364, 'moving the sash right shrinks the cell after it');
  rig.key(rig.sash('split-1:1'), 'ArrowLeft');
  assert.equal(sizeOf(rig.state.layout, 'split-1', 2), 380);

  const col = setup({ layout: twoBottomLayout() });
  col.key(col.sash('c:0'), 'ArrowUp');
  assert.equal(sizeOf(col.state.layout, 'c', 1), 216, 'col split: up grows the cell below');
  col.key(col.sash('c:1'), 'ArrowDown');
  assert.equal(sizeOf(col.state.layout, 'c', 1), 232, 'both fixed: the cell before the sash grows');
  assert.equal(sizeOf(col.state.layout, 'c', 2), 150);
  assert.equal(col.sash('c:0').getAttribute('aria-orientation'), 'horizontal');
});

test('sash pointer drag previews live and commits once on pointerup', () => {
  const rig = setup();
  const cell = rig.q('[data-wb-cell="split-1:0"]');
  pointer(rig, rig.sash('split-1:0'), 'pointerdown', 300);
  assert.equal(rig.sash('split-1:0').getAttribute('data-dragging'), 'true');
  pointer(rig, null, 'pointermove', 350);
  assert.equal(cell.style.flex, '0 0 350px');
  pointer(rig, null, 'pointermove', 420);
  assert.equal(cell.style.flex, '0 0 420px');
  assert.equal(rig.state.commits.length, 0, 'no commit while dragging');
  pointer(rig, null, 'pointerup', 420);
  assert.equal(rig.state.commits.length, 1);
  assert.equal(sizeOf(rig.state.layout, 'split-1', 0), 420);
  assert.equal(rig.sash('split-1:0').getAttribute('data-dragging'), null);
  pointer(rig, null, 'pointermove', 900);
  pointer(rig, null, 'pointerup', 900);
  assert.equal(rig.state.commits.length, 1, 'listeners are gone after the drag');
});

test('bottom sash preview and keyboard stay within the solved half-column cap', (t) => {
  for (const height of [800, 801]) {
    const rig = setup({ layout: model.revealView(model.createDefaultLayout(), 'terminal') });
    t.after(() => { rig.wb.dispose(); rig.win.close(); });
    rig.rootEl.getBoundingClientRect = () => ({ width: 1200, height });
    rig.wb.render();
    const cap = Math.floor(model.BOTTOM_MAX_RATIO * height);
    const cell = () => rig.q('[data-wb-cell="split-2:1"]');
    pointer(rig, rig.sash('split-2:0'), 'pointerdown', 0, 500);
    pointer(rig, null, 'pointermove', 0, -1000);
    assert.equal(cell().style.flex, `0 0 ${cap}px`, 'preview stops at the solver cap');
    assert.equal(rig.state.commits.length, 0);
    pointer(rig, null, 'pointerup', 0, -1000);
    assert.equal(sizeOf(rig.state.layout, 'split-2', 1), cap);
    assert.equal(cell().style.flex, `0 0 ${cap}px`, 'release preserves the preview size');
    assert.equal(rig.state.rendered.at(-1).solved.sizes['stack-2'], cap);
    rig.key(rig.sash('split-2:0'), 'Home');
    rig.key(rig.sash('split-2:0'), 'End');
    rig.key(rig.sash('split-2:0'), 'ArrowUp');
    assert.equal(sizeOf(rig.state.layout, 'split-2', 1), cap, 'keyboard commits are capped too');
    assert.equal(rig.sash('split-2:0').getAttribute('aria-valuemax'), String(cap));
  }
});

test('fractional-height bottom sash keyboard End commits the solver cap of 400', (t) => {
  const rig = setup({ layout: model.revealView(model.createDefaultLayout(), 'terminal') });
  t.after(() => { rig.wb.dispose(); rig.win.close(); });
  rig.rootEl.getBoundingClientRect = () => ({ width: 1200, height: 801.75 });
  rig.wb.render();
  rig.key(rig.sash('split-2:0'), 'End');
  assert.equal(sizeOf(rig.state.layout, 'split-2', 1), 400);
  assert.equal(rig.q('[data-wb-cell="split-2:1"]').style.flex, '0 0 400px');
  assert.equal(rig.state.rendered.at(-1).solved.sizes['stack-2'], 400);
  assert.equal(rig.sash('split-2:0').getAttribute('aria-valuemax'), '400');
});

test('fractional-height bottom sash pointer preview and release agree at 400', (t) => {
  const rig = setup({ layout: model.revealView(model.createDefaultLayout(), 'terminal') });
  t.after(() => { rig.wb.dispose(); rig.win.close(); });
  rig.rootEl.getBoundingClientRect = () => ({ width: 1200, height: 801.75 });
  rig.wb.render();
  const cell = () => rig.q('[data-wb-cell="split-2:1"]');
  pointer(rig, rig.sash('split-2:0'), 'pointerdown', 0, 500);
  pointer(rig, null, 'pointermove', 0, -1000);
  assert.equal(cell().style.flex, '0 0 400px');
  assert.equal(rig.state.commits.length, 0);
  assert.equal(rig.sash('split-2:0').getAttribute('aria-valuemax'), '400');
  pointer(rig, null, 'pointerup', 0, -1000);
  assert.equal(rig.state.commits.length, 1);
  assert.equal(sizeOf(rig.state.layout, 'split-2', 1), 400);
  assert.equal(cell().style.flex, '0 0 400px');
  assert.equal(rig.state.rendered.at(-1).solved.sizes['stack-2'], 400);
  assert.equal(rig.sash('split-2:0').getAttribute('aria-valuemax'), '400');
});

test('sash pointer drag clamps, ignores a click without movement and cancels cleanly', () => {
  const rig = setup();
  const cell = () => rig.q('[data-wb-cell="split-1:0"]');
  pointer(rig, rig.sash('split-1:0'), 'pointerdown', 300);
  pointer(rig, null, 'pointerup', 300);
  assert.equal(rig.state.commits.length, 0);

  const min = model.minExtent(rig.state.layout.root.children[0].node, 'row', 1);
  pointer(rig, rig.sash('split-1:0'), 'pointerdown', 300);
  pointer(rig, null, 'pointermove', -5000);
  assert.equal(cell().style.flex, '0 0 ' + min + 'px');
  pointer(rig, null, 'pointercancel', 0);
  assert.equal(cell().style.flex, '0 0 300px', 'cancel restores the preview');
  pointer(rig, null, 'pointerup', 0);
  assert.equal(rig.state.commits.length, 0);

  const right = setup({ layout: model.revealView(model.createDefaultLayout(), 'chat') });
  pointer(right, right.sash('split-1:1'), 'pointerdown', 700);
  pointer(right, null, 'pointermove', 640);
  pointer(right, null, 'pointerup', 640);
  assert.equal(sizeOf(right.state.layout, 'split-1', 2), 440, 'dragging left grows the cell after the sash');
});

test('sash resizes the right persisted cell when an earlier cell is pruned away', () => {
  const rig = setup({ layout: model.revealView(model.createDefaultLayout(), 'chat'), unavailable: ['explorer', 'search', 'source-control'] });
  assert.equal(rig.stackEl('stack-1'), null);
  rig.key(rig.sash('split-1:0'), 'ArrowLeft');
  assert.equal(sizeOf(rig.state.layout, 'split-1', 0), 300, 'rail untouched');
  assert.equal(sizeOf(rig.state.layout, 'split-1', 2), 396, 'dock resized by its persisted index');
});

test('More menu: moves per edge, disables the current edge, resets to the default', () => {
  const rig = setup();
  rig.click(rig.action('stack-1', 'more'));
  assert.equal(rig.state.menus.length, 1);
  const menu = rig.state.menus[0];
  assert.equal(menu.anchorEl, rig.action('stack-1', 'more'));
  assert.deepEqual(
    menu.items.map((i) => i.label || 'sep'),
    ['Move next to Terminal', 'Move next to Chat', 'sep', 'Move to left side', 'Move to right side', 'Move to bottom', 'sep', 'Reset layout'],
  );
  assert.equal(menu.items[3].disabled, true);
  assert.equal(menu.items[4].disabled, false);
  assert.equal(menu.items[2].separator, true);
  assert.equal(menu.items[6].separator, true);

  menu.items[4].action();
  const lastRight = rig.state.layout.root.children.at(-1).node;
  assert.ok(lastRight.views.includes('explorer'));
  assert.ok(ops.isLayoutEqual(rig.state.layout, ops.moveView(model.createDefaultLayout(), 'explorer', { edge: 'right' })));
  assert.equal(rig.wb.getActiveView('explorer'), 'explorer');

  menu.items[7].action();
  assert.ok(ops.isLayoutEqual(rig.state.layout, model.createDefaultLayout()));

  rig.click(rig.action('stack-2', 'more'));
  const bottom = rig.state.menus.at(-1).items;
  const row = (label) => bottom.find((i) => i.label === label);
  assert.equal(bottom[0].label, 'Move next to Explorer', 'the own stack is excluded');
  assert.equal(row('Move to bottom').disabled, true, 'bottom stack is already at the bottom');
  assert.equal(row('Move to left side').disabled, false);
  row('Move to left side').action();
  const railStack = rig.state.layout.root.children[0].node;
  assert.ok(railStack.views.includes('terminal'), 'joined the left edge stack');
  assert.equal(railStack.active, 'terminal');
});

test('contextmenu on a tab opens the menu for that tab at the pointer', () => {
  const rig = setup();
  const ev = new rig.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 41, clientY: 77 });
  rig.tab('search').dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(rig.state.menus.length, 1);
  assert.equal(rig.state.menus[0].anchorX, 41);
  assert.equal(rig.state.menus[0].anchorY, 77);
  assert.equal(rig.state.menus[0].items.length, 8);
});

test('maximize hides the sibling cells, Restore shows them, and it is never committed', () => {
  const rig = setup({ layout: twoBottomLayout() });
  assert.equal(rig.action('L', 'maximize'), null, 'row stacks cannot maximize');
  rig.click(rig.action('B1', 'maximize'));
  assert.equal(rig.state.commits.length, 0);
  const cells = (id) => Array.from(rig.q('[data-wb-split="c"]').children).filter((c) => c.classList.contains('wb-cell'));
  const [editorCell, b1Cell, b2Cell] = cells();
  assert.equal(editorCell.hidden, true);
  assert.equal(b2Cell.hidden, true);
  assert.equal(b1Cell.hidden, false);
  assert.ok(b1Cell.classList.contains('wb-cell--flex'));
  assert.equal(b1Cell.style.flex, '');
  assert.equal(rig.stackEl('B1').getAttribute('data-state'), 'maximized');
  assert.equal(rig.action('B1', 'maximize').getAttribute('aria-label'), 'Restore panel size');
  assert.equal(rig.qa('[data-wb-split="c"] > .wb-sash').length, 0, 'no sashes while maximized');

  rig.click(rig.action('B1', 'maximize'));
  assert.equal(editorCell.hidden, false);
  assert.equal(b2Cell.hidden, false);
  assert.equal(b1Cell.style.flex, '0 0 200px');
  assert.equal(rig.stackEl('B1').getAttribute('data-state'), 'open');
  assert.equal(rig.action('B1', 'maximize').getAttribute('aria-label'), 'Maximize panel');
  assert.equal(rig.state.commits.length, 0);

  rig.wb.toggleMaximize('B2');
  assert.equal(b1Cell.hidden, true);
  rig.click(rig.action('B2', 'collapse'));
  assert.equal(rig.state.commits.length, 1, 'collapse commits');
  assert.equal(b1Cell.hidden, false, 'collapse ends the maximize');
  assert.equal(editorCell.hidden, false);

  rig.wb.toggleMaximize('B1');
  assert.equal(b2Cell.hidden, true);
  rig.setLayout(ops.moveView(rig.state.layout, 'problems', { edge: 'left' }));
  rig.wb.render();
  assert.equal(rig.qa('.wb-cell[hidden]').length, 0, 'a structure change ends the maximize');
  rig.wb.toggleMaximize('nope');
  assert.equal(rig.qa('.wb-cell[hidden]').length, 0);
});

test('focus safety: collapsing a stack moves focus from its host to the strip button', () => {
  const rig = setup();
  const input = rig.doc.createElement('input');
  rig.wb.hostFor('explorer').appendChild(input);
  input.focus();
  assert.equal(rig.doc.activeElement, input);
  rig.click(rig.action('stack-1', 'collapse'));
  assert.equal(rig.doc.activeElement, rig.strip('explorer'));
  assert.notEqual(rig.doc.activeElement, rig.doc.body);
});

test('focus safety: hiding a bottom view moves focus to its tab; a pruned view falls back to the editor', () => {
  const rig = setup();
  rig.wb.revealView('terminal');
  const input = rig.doc.createElement('input');
  rig.wb.hostFor('terminal').appendChild(input);
  input.focus();
  rig.click(rig.tab('problems'));
  assert.equal(rig.wb.hostFor('terminal').hidden, true);
  assert.equal(rig.doc.activeElement, rig.tab('terminal'));

  const rig2 = setup({ layout: model.revealView(model.createDefaultLayout(), 'chat') });
  const chatInput = rig2.doc.createElement('input');
  rig2.wb.hostFor('chat').appendChild(chatInput);
  chatInput.focus();
  rig2.state.unavailable.add('chat');
  rig2.state.unavailable.add('changes');
  rig2.wb.render();
  assert.equal(rig2.state.editorFocus, 1, 'no tab or strip left: the editor takes focus');
});

test('focus safety: a rebuild keeps focus in a surviving host and in the editor', () => {
  const rig = setup();
  const input = rig.doc.createElement('input');
  rig.wb.hostFor('explorer').appendChild(input);
  input.focus();
  rig.setLayout(ops.moveView(rig.state.layout, 'explorer', { edge: 'right' }));
  rig.wb.render();
  assert.equal(rig.state.rendered.at(-1).rebuilt, true);
  assert.equal(rig.doc.activeElement, input);

  const main = rig.doc.getElementById('mainInput');
  main.focus();
  rig.setLayout(ops.moveView(rig.state.layout, 'terminal', { edge: 'left' }));
  rig.wb.render();
  assert.equal(rig.doc.activeElement, main);
});

test('focus safety: a collapsed sash neighbour hands focus to the editor', () => {
  const rig = setup();
  rig.sash('split-1:0').focus();
  rig.click(rig.action('stack-1', 'collapse'));
  assert.equal(rig.state.editorFocus, 1);
});

test('revealView commits, optionally focuses into the host; toggleViewStack and collapseStackOf commit', () => {
  const rig = setup();
  const input = rig.doc.createElement('input');
  rig.wb.hostFor('chat').appendChild(input);
  assert.equal(rig.wb.revealView('chat', { focus: true }), true);
  assert.equal(rig.state.layout.root.children[2].node.collapsed, false);
  assert.equal(rig.doc.activeElement, input);

  const rig2 = setup();
  rig2.wb.revealView('search', { focus: true });
  assert.equal(rig2.doc.activeElement, rig2.wb.hostFor('search'), 'host itself when nothing inside is focusable');
  rig2.wb.toggleViewStack('search');
  assert.equal(rig2.state.layout.root.children[0].node.collapsed, true);
  rig2.wb.toggleViewStack('search');
  assert.equal(rig2.state.layout.root.children[0].node.collapsed, false);
  rig2.wb.collapseStackOf('source-control');
  assert.equal(rig2.state.layout.root.children[0].node.collapsed, true);
  assert.equal(rig2.wb.isViewVisible('search'), false);

  const rig3 = setup({ unavailable: ['chat'] });
  assert.equal(rig3.wb.revealView('chat'), false, 'unavailable views are not revealed');
  assert.equal(rig3.state.commits.length, 0);
});

test('dispose removes the listeners; later clicks and keys do not commit, hosts stay', () => {
  const rig = setup();
  const host = rig.wb.hostFor('explorer');
  rig.wb.dispose();
  rig.click(rig.tab('search'));
  rig.click(rig.action('stack-1', 'collapse'));
  rig.key(rig.sash('split-1:0'), 'ArrowRight');
  pointer(rig, rig.sash('split-1:0'), 'pointerdown', 300);
  pointer(rig, null, 'pointermove', 400);
  pointer(rig, null, 'pointerup', 400);
  assert.equal(rig.state.commits.length, 0);
  assert.equal(host.isConnected, true);
  const renders = rig.state.rendered.length;
  rig.wb.render();
  assert.equal(rig.state.rendered.length, renders, 'render after dispose is a no-op');
});

test('focusin inside a stack records recency that steers folding', () => {
  const rig = setup({ layout: model.revealView(model.createDefaultLayout(), 'chat') });
  rig.rootEl.getBoundingClientRect = () => ({ width: 800, height: 500, top: 0, left: 0, right: 800, bottom: 500 });
  const rail = rig.doc.createElement('input');
  rig.wb.hostFor('explorer').appendChild(rail);
  rail.focus();
  rig.wb.render();
  assert.deepEqual(rig.state.rendered.at(-1).solved.folded, ['stack-3'], 'the stack that just had focus survives; the dock folds');
  const dockInput = rig.doc.createElement('input');
  rig.wb.hostFor('chat').appendChild(dockInput);
  dockInput.focus();
  rig.wb.render();
  assert.deepEqual(rig.state.rendered.at(-1).solved.folded, ['stack-1']);
});
