'use strict';

const { JSDOM } = require('jsdom');

const selectField = require('../../renderer/inventory/select-field');
const toggleSwitchModule = require('../../renderer/inventory/toggle-switch');
const actionButton = require('../../renderer/inventory/action-button');
const ideState = require('../../renderer/features/renderer-ide-state');

// The section reaches inventory primitives + the ide-state module via globals,
// exactly as the loaded renderer scripts expose them.
// Mirror the PRODUCTION global shape exactly (renderer/inventory/index.js): the
// standalone inventorySelectField is the function, inventoryToggleSwitch is the
// MODULE OBJECT, and the barrel globalThis.inventory exposes BOTH primitives as
// render functions (selectField, plus toggleSwitch unwrapped from its module).
function withGlobals(run) {
  const prevWindow = globalThis.window;
  const prevInventory = globalThis.inventory;
  const prevSelectField = globalThis.inventorySelectField;
  const prevToggleSwitch = globalThis.inventoryToggleSwitch;
  const prevActionButton = globalThis.inventoryActionButton;
  const prevIdeState = globalThis.rendererIdeState;
  globalThis.inventorySelectField = selectField;
  globalThis.inventoryToggleSwitch = toggleSwitchModule;
  globalThis.inventoryActionButton = actionButton;
  globalThis.inventory = { selectField, toggleSwitch: toggleSwitchModule.toggleSwitch, actionButton };
  globalThis.rendererIdeState = ideState;
  try {
    return run();
  } finally {
    globalThis.window = prevWindow;
    globalThis.inventory = prevInventory;
    globalThis.inventorySelectField = prevSelectField;
    globalThis.inventoryToggleSwitch = prevToggleSwitch;
    globalThis.inventoryActionButton = prevActionButton;
    globalThis.rendererIdeState = prevIdeState;
  }
}

function makeContainer() {
  const dom = new JSDOM('<div id="host"></div>');
  return { dom, container: dom.window.document.getElementById('host') };
}

// Async-aware variant of withGlobals: awaits the run() promise before restoring
// the globals (the sync withGlobals would restore mid-flight for async bodies).
async function withGlobalsAsync(run) {
  const prevWindow = globalThis.window;
  const prevInventory = globalThis.inventory;
  const prevSelectField = globalThis.inventorySelectField;
  const prevToggleSwitch = globalThis.inventoryToggleSwitch;
  const prevActionButton = globalThis.inventoryActionButton;
  const prevIdeState = globalThis.rendererIdeState;
  globalThis.inventorySelectField = selectField;
  globalThis.inventoryToggleSwitch = toggleSwitchModule;
  globalThis.inventoryActionButton = actionButton;
  globalThis.inventory = { selectField, toggleSwitch: toggleSwitchModule.toggleSwitch, actionButton };
  globalThis.rendererIdeState = ideState;
  try {
    return await run();
  } finally {
    globalThis.window = prevWindow;
    globalThis.inventory = prevInventory;
    globalThis.inventorySelectField = prevSelectField;
    globalThis.inventoryToggleSwitch = prevToggleSwitch;
    globalThis.inventoryActionButton = prevActionButton;
    globalThis.rendererIdeState = prevIdeState;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const listen = (target, event, handler, options) => { target.addEventListener(event, handler, options); return true; };

module.exports = { withGlobals, withGlobalsAsync, makeContainer, flush, listen };
