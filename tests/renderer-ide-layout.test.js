'use strict';

/* Workspace IDE layout orchestration (the "Move View" model, CONFIG_VERSION 28).
 * render() applies the rail geometry, repaints the activity bar, then renders all
 * four panels unconditionally - each panel is a SINGLE instance that self-targets
 * its host (getMountEl from its location) and self-gates (isActivePanel), so the
 * layout no longer decides which panel goes to which host. It then renders the
 * secondary-sidebar chrome (when injected) + the bottom panel. Plain stubs. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  CHAT_DOCK_VIEWPORT_RATIO,
  computeViewportWidthLimits,
  createIdeLayout,
} = require('../renderer/features/renderer-ide-layout');

function makeShellStub() {
  const props = {};
  return {
    dataset: {},
    style: {
      getPropertyValue: (key) => props[key] || '',
      setProperty: (key, value) => { props[key] = value; },
    },
  };
}

function setup(opts = {}) {
  const calls = {
    activityBar: 0, explorer: 0, search: 0, changes: 0, sourceControl: 0,
    bottomRender: 0, secondaryRender: 0,
  };
  const ide = { railSide: 'left', railWidth: 300, railPanel: 'explorer' };
  const dom = {
    ideShell: makeShellStub(),
    ideRailPanel: { innerHTML: '' },
    ideSecondarySidebarPanel: { innerHTML: '' },
  };
  const secondarySidebar = opts.withSidebar === false ? undefined : {
    render: () => { calls.secondaryRender += 1; },
  };
  const layout = createIdeLayout({
    getDom: () => dom,
    getIde: () => ide,
    renderActivityBar: () => { calls.activityBar += 1; },
    renderExplorer: () => { calls.explorer += 1; },
    renderSearch: () => { calls.search += 1; },
    renderChanges: () => { calls.changes += 1; },
    renderSourceControl: () => { calls.sourceControl += 1; },
    bottomPanel: { render: () => { calls.bottomRender += 1; } },
    secondarySidebar,
  });
  return { layout, calls, ide, dom };
}

test('render() renders every panel once - host targeting is the panels\' own concern', () => {
  const h = setup();
  h.layout.render();
  // All four run unconditionally; each self-targets via getMountEl + self-gates
  // via isActivePanel (the layout owns no which-panel-where logic anymore).
  assert.equal(h.calls.explorer, 1);
  assert.equal(h.calls.search, 1);
  assert.equal(h.calls.changes, 1);
  assert.equal(h.calls.sourceControl, 1);
  assert.equal(h.calls.activityBar, 1, 'activity bar repainted');
  assert.equal(h.calls.secondaryRender, 1, 'secondary chrome rendered');
  assert.equal(h.calls.bottomRender, 1, 'bottom panel rendered');
});

test('render() applies the rail geometry (side + width) to the shell', () => {
  const h = setup();
  h.ide.railSide = 'right';
  h.ide.railWidth = 333;
  h.layout.render();
  assert.equal(h.dom.ideShell.dataset.railSide, 'right');
  assert.equal(h.dom.ideShell.style.getPropertyValue('--ide-rail-width'), '333px');
});

test('render() is safe when no secondary sidebar instance is injected', () => {
  const h = setup({ withSidebar: false });
  assert.doesNotThrow(() => h.layout.render());
  assert.equal(h.calls.secondaryRender, 0);
  // The rest of the layout still runs.
  assert.equal(h.calls.explorer, 1);
  assert.equal(h.calls.bottomRender, 1);
});

test('viewport limits cap the chat dock at 65% while preserving rails and editor floor', () => {
  const limits = computeViewportWidthLimits({
    railWidth: 300,
    secondaryPanelOpen: false,
    chatDockOpen: true,
    chatDockWidth: 2000,
  }, 2000);
  assert.equal(CHAT_DOCK_VIEWPORT_RATIO, 0.65);
  assert.equal(limits.chatDockMax, 1300, '65% is tighter than remaining horizontal budget');

  const railBound = computeViewportWidthLimits({
    railWidth: 500,
    secondaryPanelOpen: true,
    secondaryWidth: 300,
    chatDockOpen: true,
    chatDockWidth: 2000,
  }, 1440);
  assert.equal(railBound.chatDockMax, 280, 'static dock floor applies when rails consume the budget');
});

test('display-only dock clamp leaves the persisted requested width untouched', () => {
  const ide = {
    railWidth: 300,
    secondaryPanelOpen: false,
    chatDockOpen: true,
    chatDockWidth: 1800,
  };
  const limits = computeViewportWidthLimits(ide, 1440);
  assert.equal(limits.chatDockMax, 780);
  assert.equal(ide.chatDockWidth, 1800, 'viewport calculation never mutates persistence state');
});
