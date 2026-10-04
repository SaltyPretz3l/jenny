'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const toggleSwitchModule = require('../renderer/inventory/toggle-switch');

function render(options) {
  const dom = new JSDOM(`<!doctype html><body>${toggleSwitchModule.toggleSwitch({ id: 'demo', label: 'Demo', ...options })}</body>`);
  const track = dom.window.document.querySelector('[data-inv-toggle="demo"]');
  return { dom, track, wrapper: track.closest('label.inv-toggle') };
}

test('setDisabled moves a switch between enabled and disabled in place without an event', () => {
  const { track, wrapper } = render({ checked: true });
  let events = 0;
  track.addEventListener('inv-toggle-change', () => { events += 1; });

  toggleSwitchModule.setDisabled(track, true);
  assert.equal(track.disabled, true);
  assert.equal(track.getAttribute('aria-disabled'), 'true');
  assert.equal(wrapper.getAttribute('aria-disabled'), 'true');
  assert.ok(wrapper.classList.contains('inv-toggle--disabled'));

  toggleSwitchModule.setDisabled(track, false);
  assert.equal(track.disabled, false);
  assert.equal(track.hasAttribute('aria-disabled'), false);
  assert.equal(wrapper.hasAttribute('aria-disabled'), false);
  assert.equal(wrapper.classList.contains('inv-toggle--disabled'), false);
  assert.equal(track.getAttribute('aria-checked'), 'true', 'the checked state is untouched');
  assert.equal(events, 0);
});

test('setDisabled lifts the disabled state a switch was rendered with', () => {
  const { track, wrapper } = render({ disabled: true });
  toggleSwitchModule.setDisabled(track, false);
  assert.equal(track.disabled, false);
  assert.equal(track.hasAttribute('aria-disabled'), false);
  assert.equal(wrapper.hasAttribute('aria-disabled'), false);
  assert.equal(wrapper.classList.contains('inv-toggle--disabled'), false);
  assert.doesNotThrow(() => toggleSwitchModule.setDisabled(null, true));
});

test('the inventory barrel exposes setDisabled on the toggle switch renderer', () => {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['toggle-switch.js', 'index.js']) {
    dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'inventory', file), 'utf8'));
  }
  assert.equal(typeof dom.window.inventory.toggleSwitch, 'function');
  assert.equal(typeof dom.window.inventory.toggleSwitch.setDisabled, 'function');
  dom.window.close();
});
