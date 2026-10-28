'use strict';

/* Workbench sash: the drag clamp reads the font scale once per drag (resolve at
 * pointerdown), never per pointermove (getComputedStyle each frame). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSashTargets, createSash } = require('../renderer/features/renderer-ide-workbench-sash');

function setup() {
  const calls = { fontScale: 0 };
  const split = { t: 'split', id: 's1', dir: 'row', children: [{ node: { id: 'a' }, size: 200 }, { node: { id: 'b' }, size: null }] };
  const cell = { style: {}, getBoundingClientRect: () => ({ width: 200, height: 100 }) };
  const rendered = {
    usable: true,
    idx: { nodes: new Map([['s1', { node: split }]]) },
    refs: { splits: new Map([['s1', { cells: [cell, { style: {} }] }]]) },
    solved: { sizes: { a: 200, b: 600 } },
  };
  const targets = createSashTargets({
    model: { minExtent: (_node, _dir, scale) => 100 * scale, SIZE_MAX: 5000, BOTTOM_MAX_RATIO: 0.8 },
    getRendered: () => rendered,
    getFontScale: () => { calls.fontScale += 1; return 1.5; },
  });
  const sashEl = { getAttribute: () => 's1:0' };
  return { calls, targets, sashEl, cell };
}

test('clamp uses the min resolved at drag start instead of re-reading the font scale', () => {
  const { calls, targets, sashEl } = setup();
  const target = targets.resolve(sashEl);
  const afterResolve = calls.fontScale;
  assert.ok(afterResolve >= 1);
  for (let i = 0; i < 5; i += 1) assert.equal(targets.clamp(target.node, target.dir, 10, target), 150);
  assert.equal(targets.clamp(target.node, target.dir, 9999, target), target.maxPx);
  assert.equal(calls.fontScale, afterResolve, 'no font-scale read per pointermove');
  assert.equal(targets.clamp(target.node, target.dir, 10), 150, 'a target-less clamp still computes its floor');
});

test('a pointer drag reads the font scale only at pointerdown', () => {
  const { calls, targets, sashEl, cell } = setup();
  const listeners = {};
  const win = { addEventListener: (type, fn) => { listeners[type] = fn; }, removeEventListener: (type) => { delete listeners[type]; } };
  const el = { ...sashEl, ownerDocument: { defaultView: win }, closest: (sel) => (sel === '[data-wb-sash]' ? el : null), setAttribute() {}, removeAttribute() {} };
  const commits = [];
  const sash = createSash({ resolve: targets.resolve, clamp: targets.clamp, commit: (...args) => commits.push(args) });
  sash.onPointerDown({ button: 0, target: el, clientX: 0, preventDefault() {} });
  const afterDown = calls.fontScale;
  for (const x of [5, 20, -500, 40]) listeners.pointermove({ clientX: x });
  assert.equal(cell.style.flex, '0 0 240px');
  assert.equal(calls.fontScale, afterDown);
  listeners.pointerup({});
  assert.deepEqual(commits, [['s1', 'a', 240]]);
});
