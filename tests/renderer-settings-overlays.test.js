'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSettingsOverlayRenderer } = require('../renderer/shell/renderer-settings-overlays');

test('settings overlays expose the + menu popover without the removed auth overlay or Commands popover API', () => {
  const renderer = createSettingsOverlayRenderer({
    state: { ui: { composerPopoverOpen: false } },
    windowRef: {},
    dom: {},
  });

  assert.equal(typeof renderer.renderComposerPopover, 'function');
  assert.equal('renderCommandPopover' in renderer, false);
  assert.equal('renderAuthOverlay' in renderer, false);

  renderer.dispose();
  renderer.dispose();
});
