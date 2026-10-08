'use strict';

const assert = require('node:assert/strict');

const model = require('../../renderer/shared/workbench-layout-model');

const { VIEW_CATALOG, SIZE_MAX, MAX_EDITOR_GROUPS, findView, findStack } = model;

const LEFT = ['explorer', 'search', 'source-control'];
const BOTTOM = ['terminal', 'problems', 'run', 'test-runner', 'test-output'];
const CHAT = ['chat', 'changes'];
const ALL_VIEWS = Object.keys(VIEW_CATALOG);

function shape(node) {
  if (node.t === 'split') {
    return `${node.dir}(${node.children.map((c) => shape(c.node)).join(',')})`;
  }
  if (node.kind === 'editor') return 'E';
  return `${node.views.join('+')}${node.collapsed ? '!' : ''}`;
}

function collectNodes(node, out = []) {
  out.push(node);
  if (node.t === 'split') node.children.forEach((c) => collectNodes(c.node, out));
  return out;
}

function stackOf(layout, viewId) {
  return findStack(layout, findView(layout, viewId).stackId);
}

function sizeEntry(layout, nodeId) {
  let found = null;
  collectNodes(layout.root).forEach((n) => {
    if (n.t === 'split') {
      n.children.forEach((c) => {
        if (c.node.id === nodeId) found = c;
      });
    }
  });
  return found;
}

function stk(id, views, extra = {}) {
  return {
    t: 'stack',
    id,
    kind: 'views',
    views: views.slice(),
    active: extra.active === undefined ? views[0] || null : extra.active,
    collapsed: extra.collapsed === true,
  };
}

function editor(id = 'editor-1') {
  return { t: 'stack', id, kind: 'editor', views: [], active: null, collapsed: false };
}

function spl(id, dir, ...children) {
  return { t: 'split', id, dir, children };
}

function ch(node, size = null) {
  return { node, size };
}

function assertValid(layout) {
  assert.equal(layout.v, 1);
  const ids = new Set();
  const views = [];
  let editors = 0;
  let count = 0;
  (function walk(node, depth) {
    count += 1;
    assert.ok(depth <= 6, 'depth');
    assert.equal(typeof node.id, 'string');
    assert.ok(node.id.length > 0);
    assert.ok(!ids.has(node.id), `duplicate id ${node.id}`);
    ids.add(node.id);
    if (node.t === 'split') {
      assert.ok(node.dir === 'row' || node.dir === 'col');
      assert.ok(node.children.length >= 2, 'split has >= 2 children');
      const flex = node.children.filter((c) => c.size === null);
      assert.equal(flex.length, 1, 'exactly one flexible child');
      node.children.forEach((c) => {
        if (c.size !== null) {
          assert.ok(Number.isInteger(c.size));
          assert.ok(c.size >= 0 && c.size <= SIZE_MAX);
        }
        walk(c.node, depth + 1);
      });
      return;
    }
    assert.equal(node.t, 'stack');
    assert.equal(typeof node.collapsed, 'boolean');
    if (node.kind === 'editor') {
      editors += 1;
      assert.deepEqual(node.views, []);
      assert.equal(node.active, null);
    } else {
      assert.equal(node.kind, 'views');
      assert.ok(node.views.length > 0);
      assert.ok(node.views.includes(node.active));
      views.push(...node.views);
    }
  })(layout.root, 1);
  assert.ok(editors >= 1 && editors <= MAX_EDITOR_GROUPS);
  assert.ok(count <= 64);
  assert.deepEqual([...views].sort(), [...ALL_VIEWS].sort(), 'every catalog view exactly once');
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = {
  LEFT,
  BOTTOM,
  CHAT,
  ALL_VIEWS,
  shape,
  collectNodes,
  stackOf,
  sizeEntry,
  stk,
  editor,
  spl,
  ch,
  assertValid,
  mulberry32,
};
