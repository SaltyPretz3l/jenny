'use strict';

/* Shared jsdom harness for the Limits & budgets page tests. */
const { JSDOM } = require('jsdom');

const {
  createAdvancedTuningSection,
} = require('../../renderer/shell/renderer-settings-advanced-section');
const {
  ENGINE_TUNING_FIELDS,
  ENGINE_TUNING_GROUPS,
} = require('../../renderer/shared/engine-tuning-schema');

const inventory = {
  settingsField: require('../../renderer/inventory/settings-field'),
  numberInput: require('../../renderer/inventory/number-input'),
  segmentedControl: require('../../renderer/inventory/segmented-control'),
  actionButton: require('../../renderer/inventory/action-button'),
  badge: require('../../renderer/inventory/badge'),
  statusRow: require('../../renderer/inventory/status-row'),
};

// loaded: false leaves the section as it is before the first engine state arrives.
function createHarness({ values = {}, activeStream = false, bridge = null, resetLimitsToDefaults, getEngineType, loaded = true } = {}) {
  const dom = new JSDOM(
    '<!doctype html><body>'
    + '<section class="settings-card"><p data-limits-status hidden></p>'
    + '<div id="advancedTuningStatus" hidden></div>'
    + '<div id="advancedTuningFields" data-limits-lines></div>'
    + '<div id="advancedTuningActions"></div>'
    + '</section></body>',
    { pretendToBeVisual: true }
  );
  const documentRef = dom.window.document;
  const sectionDom = {
    advancedTuningStatus: documentRef.getElementById('advancedTuningStatus'),
    advancedTuningFields: documentRef.getElementById('advancedTuningFields'),
    advancedTuningActions: documentRef.getElementById('advancedTuningActions'),
  };
  const calls = [];
  const activeBridge = bridge || {
    getState: async () => ({
      values, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS, activeStream,
    }),
    update: async (payload) => {
      calls.push({ method: 'update', payload });
      return { status: 'applied', state: { values, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS } };
    },
    reset: async (payload) => {
      calls.push({ method: 'reset', payload });
      return { status: 'applied', state: { values: {}, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS } };
    },
  };
  const statuses = [];
  const section = createAdvancedTuningSection({
    inventory, resetLimitsToDefaults, getEngineType,
    getBridge: () => activeBridge,
    onStatus: (status) => statuses.push(status),
  });
  if (loaded) {
    section.setState({
      values, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS, activeStream,
    }, sectionDom);
  }
  const listeners = [];
  section.bind(sectionDom, (target, eventName, handler) => {
    if (!target) return;
    target.addEventListener(eventName, handler);
    listeners.push({ target, eventName });
  });
  return { dom, documentRef, sectionDom, section, calls, statuses, listeners, window: dom.window };
}

function fire(documentRef, window, element, type, detail) {
  const event = detail
    ? new window.CustomEvent(type, { detail, bubbles: true })
    : new window.Event(type, { bubbles: true });
  element.dispatchEvent(event);
}

module.exports = { createHarness, fire, inventory };
