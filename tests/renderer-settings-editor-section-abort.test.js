'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const editorSection = require('../renderer/shell/renderer-settings-editor-section');
const selectField = require('../renderer/inventory/select-field');
const toggleSwitchModule = require('../renderer/inventory/toggle-switch');
const actionButton = require('../renderer/inventory/action-button');
const ideState = require('../renderer/features/renderer-ide-state');

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('aborting the editor binding prevents a pending warm probe from updating status or rendering', async (t) => {
  const previous = {
    window: globalThis.window,
    inventory: globalThis.inventory,
    selectField: globalThis.inventorySelectField,
    toggleSwitch: globalThis.inventoryToggleSwitch,
    actionButton: globalThis.inventoryActionButton,
    ideState: globalThis.rendererIdeState,
  };
  const dom = new JSDOM('<div id="host"></div>');
  const container = dom.window.document.getElementById('host');
  globalThis.window = dom.window;
  globalThis.inventorySelectField = selectField;
  globalThis.inventoryToggleSwitch = toggleSwitchModule;
  globalThis.inventoryActionButton = actionButton;
  globalThis.inventory = { selectField, toggleSwitch: toggleSwitchModule.toggleSwitch, actionButton };
  globalThis.rendererIdeState = ideState;
  t.after(() => {
    globalThis.window = previous.window;
    globalThis.inventory = previous.inventory;
    globalThis.inventorySelectField = previous.selectField;
    globalThis.inventoryToggleSwitch = previous.toggleSwitch;
    globalThis.inventoryActionButton = previous.actionButton;
    globalThis.rendererIdeState = previous.ideState;
    dom.window.close();
  });

  let resolveProbe;
  dom.window.jennyShell = {
    workspaceIde: { async updateSettings(patch) { return { updated: true, ...patch }; } },
    inline: { complete() { return new Promise((resolve) => { resolveProbe = resolve; }); } },
  };
  const state = { ui: { ide: ideState.createIdeUiState() },
    features: { featureFlags: { workspace_inline_suggest: true } } };
  const status = { textContent: '' };
  let renderCount = 0;
  const render = () => {
    renderCount += 1;
    editorSection.renderEditorSection({ container, status, inlineSuggestVisible: true, ide: state.ui.ide });
  };
  render();
  const abortController = new dom.window.AbortController();
  editorSection.bindEditorSection({ container, state, renderSettings: render,
    registerListener: (target, event, handler, options) => {
      target.addEventListener(event, handler, options);
      return true;
    },
    listenerOptions: { signal: abortController.signal },
  });
  const select = container.querySelector('#editorInlineSuggestModelSelect');
  const option = dom.window.document.createElement('option');
  option.value = 'qwen2.5-coder:1.5b-base';
  select.appendChild(option);
  select.value = option.value;
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  // Bounded: an unbounded spin here turned 'production never started the warm
  // probe' into the runner's 120s per-file TIMEOUT instead of a named failure.
  for (let tick = 0; !resolveProbe; tick += 1) {
    if (tick > 5000) throw new Error('the selection path never started a warm probe');
    await flush();
  }
  const rendersBeforeAbort = renderCount;

  abortController.abort();
  resolveProbe({ ok: true, completion: 'x' });
  await flush();
  await flush();

  assert.equal(renderCount, rendersBeforeAbort);
  assert.doesNotMatch(status.textContent, /loaded and ready/i);
});
