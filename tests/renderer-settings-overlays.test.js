'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSettingsOverlayRenderer } = require('../renderer/shell/renderer-settings-overlays');

test('settings overlays expose composer surfaces without the removed auth overlay API', () => {
  const renderer = createSettingsOverlayRenderer({
    state: { ui: { composerPopoverOpen: false, commandPopoverOpen: false } },
    windowRef: {},
    dom: {},
  });

  assert.equal(typeof renderer.renderComposerPopover, 'function');
  assert.equal(typeof renderer.renderCommandPopover, 'function');
  assert.equal('renderAuthOverlay' in renderer, false);

  renderer.dispose();
  renderer.dispose();
});
