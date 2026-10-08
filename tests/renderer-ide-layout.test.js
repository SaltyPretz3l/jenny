'use strict';

/* Workspace IDE render fan-out (row 40 W3). render() reconciles the workbench first
 * (so every view host and visibility gate is current), then calls every panel renderer
 * unconditionally - each panel is a single instance that self-targets its own host
 * (getMountEl) and self-gates (isActivePanel) - and the chat dock last. The layout
 * owns no geometry: widths, heights and folding belong to the model's solver. Plain
 * stubs. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { PANEL_RENDERERS, createIdeLayout } = require('../renderer/features/renderer-ide-layout');

function setup(opts = {}) {
  const order = [];
  const deps = {};
  if (opts.withWorkbench !== false) deps.workbenchWiring = { render: () => order.push('workbench') };
  for (const name of PANEL_RENDERERS) {
    if (opts.omit?.includes(name)) continue;
    deps[name] = () => order.push(name);
  }
  if (opts.withDock !== false) deps.chatDock = { render: () => order.push('dock') };
  return { layout: createIdeLayout(deps), order };
}

test('PANEL_RENDERERS lists every view panel exactly once', () => {
  assert.deepEqual([...PANEL_RENDERERS], [
    'renderExplorer', 'renderSearch', 'renderSourceControl',
    'renderTerminal', 'renderProblems', 'renderRun', 'renderTestRunner', 'renderTestOutput',
  ]);
});

test('render() reconciles the workbench first, then every panel once, then the dock last', () => {
  const h = setup();
  h.layout.render();
  assert.deepEqual(h.order, ['workbench', ...PANEL_RENDERERS, 'dock']);
});

test('render() is repeatable: every pass fans out to the same calls', () => {
  const h = setup();
  h.layout.render();
  h.layout.render();
  assert.equal(h.order.length, 2 * (PANEL_RENDERERS.length + 2));
  assert.deepEqual(h.order.slice(0, h.order.length / 2), h.order.slice(h.order.length / 2));
});

test('missing panel renderers are no-ops and the rest still render in order', () => {
  const h = setup({ omit: ['renderSearch', 'renderRun'] });
  assert.doesNotThrow(() => h.layout.render());
  assert.deepEqual(h.order, [
    'workbench', 'renderExplorer', 'renderSourceControl', 'renderTerminal', 'renderProblems', 'renderTestRunner', 'renderTestOutput', 'dock',
  ]);
});

test('render() is safe with no workbench wiring or no chat dock injected', () => {
  const noWorkbench = setup({ withWorkbench: false });
  assert.doesNotThrow(() => noWorkbench.layout.render());
  assert.deepEqual(noWorkbench.order, [...PANEL_RENDERERS, 'dock']);

  const noDock = setup({ withDock: false });
  assert.doesNotThrow(() => noDock.layout.render());
  assert.deepEqual(noDock.order, ['workbench', ...PANEL_RENDERERS]);
});

test('render() with no deps at all is a no-op on a render-only API', () => {
  const bare = createIdeLayout();
  assert.deepEqual(Object.keys(bare), ['render'], 'the layout exposes render only (no geometry API)');
  assert.equal(bare.render(), undefined);
  assert.equal(createIdeLayout({}).render(), undefined);
});

test('the retired viewport clamp helpers are no longer exported', () => {
  const exported = require('../renderer/features/renderer-ide-layout');
  assert.equal(exported.computeViewportWidthLimits, undefined);
  assert.equal(exported.CHAT_DOCK_VIEWPORT_RATIO, undefined);
});
