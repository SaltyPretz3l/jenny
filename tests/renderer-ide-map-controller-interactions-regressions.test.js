'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createContentInteractions } = require('../renderer/features/renderer-ide-map-controller-utils');

function baseDeps(overrides = {}) {
  return {
    view: { hitTest: () => null },
    transform: { clientToContent: ({ x, y }) => ({ x, y }) },
    viewportEl: { classList: { contains: () => false } },
    timers: { setTimeout: () => 1, clearTimeout: () => {} },
    onOpenFile: () => {},
    zoomToDistrict: () => {},
    selectNode: () => {},
    getLastBounds: () => null,
    isBlastActive: () => false,
    isActive: () => true,
    hasSelection: () => false,
    clearSelection: () => {},
    clearBlast: () => {},
    exitToEditor: () => {},
    ...overrides,
  };
}

test('a completed drag click cannot suppress a later keyboard-generated node click', () => {
  const opened = [];
  const interactions = createContentInteractions(baseDeps({ onOpenFile: (id) => opened.push(id) }));
  const blankTarget = { closest: () => null };
  const nodeEl = { dataset: { mapNode: 'src/a.js' } };
  const nodeTarget = { closest: (selector) => (selector.includes('[data-map-node]') ? nodeEl : null) };

  interactions.handlePointerDown({ clientX: 100, clientY: 100 });
  interactions.handleClick({ clientX: 0, clientY: 0, target: blankTarget });
  interactions.handleClick({ clientX: 0, clientY: 0, target: nodeTarget });

  assert.deepEqual(opened, ['src/a.js']);
});

test('pointer leave cancels a pending throttled hit test before clearing hover', () => {
  const pending = new Map();
  const hover = [];
  const selected = [];
  const timers = {
    setTimeout(fn) { pending.set(1, fn); return 1; },
    clearTimeout(id) { pending.delete(id); },
  };
  const interactions = createContentInteractions(baseDeps({
    timers,
    view: { hitTest: () => ({ kind: 'node', id: 'src/a.js' }), setHover: (id) => hover.push(id) },
    selectNode: (id) => selected.push(id),
  }));

  interactions.handlePointerMove({ clientX: 5, clientY: 6, target: { closest: () => null } });
  interactions.handlePointerLeave();
  for (const callback of pending.values()) callback();

  assert.equal(pending.size, 0);
  assert.deepEqual(hover, [null]);
  assert.deepEqual(selected, [null]);
});
