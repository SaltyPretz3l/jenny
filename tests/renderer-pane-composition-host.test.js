'use strict';

/* Split view's second pane stays in #chatView (the Workspace's second chat, row 40 W6b, is retired
 * in row 190): closing it removes its root.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRig, paneRoot } = require('./helpers/pane-composition-rig');

function openedRig(t, options) {
  const rig = createRig(t, options);
  rig.layoutController.openBeside('b');
  const root = paneRoot(rig.chatView, 1);
  return { rig, root };
}

test('the pane session ids are exposed per pane; closing a pane removes its root', (t) => {
  const { rig, root } = openedRig(t);
  assert.equal(rig.composition.getPaneSessionId(1), 'b');
  assert.equal(typeof rig.composition.getPaneSessionId(0), 'string');
  rig.layoutController.closePane(1);
  assert.equal(root.isConnected, false);
  assert.equal(rig.composition.getPaneSessionId(1), '');
});
