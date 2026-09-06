const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const askConfig = require('../renderer/features/renderer-dashboard-ask-config.js');
const actionButton = require('../renderer/inventory/action-button.js');
const popover = require('../renderer/inventory/popover.js');
const selectField = require('../renderer/inventory/select-field.js');
const toggleSwitchModule = require('../renderer/inventory/toggle-switch.js');

function inventory() {
  const toggleSwitch = toggleSwitchModule.toggleSwitch;
  toggleSwitch.toggle = toggleSwitchModule.toggle;
  toggleSwitch.setChecked = toggleSwitchModule.setChecked;
  toggleSwitch.initToggleHandlers = toggleSwitchModule.initToggleHandlers;
  return { actionButton, popover, selectField, toggleSwitch };
}

test('an open ask popover refreshes its model catalog after the TTL without remounting', async () => {
  const dom = new JSDOM('<div id="ask"><div class="home-ask__meta"></div></div>');
  const documentRef = dom.window.document;
  const region = documentRef.getElementById('ask');
  let now = 1000;
  let listCalls = 0;
  const controller = askConfig.createAskConfigController({
    documentRef,
    shell: {
      models: {
        list: async () => {
          listCalls += 1;
          return { data: [{ id: listCalls === 1 ? 'first-model' : 'second-model' }] };
        },
      },
    },
    getState: () => ({ features: { tools: {} } }),
    inventory: inventory(),
    nowMs: () => now,
  });

  const chip = controller.ensure(region);
  await new Promise((resolve) => setImmediate(resolve));
  chip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const select = region.querySelector('[data-ask-config="model"]');
  assert.ok(select);
  assert.equal(listCalls, 1);

  now += 30001;
  assert.equal(controller.ensure(region), chip);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(listCalls, 2);
  assert.equal(region.querySelector('[data-ask-config="model"]'), select);
  controller.dispose();
});
