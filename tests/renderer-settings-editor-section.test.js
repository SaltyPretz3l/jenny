'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const editorSection = require('../renderer/shell/renderer-settings-editor-section');
const selectField = require('../renderer/inventory/select-field');
const toggleSwitchModule = require('../renderer/inventory/toggle-switch');
const actionButton = require('../renderer/inventory/action-button');
const ideState = require('../renderer/features/renderer-ide-state');

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

test('renderEditorSection builds six controls reflecting the slice values', () => {
  withGlobals(() => {
    const { container } = makeContainer();
    editorSection.renderEditorSection({
      container,
      ide: {
        fontSize: 16, tabSize: 4, wordWrap: 'on', minimap: false,
        lineNumbers: 'off', renderWhitespace: 'all',
      },
    });
    const fontSel = container.querySelector('#editorFontSizeSelect');
    const tabSel = container.querySelector('#editorTabSizeSelect');
    const wsSel = container.querySelector('#editorRenderWhitespaceSelect');
    assert.equal(fontSel.value, '16');
    assert.equal(tabSel.value, '4');
    assert.equal(wsSel.value, 'all');
    assert.equal(fontSel.getAttribute('data-editor-pref'), 'fontSize');
    // Toggles reflect state via aria-checked.
    const wrap = container.querySelector('[data-inv-toggle="editorWordWrapToggle"]');
    const minimap = container.querySelector('[data-inv-toggle="editorMinimapToggle"]');
    const lineNos = container.querySelector('[data-inv-toggle="editorLineNumbersToggle"]');
    assert.equal(wrap.getAttribute('aria-checked'), 'true');
    assert.equal(minimap.getAttribute('aria-checked'), 'false');
    assert.equal(lineNos.getAttribute('aria-checked'), 'false');
    // No raw <select>/<input> authored here - all come from inventory primitives.
    assert.ok(container.querySelector('.inv-select-field-control'), 'uses inventory select-field');
    assert.ok(container.querySelector('.inv-toggle-track'), 'uses inventory toggle-switch');
  });
});

test('renderEditorSection omits the inline-suggest controls unless the flag is on', () => {
  withGlobals(() => {
    const { container } = makeContainer();
    editorSection.renderEditorSection({ container, ide: {} });
    assert.equal(container.querySelector('[data-inv-toggle="editorInlineSuggestToggle"]'), null);
    assert.equal(container.querySelector('#editorInlineSuggestModelSelect'), null);
  });
});

test('renderEditorSection adds role-filtered inline controls without a compute toggle', () => {
  withGlobals(() => {
    const { container } = makeContainer();
    editorSection.renderEditorSection({
      container,
      status: { textContent: '' },
      inlineSuggestVisible: true,
      ide: { inlineSuggestEnabled: true, inlineSuggestModel: 'qwen2.5-coder:1.5b-base' },
    });
    assert.ok(container.querySelector('[data-inv-toggle="editorInlineSuggestToggle"]'), 'enable toggle present');
    assert.equal(container.querySelector('[data-inv-toggle="editorInlineSuggestGpuToggle"]'), null);
    const modelSel = container.querySelector('#editorInlineSuggestModelSelect');
    assert.ok(modelSel, 'model picker present');
    // An unavailable/non-capable saved tag is not offered as a selectable model.
    assert.equal(modelSel.value, '');
    assert.equal(modelSel.getAttribute('data-editor-pref'), 'inlineSuggestModel');
  });
});

test('renderEditorSection always exposes the auto-save preference', () => {
  withGlobals(() => {
    const { container } = makeContainer();
    editorSection.renderEditorSection({ container, ide: {} });
    assert.ok(container.querySelector('[data-inv-toggle="editorAutoSaveToggle"]'));
  });
});

test('renderEditorSection reflects the default-off auto-save preference', () => {
  withGlobals(() => {
    const { container } = makeContainer();
    // No autoSaveEnabled on the slice -> the toggle reflects the DEFAULT-OFF pref.
    editorSection.renderEditorSection({ container, autoSaveVisible: true, ide: {} });
    const toggle = container.querySelector('[data-inv-toggle="editorAutoSaveToggle"]');
    assert.ok(toggle, 'auto-save toggle present');
    assert.equal(toggle.getAttribute('aria-checked'), 'false', 'defaults off (writes files)');
    // An opted-in slice renders the toggle on.
    editorSection.renderEditorSection({ container, autoSaveVisible: true, ide: { autoSaveEnabled: true } });
    assert.equal(
      container.querySelector('[data-inv-toggle="editorAutoSaveToggle"]').getAttribute('aria-checked'),
      'true'
    );
  });
});

test('flipping the auto-save toggle projects only after the write is acknowledged', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    const patches = [];
    dom.window.jennyShell = {
      workspaceIde: {
        async getState() { return {}; },
        async updateSettings(patch) { patches.push(patch); return { updated: true, ...patch }; },
      },
    };
    const state = { ui: { ide: ideState.createIdeUiState() } };
    editorSection.renderEditorSection({ container, autoSaveVisible: true, ide: state.ui.ide });
    editorSection.bindEditorSection({
      container,
      state,
      renderSettings: () => {},
      registerListener: (target, event, handler, options) => {
        target.addEventListener(event, handler, options);
        return true;
      },
    });
    // Default-off -> turn it on.
    container.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', {
      bubbles: true,
      detail: { id: 'editorAutoSaveToggle', checked: true },
    }));
    await flush();
    assert.equal(state.ui.ide.autoSaveEnabled, true, 'auto-save flipped on in the slice');
    assert.equal(patches.at(-1).autoSaveEnabled, true, 'partial patch carries autoSaveEnabled:true');
  });
});

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

test('the catalog auto-refresh lists only insert-capable Ollama tags and routes lifecycle to Model Library', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    let listOllamaCalls = 0;
    let listCalls = 0;
    dom.window.jennyShell = {
      workspaceIde: { async getState() { return {}; }, async updateSettings(patch) { return { updated: true, ...patch }; } },
      models: {
        async list() { listCalls += 1; return { data: [{ id: 'chat-engine-only-model' }] }; },
        async listOllamaTags() {
          listOllamaCalls += 1;
          return {
            data: [
              { id: 'qwen2.5-coder:1.5b-base', capabilities: { insert: true } },
              { id: 'gemma4-vision:12b', capabilities: { vision: true } },
            ],
          };
        },
      },
    };
    const state = {
      ui: { ide: ideState.createIdeUiState() },
      features: { featureFlags: { workspace_inline_suggest: true } },
    };
    const render = () => editorSection.renderEditorSection({ container, inlineSuggestVisible: true, ide: state.ui.ide });
    render();
    editorSection.bindEditorSection({
      container,
      state,
      renderSettings: render,
      registerListener: (t, e, h, o) => { t.addEventListener(e, h, o); return true; },
    });
    await flush();
    render();
    editorSection.invalidateInlineModelCatalog();
    await flush();
    render();

    const modelSel = container.querySelector('#editorInlineSuggestModelSelect');
    const options = Array.from(modelSel.options).map((o) => o.value);
    assert.ok(options.includes('qwen2.5-coder:1.5b-base'), 'freshly-pulled FIM tag is selectable');
    assert.ok(!options.includes('gemma4-vision:12b'), 'chat-only model is never selectable');
    assert.ok(!options.includes('chat-engine-only-model'), 'does NOT source the chat-engine models.list');
    assert.ok(listOllamaCalls >= 1, 'fetched models.listOllamaTags');
    assert.equal(listCalls, 0, 'never called the chat-engine-scoped models.list');

    assert.equal(container.querySelector('[data-inv-toggle="editorInlineSuggestShowAllToggle"]'), null);
    assert.ok(container.querySelector('[data-action="openEditorModelLibrary"]'));
  });
});

test('the picker does not fetch models when the inline-suggest flag is off', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    let fetched = false;
    dom.window.jennyShell = {
      workspaceIde: { async getState() { return {}; }, async updateSettings(patch) { return { updated: true, ...patch }; } },
      models: { async listOllamaTags() { fetched = true; return { data: [] }; } },
    };
    const state = {
      ui: { ide: ideState.createIdeUiState() },
      features: { featureFlags: { workspace_inline_suggest: false } },
    };
    editorSection.renderEditorSection({ container, inlineSuggestVisible: false, ide: state.ui.ide });
    editorSection.bindEditorSection({
      container,
      state,
      renderSettings: () => {},
      registerListener: (t, e, h, o) => { t.addEventListener(e, h, o); return true; },
    });
    await flush();
    assert.equal(fetched, false, 'no model IPC when the feature flag is off');
  });
});

// Drive a completion-model selection: append the option, set it, fire 'change'.
function selectCompletionModel(dom, container, tag) {
  const sel = container.querySelector('#editorInlineSuggestModelSelect');
  const opt = dom.window.document.createElement('option');
  opt.value = tag;
  sel.appendChild(opt);
  sel.value = tag;
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

test('selecting a completion model warms it via inline.complete and confirms when ready', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    const calls = [];
    dom.window.jennyShell = {
      workspaceIde: { async getState() { return {}; }, async updateSettings(patch) { return { updated: true, ...patch }; } },
      inline: {
        async complete(payload) { calls.push(payload); return { ok: true, completion: 'x' }; },
      },
    };
    const state = {
      ui: { ide: ideState.createIdeUiState() },
      features: { featureFlags: { workspace_inline_suggest: true } },
    };
    const status = { textContent: '' };
    const render = () => editorSection.renderEditorSection({
      container, status, inlineSuggestVisible: true, ide: state.ui.ide,
    });
    render();
    editorSection.bindEditorSection({
      container,
      state,
      renderSettings: render,
      registerListener: (t, e, h, o) => { t.addEventListener(e, h, o); return true; },
    });
    selectCompletionModel(dom, container, 'qwen2.5-coder:1.5b-base');
    await flush();
    await flush();
    assert.equal(state.ui.ide.inlineSuggestModel, 'qwen2.5-coder:1.5b-base', 'slice updated after ack');
    assert.equal(calls.length >= 1, true, 'warmed via inline.complete');
    assert.equal(calls[0].model, 'qwen2.5-coder:1.5b-base');
    assert.equal(calls[0].maxTokens, 1, 'used a 1-token warm probe');
    assert.match(status.textContent, /loaded and ready/);
  });
});

test('a completion model that does not become ready reports progress, not silence', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    let probes = 0;
    dom.window.jennyShell = {
      workspaceIde: { async getState() { return {}; }, async updateSettings(patch) { return { updated: true, ...patch }; } },
      inline: {
        async complete() { probes += 1; return { ok: false, reason: 'generate_failed' }; },
      },
    };
    const state = {
      ui: { ide: ideState.createIdeUiState() },
      features: { featureFlags: { workspace_inline_suggest: true } },
    };
    const status = { textContent: '' };
    const render = () => editorSection.renderEditorSection({
      container, status, inlineSuggestVisible: true, ide: state.ui.ide,
    });
    render();
    editorSection.bindEditorSection({
      container,
      state,
      renderSettings: render,
      registerListener: (t, e, h, o) => { t.addEventListener(e, h, o); return true; },
    });
    selectCompletionModel(dom, container, 'qwen2.5-coder:1.5b-base');
    await flush();
    await flush();
    await flush();
    assert.equal(probes, 2, 'retried once after the first probe kicked the load');
    assert.match(status.textContent, /first completion may take a few seconds/);
  });
});

test('selecting "Off" clears the load status back to the default hint', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    dom.window.jennyShell = {
      workspaceIde: { async getState() { return {}; }, async updateSettings(patch) { return { updated: true, ...patch }; } },
      inline: { async complete() { return { ok: true, completion: 'x' }; } },
    };
    const state = {
      ui: { ide: ideState.createIdeUiState() },
      features: { featureFlags: { workspace_inline_suggest: true } },
    };
    const status = { textContent: '' };
    const render = () => editorSection.renderEditorSection({
      container, status, inlineSuggestVisible: true, ide: state.ui.ide,
    });
    render();
    editorSection.bindEditorSection({
      container,
      state,
      renderSettings: render,
      registerListener: (t, e, h, o) => { t.addEventListener(e, h, o); return true; },
    });
    selectCompletionModel(dom, container, 'qwen2.5-coder:1.5b-base');
    await flush();
    await flush();
    assert.match(status.textContent, /loaded and ready/);
    // Now pick "Off" (empty value) — the load status clears.
    const sel = container.querySelector('#editorInlineSuggestModelSelect');
    sel.value = '';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    assert.match(status.textContent, /Recommended:/);
    assert.doesNotMatch(status.textContent, /loaded and ready/);
  });
});

test('selecting a model with no inline bridge still confirms the selection', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    dom.window.jennyShell = {
      workspaceIde: { async getState() { return {}; }, async updateSettings(patch) { return { updated: true, ...patch }; } },
      // no `inline` bridge (older build / non-managed mode)
    };
    const state = {
      ui: { ide: ideState.createIdeUiState() },
      features: { featureFlags: { workspace_inline_suggest: true } },
    };
    const status = { textContent: '' };
    const render = () => editorSection.renderEditorSection({
      container, status, inlineSuggestVisible: true, ide: state.ui.ide,
    });
    render();
    editorSection.bindEditorSection({
      container,
      state,
      renderSettings: render,
      registerListener: (t, e, h, o) => { t.addEventListener(e, h, o); return true; },
    });
    selectCompletionModel(dom, container, 'qwen2.5-coder:1.5b-base');
    await flush();
    assert.match(status.textContent, /Open the Workspace IDE/);
  });
});

test('renderEditorSection shows defaults when the slice is null (IDE never opened)', () => {
  withGlobals(() => {
    const { container } = makeContainer();
    editorSection.renderEditorSection({ container, ide: null });
    assert.equal(container.querySelector('#editorFontSizeSelect').value, '13');
    assert.equal(container.querySelector('#editorTabSizeSelect').value, '2');
    assert.equal(container.querySelector('#editorRenderWhitespaceSelect').value, 'selection');
    assert.equal(container.querySelector('[data-inv-toggle="editorMinimapToggle"]').getAttribute('aria-checked'), 'true');
    assert.equal(container.querySelector('[data-inv-toggle="editorLineNumbersToggle"]').getAttribute('aria-checked'), 'true');
  });
});

test('a select change projects after an acknowledged partial patch that omits openTabs', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    const patches = [];
    dom.window.jennyShell = {
      workspaceIde: {
        async getState() {
          return { openTabs: [{ path: 'src/app.js' }], fontSize: 13, tabSize: 2 };
        },
        async updateSettings(patch) { patches.push(patch); return { updated: true, ...patch }; },
      },
    };
    // Pre-seed the slice with open tabs (as a hydrated IDE would have).
    const state = { ui: { ide: ideState.createIdeUiState() } };
    state.ui.ide.openTabs = [{ path: 'src/app.js', kind: 'file' }];
    let rerenders = 0;
    editorSection.renderEditorSection({ container, ide: state.ui.ide });
    editorSection.bindEditorSection({
      container,
      state,
      renderSettings: () => { rerenders += 1; },
      registerListener: (target, event, handler, options) => {
        target.addEventListener(event, handler, options);
        return true;
      },
    });

    const fontSel = container.querySelector('#editorFontSizeSelect');
    fontSel.value = '18';
    fontSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();

    assert.equal(state.ui.ide.fontSize, 18, 'slice mutated');
    assert.ok(rerenders >= 1, 're-rendered after the change');
    const patch = patches.at(-1);
    assert.equal(patch.fontSize, 18, 'patch carries the new font size');
    assert.equal('openTabs' in patch, false, 'partial patch omits openTabs (merge-safe)');
    assert.deepEqual(Object.keys(patch), ['fontSize']);
  });
});

test('a toggle change flips the slice only after persistence acknowledges it', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    const patches = [];
    dom.window.jennyShell = {
      workspaceIde: {
        async getState() { return {}; },
        async updateSettings(patch) { patches.push(patch); return { updated: true, ...patch }; },
      },
    };
    const state = { ui: { ide: ideState.createIdeUiState() } };
    editorSection.renderEditorSection({ container, ide: state.ui.ide });
    editorSection.bindEditorSection({
      container,
      state,
      renderSettings: () => {},
      registerListener: (target, event, handler, options) => {
        target.addEventListener(event, handler, options);
        return true;
      },
    });
    // Minimap defaults on; simulate the toggle turning it off.
    container.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', {
      bubbles: true,
      detail: { id: 'editorMinimapToggle', checked: false },
    }));
    await flush();
    assert.equal(state.ui.ide.minimap, false, 'minimap flipped off in the slice');
    assert.equal(patches.at(-1).minimap, false, 'patch carries minimap:false');
  });
});

test('hydration does not clobber a change made while getState is in flight', async () => {
  const prev = {
    window: globalThis.window,
    inventory: globalThis.inventory,
    selectField: globalThis.inventorySelectField,
    toggleSwitch: globalThis.inventoryToggleSwitch,
    actionButton: globalThis.inventoryActionButton,
    ideState: globalThis.rendererIdeState,
  };
  globalThis.inventorySelectField = selectField;
  globalThis.inventoryToggleSwitch = toggleSwitchModule;
  globalThis.inventoryActionButton = actionButton;
  globalThis.inventory = { selectField, toggleSwitch: toggleSwitchModule.toggleSwitch, actionButton };
  globalThis.rendererIdeState = ideState;
  try {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    let resolveState;
    const statePromise = new Promise((r) => { resolveState = r; });
    dom.window.jennyShell = {
      workspaceIde: { getState() { return statePromise; }, async updateSettings(patch) { return { updated: true, ...patch }; } },
    };
    const state = { ui: { ide: null } }; // IDE never opened -> hydration runs
    editorSection.bindEditorSection({
      container,
      state,
      renderSettings: () => {},
      registerListener: (t, e, h, o) => { t.addEventListener(e, h, o); return true; },
    });
    editorSection.renderEditorSection({ container, ide: state.ui.ide });
    // User changes font size BEFORE the in-flight getState resolves.
    const fontSel = container.querySelector('#editorFontSizeSelect');
    fontSel.value = '18';
    fontSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    assert.equal(state.ui.ide.fontSize, 18);
    // Stale persisted state now arrives - it must NOT overwrite the user change.
    resolveState({ fontSize: 11, tabSize: 8 });
    await statePromise;
    await Promise.resolve();
    assert.equal(state.ui.ide.fontSize, 18, 'user change survives stale hydration');
  } finally {
    globalThis.window = prev.window;
    globalThis.inventory = prev.inventory;
    globalThis.inventorySelectField = prev.selectField;
    globalThis.inventoryToggleSwitch = prev.toggleSwitch;
    globalThis.inventoryActionButton = prev.actionButton;
    globalThis.rendererIdeState = prev.ideState;
  }
});

test('column-rulers select round-trips a bounded ordered array after acknowledgement', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    const patches = [];
    dom.window.jennyShell = {
      workspaceIde: {
        async getState() { return {}; },
        async updateSettings(patch) { patches.push(patch); return { updated: true, ...patch }; },
      },
    };
    const state = { ui: { ide: ideState.createIdeUiState() } };
    state.ui.ide.rulers = [80, 120];
    editorSection.renderEditorSection({ container, ide: state.ui.ide });
    // A stored [80,120] selects the "80,120" preset.
    assert.equal(container.querySelector('#editorRulersSelect').value, '80,120');
    editorSection.bindEditorSection({
      container,
      state,
      renderSettings: () => {},
      registerListener: (target, event, handler, options) => {
        target.addEventListener(event, handler, options);
        return true;
      },
    });
    const sel = container.querySelector('#editorRulersSelect');
    sel.value = '80';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    assert.deepEqual(state.ui.ide.rulers, [80], 'change parses the comma-string back to an int array');
    assert.deepEqual(patches.at(-1).rulers, [80], 'the partial patch carries the new rulers');
    // Selecting "Off" clears the rulers.
    sel.value = '';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    assert.deepEqual(state.ui.ide.rulers, []);
  });
});

test('a refused editor preference write preserves the prior value and surfaces an error', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    dom.window.jennyShell = {
      workspaceIde: {
        async getState() { return {}; },
        async updateSettings() { return { updated: false, code: 'config_write_blocked' }; },
      },
    };
    const errors = [];
    const state = { ui: { ide: ideState.createIdeUiState() } };
    editorSection.renderEditorSection({ container, ide: state.ui.ide });
    editorSection.bindEditorSection({
      container,
      state,
      renderSettings: () => {},
      showShellErrorToast: (message, meta) => errors.push({ message, meta }),
      registerListener: (target, event, handler, options) => {
        target.addEventListener(event, handler, options); return true;
      },
    });
    container.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', {
      bubbles: true,
      detail: { id: 'editorMinimapToggle', checked: false },
    }));
    await flush();
    assert.equal(state.ui.ide.minimap, true, 'previous runtime value remains active');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].meta.title, 'Editor Setting Not Saved');
  });
});

test('clampFontSize truncates + bounds, and renderEditorSection clamps an out-of-range slice value', () => {
  withGlobals(() => {
    // Bounds reused from renderer-ide-state (8..40); invalid -> default 13.
    assert.equal(editorSection.clampFontSize(999), 40);
    assert.equal(editorSection.clampFontSize(4), 8);
    assert.equal(editorSection.clampFontSize(13.7), 13);
    assert.equal(editorSection.clampFontSize('nope'), 13);
    assert.equal(editorSection.clampFontSize(0), 13);
    const { container } = makeContainer();
    editorSection.renderEditorSection({ container, ide: { fontSize: 999 } });
    assert.equal(container.querySelector('#editorFontSizeSelect').value, '40');
  });
});

test('the section reuses renderer-ide-state enums (single canonical source)', () => {
  // renderer-ide-state.js is the renderer-canonical owner; the section reads
  // these at runtime rather than holding its own copy.
  assert.deepEqual(ideState.TAB_SIZES, [2, 4, 8]);
  assert.deepEqual(ideState.RENDER_WHITESPACE, ['none', 'boundary', 'selection', 'trailing', 'all']);
  assert.equal(ideState.FONT_SIZE_MIN, 8);
  assert.equal(ideState.FONT_SIZE_MAX, 40);
});
