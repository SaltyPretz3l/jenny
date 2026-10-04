'use strict';

/* Split view W2-1 (drag-to-split) -- the workspace chrome's wiring of the
 * rail tab drag to the chat view's drop zones.
 *
 * app.js hands the chrome the pane composition's drop target once the
 * composition exists (`setPaneDropTarget`); the chrome passes the tab drag
 * controller a getter, so a drag resolves whatever target is live when it
 * commits. Without a target the rail drag is the reorder gesture, unchanged.
 * (tests/renderer-workspace-chrome-utils.test.js sits at the size ceiling, so
 * these cases live here.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createWorkspaceChromeController } = require('../renderer/shell/renderer-workspace-chrome-utils');
const tabDragUtils = require('../renderer/shell/renderer-workspace-tab-drag-utils');

function createRig(t) {
  const dom = new JSDOM('<!doctype html><html><body><div id="rail"></div></body></html>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  const previousDragUtils = globalThis.rendererWorkspaceTabDragUtils;
  globalThis.rendererWorkspaceTabDragUtils = tabDragUtils;
  const doc = dom.window.document;
  const reorders = [];
  const controller = createWorkspaceChromeController({
    containerEl: doc.getElementById('rail'),
    isSessionBusy: () => false,
    onSessionActivated() {},
    onSessionReordered: (id, index) => { reorders.push([id, index]); },
  });
  t.after(async () => {
    controller.dispose();
    if (previousDragUtils === undefined) delete globalThis.rendererWorkspaceTabDragUtils;
    else globalThis.rendererWorkspaceTabDragUtils = previousDragUtils;
    delete global.window;
    delete global.document;
    await dom.window.close();
  });
  controller.renderRail(['s1', 's2'], 's1', [{ id: 's1', title: 'Alpha' }, { id: 's2', title: 'Beta' }], [], []);
  const view = doc.createElement('section');
  doc.body.appendChild(view);
  view.getBoundingClientRect = () => ({ left: 0, top: 100, right: 400, bottom: 400, width: 400, height: 300 });
  const hovers = [];
  const drops = [];
  const target = { el: view, onHover: (side) => hovers.push(side), onDrop: (id, side) => drops.push([id, side]) };
  return { dom, doc, controller, reorders, hovers, drops, target };
}

function drag(rig, sessionId, to) {
  const button = rig.doc.querySelector(`[data-workspace-activate="${sessionId}"]`);
  const rail = rig.doc.querySelector('[role="tablist"]');
  // A real drag holds the primary button down until the release (buttons 1, then 0 on pointerup);
  // the rail cancels a move that reports no held button.
  const event = (type, x, y) => new rig.dom.window.PointerEvent(type, { button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 3, clientX: x, clientY: y, bubbles: true });
  button.dispatchEvent(event('pointerdown', 10, 10));
  rail.dispatchEvent(event('pointermove', 80, 10));
  rail.dispatchEvent(event('pointermove', to[0], to[1]));
  rail.dispatchEvent(event('pointerup', to[0], to[1]));
}

test('a pane drop target set on the chrome turns a rail drag onto the view into a drop, never a reorder', async (t) => {
  const rig = createRig(t);
  assert.equal(typeof rig.controller.setPaneDropTarget, 'function');
  rig.controller.setPaneDropTarget(rig.target);

  drag(rig, 's2', [300, 200]);
  await Promise.resolve();

  assert.deepEqual(rig.drops, [['s2', 'right']]);
  assert.deepEqual(rig.hovers, ['right', null]);
  assert.deepEqual(rig.reorders, []);
});

test('without a pane drop target (none yet, or cleared) the rail drag only reorders', async (t) => {
  const rig = createRig(t);
  drag(rig, 's1', [300, 200]);
  await Promise.resolve();
  assert.deepEqual(rig.reorders, [['s1', 1]], 'no composition yet: the reorder gesture');

  rig.controller.setPaneDropTarget(rig.target);
  rig.controller.setPaneDropTarget(null);
  drag(rig, 's1', [300, 200]);
  await Promise.resolve();
  assert.deepEqual(rig.reorders, [['s1', 1], ['s1', 1]]);
  assert.deepEqual(rig.drops, []);
  assert.deepEqual(rig.hovers, []);
});
