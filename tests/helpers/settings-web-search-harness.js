'use strict';

const { JSDOM } = require('jsdom');

const selectField = require('../../renderer/inventory/select-field');
const textField = require('../../renderer/inventory/text-field');
const actionButton = require('../../renderer/inventory/action-button');
const settingsField = require('../../renderer/inventory/settings-field');

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function withGlobals(run) {
  const prevInventory = globalThis.inventory;
  const prevSelectField = globalThis.inventorySelectField;
  const prevTextField = globalThis.inventoryTextField;
  const prevActionButton = globalThis.inventoryActionButton;
  globalThis.inventorySelectField = selectField;
  globalThis.inventoryTextField = textField;
  globalThis.inventoryActionButton = actionButton;
  globalThis.inventory = { selectField, textField, actionButton, settingsField };
  try {
    return run();
  } finally {
    globalThis.inventory = prevInventory;
    globalThis.inventorySelectField = prevSelectField;
    globalThis.inventoryTextField = prevTextField;
    globalThis.inventoryActionButton = prevActionButton;
  }
}

function renderToDom(markup) {
  return new JSDOM(`<!doctype html><body>${markup}</body>`).window.document;
}

function createHarness(markup) {
  const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousAbortController = global.AbortController;
  global.window = dom.window;
  global.document = dom.window.document;
  global.AbortController = dom.window.AbortController;
  global.window.jennyShell = { models: {} };
  return {
    window: dom.window,
    document: dom.window.document,
    cleanup() {
      global.window = previousWindow;
      global.document = previousDocument;
      global.AbortController = previousAbortController;
      dom.window.close();
    },
  };
}

function createBaseDeps(overrides = {}) {
  const stateOverride = overrides.state || {};
  const baseState = {
    ui: { appearance: {} },
    features: { featureFlags: {} },
    memoryManager: { filter: 'all', searchQuery: '' },
    modelList: [],
    personality: {},
  };
  return {
    state: {
      ...baseState,
      ...stateOverride,
      ui: { ...baseState.ui, ...(stateOverride.ui || {}) },
    },
    constants: {
      TOAST_SOURCE: { settings: 'settings', memory: 'memory' },
      ACTIVITY_SCOPE: {},
    },
    dom: {
      settingsView: null,
      getSectionDom() { return {}; },
      ...overrides.dom,
    },
    callbacks: {
      renderSettings() {},
      renderSessions() {},
      setSidebarCollapsed() {},
      upsertApprovedMemoryDraft() {},
      getApprovedMemoryById() { return null; },
      hasApprovedMemoryDraftChanges() { return false; },
      clearApprovedMemoryDraft() {},
      handleApprovedMemorySave: async () => {},
      handleApprovedMemoryDelete() {},
      applyAppearancePreferences() {},
      appearanceUtils: null,
      getDefaultAppearancePreferences() { return {}; },
      applySurfaceEffect() {},
      activateSurfaceEffect() {},
      handlePersonalityTabChange: async () => {},
      getPersonalityActiveFile() { return null; },
      setPersonalityDraft() {},
      renderPersonalityEditor() {},
      handlePersonalitySave: async () => {},
      handlePersonalityReset: async () => {},
      handlePersonalityOpenFolder: async () => {},
      showShellErrorToast() {},
      toErrorMessage(error, fallback) { return error?.message || fallback; },
      appendClientLog() {},
      showSessionActionError() {},
      getCurrentRuntimePreferences() {
        return { contextPreferences: {} };
      },
      getRuntimePreferenceSnapshot() { return {}; },
      runRuntimePreferenceActivity: async () => {},
      openSettingsSection() {},
      handleWorkspaceRootChoose: async () => {},
      refreshSkillsState: async () => {},
      updateSkillsSettings() {},
      openSkillsScopeFolder() {},
      handleOfflineModeChange: async () => {},
      refreshFeatureState: async () => {},
      setActiveView() {},
      ...overrides.callbacks,
    },
  };
}

module.exports = { escapeHtml, withGlobals, renderToDom, createHarness, createBaseDeps };
