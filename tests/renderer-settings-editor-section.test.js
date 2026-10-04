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
    // Each select is a descriptor row (settingsField + meta line), routed by its control id.
    assert.ok(container.querySelector('[data-settings-field="editorFontSizeSelect"] #editorFontSizeSelect'));
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

test('renderEditorSection has no inline-suggestion rows, even for a profile that still stores them', () => {
  withGlobals(() => {
    const { dom, container } = makeContainer();
    const status = dom.window.document.createElement('p');
    editorSection.renderEditorSection({
      container,
      status,
      ide: { inlineSuggestEnabled: true, inlineSuggestModel: 'qwen2.5-coder:1.5b-base' },
    });
    assert.equal(container.querySelector('[data-inv-toggle="editorInlineSuggestToggle"]'), null);
    assert.equal(container.querySelector('#editorInlineSuggestModelSelect'), null);
    assert.equal(container.querySelector('[data-action="openEditorModelLibrary"]'), null);
    assert.equal(status.textContent, '');
    assert.equal(status.hidden, true);
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

test('renderEditorSection shows defaults when the slice is null (IDE never opened)', () => {
  withGlobals(() => {
    const { container } = makeContainer();
    editorSection.renderEditorSection({ container, ide: null });
    assert.equal(container.querySelector('#editorFontSizeSelect').value, '0', 'defaults to Match text size');
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
    assert.equal(state.ui.ide.tabSize, 8, 'untouched siblings still hydrate from the persisted state');
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

test('a refused editor switch keeps the prior value and says why under the switch, without a toast', async () => {
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
    const line = container.querySelector('[data-inv-toggle="editorMinimapToggle"]').closest('.settings-field').querySelector('.settings-field-error');
    assert.match(line.textContent, /could not be saved/);
    assert.equal(errors.length, 0);
  });
});

test('clampFontSize truncates + bounds, and renderEditorSection clamps an out-of-range slice value', () => {
  withGlobals(() => {
    // Bounds reused from renderer-ide-state (8..40); invalid and the legacy 13
    // default -> 0 (Match text size).
    assert.equal(editorSection.clampFontSize(999), 40);
    assert.equal(editorSection.clampFontSize(4), 8);
    assert.equal(editorSection.clampFontSize(14.7), 14);
    assert.equal(editorSection.clampFontSize(13.7), 0);
    assert.equal(editorSection.clampFontSize('nope'), 0);
    assert.equal(editorSection.clampFontSize(0), 0);
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

const listen = (target, event, handler, options) => { target.addEventListener(event, handler, options); return true; };

test('editor rows carry the descriptor meta line and Revert writes the default through the adapter', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    const patches = [];
    dom.window.jennyShell = {
      workspaceIde: { async getState() { return {}; }, async updateSettings(patch) { patches.push(patch); return { updated: true, ...patch }; } },
    };
    const state = { ui: { ide: ideState.createIdeUiState() } };
    state.ui.ide.fontSize = 18;
    const render = () => editorSection.renderEditorSection({ container, ide: state.ui.ide });
    render();
    const row = (id) => container.querySelector(`[data-settings-field="${id}"]`);
    assert.equal(row('editorFontSizeSelect').querySelector('[data-setting-revert]').getAttribute('data-setting-revert-default'), 'Match text size');
    assert.equal(row('editorFontSizeSelect').querySelector('.settings-field-meta-modified').textContent, 'Modified');
    assert.equal(row('editorTabSizeSelect').querySelector('[data-setting-revert]'), null);
    assert.equal(row('editorTabSizeSelect').querySelector('.settings-field-meta-modified').hidden, true, 'an unmodified row hides its Modified tag');
    editorSection.bindEditorSection({ container, state, renderSettings: render, registerListener: listen });
    container.querySelector('[data-setting-revert="editorFontSizeSelect"]').click();
    await flush();
    assert.deepEqual(patches, [{ fontSize: 0 }]);
    assert.equal(state.ui.ide.fontSize, 0);
    assert.equal(row('editorFontSizeSelect').querySelector('.settings-field-meta-modified').hidden, true);
  });
});

test('a refused editor select write rolls the control back and reports it on its row', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    dom.window.jennyShell = {
      workspaceIde: { async getState() { return {}; }, async updateSettings() { return { updated: false, code: 'config_write_blocked' }; } },
    };
    const errors = [];
    const state = { ui: { ide: ideState.createIdeUiState() } };
    state.ui.ide.tabSize = 2;
    const render = () => editorSection.renderEditorSection({ container, ide: state.ui.ide });
    render();
    editorSection.bindEditorSection({ container, state, renderSettings: render, registerListener: listen,
      showShellErrorToast: (message, meta) => errors.push({ message, meta }) });
    const sel = container.querySelector('#editorTabSizeSelect');
    sel.value = '4';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    assert.equal(state.ui.ide.tabSize, 2, 'the slice keeps the acknowledged value');
    assert.equal(container.querySelector('#editorTabSizeSelect').value, '2', 'the control is rolled back');
    assert.equal(errors.length, 0, 'the reason is on the row, so there is no toast');
    assert.match(container.querySelector('[data-settings-field="editorTabSizeSelect"] .settings-field-error').textContent, /could not be saved/);
  });
});

test('a refused write inside the collapsed Advanced disclosure is still reported: the reason there is out of sight', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    dom.window.jennyShell = {
      workspaceIde: { async getState() { return {}; }, async updateSettings() { return { updated: false, code: 'config_write_blocked' }; } },
    };
    const errors = [];
    const state = { ui: { ide: ideState.createIdeUiState() } };
    const render = () => editorSection.renderEditorSection({ container, ide: state.ui.ide });
    render();
    editorSection.bindEditorSection({ container, state, renderSettings: render, registerListener: listen,
      showShellErrorToast: (message, meta) => errors.push({ message, meta }) });
    container.querySelector('details.settings-editor-advanced').open = true;
    const sel = container.querySelector('#editorRenderWhitespaceSelect');
    const before = sel.value;
    sel.value = [...sel.options].map((option) => option.value).find((value) => value !== before);
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    assert.equal(container.querySelector('#editorRenderWhitespaceSelect').value, before, 'the control is rolled back');
    assert.equal(container.querySelector('details.settings-editor-advanced').open, false, 'the repaint closed the disclosure over the row reason');
    assert.equal(errors.length, 1, 'so the failure is toasted');
    assert.equal(errors[0].meta.title, 'Editor Setting Not Saved');
  });
});

test('column-rulers Revert writes the stored empty array, never the comma string', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    const patches = [];
    dom.window.jennyShell = {
      workspaceIde: { async getState() { return {}; }, async updateSettings(patch) { patches.push(patch); return { updated: true, ...patch }; } },
    };
    const state = { ui: { ide: ideState.createIdeUiState() } };
    state.ui.ide.rulers = [80, 120];
    const render = () => editorSection.renderEditorSection({ container, ide: state.ui.ide });
    render();
    assert.equal(container.querySelector('[data-settings-field="editorRulersSelect"] [data-setting-revert]').getAttribute('data-setting-revert-default'), 'Off');
    editorSection.bindEditorSection({ container, state, renderSettings: render, registerListener: listen });
    container.querySelector('[data-setting-revert="editorRulersSelect"]').click();
    await flush();
    assert.deepEqual(patches, [{ rulers: [] }]);
    assert.deepEqual(state.ui.ide.rulers, []);
    assert.equal(container.querySelector('#editorRulersSelect').value, '');
  });
});

test('an acknowledgement that omits or changes the written key is a refusal, never assumed', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    let echo = () => ({ updated: true });
    dom.window.jennyShell = {
      workspaceIde: { async getState() { return {}; }, async updateSettings(patch) { return echo(patch); } },
    };
    const state = { ui: { ide: ideState.createIdeUiState() } };
    editorSection.renderEditorSection({ container, autoSaveVisible: true, ide: state.ui.ide });
    editorSection.bindEditorSection({
      container,
      state,
      renderSettings: () => {},
      registerListener: (target, event, handler, options) => { target.addEventListener(event, handler, options); return true; },
    });
    const flip = (checked) => container.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', {
      bubbles: true, detail: { id: 'editorAutoSaveToggle', checked },
    }));
    flip(true);
    await flush();
    assert.equal(state.ui.ide.autoSaveEnabled, false, 'updated:true without the key confirms nothing');
    echo = (patch) => ({ updated: true, ...patch, autoSaveEnabled: false });
    flip(true);
    await flush();
    assert.equal(state.ui.ide.autoSaveEnabled, false, 'an echo carrying a different value is a refusal');
    echo = (patch) => ({ updated: true, ...patch });
    flip(true);
    await flush();
    assert.equal(state.ui.ide.autoSaveEnabled, true, 'the matching echo is adopted');
  });
});

test('an editor write in flight when Settings reopens settles on the coordinator the new binding uses', async () => {
  await withGlobalsAsync(async () => {
    const first = makeContainer();
    const second = makeContainer();
    globalThis.window = first.dom.window;
    const acks = [];
    const bridge = {
      workspaceIde: {
        async getState() { return {}; },
        updateSettings(patch) { return new Promise((resolve) => acks.push({ patch, resolve: () => resolve({ updated: true, ...patch }) })); },
      },
    };
    first.dom.window.jennyShell = bridge;
    second.dom.window.jennyShell = bridge;
    const state = { ui: { ide: ideState.createIdeUiState() } };
    const listen = (target, event, handler, options) => { target.addEventListener(event, handler, options); return true; };
    const flip = (dom, container, checked) => container.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', {
      bubbles: true, detail: { id: 'editorAutoSaveToggle', checked },
    }));
    editorSection.renderEditorSection({ container: first.container, autoSaveVisible: true, ide: state.ui.ide });
    editorSection.bindEditorSection({ container: first.container, state, renderSettings: () => {}, registerListener: listen });
    flip(first.dom, first.container, true);
    await flush();
    assert.equal(acks.length, 1);
    globalThis.window = second.dom.window;
    editorSection.renderEditorSection({ container: second.container, autoSaveVisible: true, ide: state.ui.ide });
    editorSection.bindEditorSection({ container: second.container, state, renderSettings: () => {}, registerListener: listen });
    const wordWrap = second.container.querySelector('[data-inv-toggle="editorWordWrapToggle"]');
    assert.ok(wordWrap, 'the second binding renders the word-wrap switch');
    second.container.dispatchEvent(new second.dom.window.CustomEvent('inv-toggle-change', { bubbles: true, detail: { id: 'editorWordWrapToggle', checked: true } }));
    await flush();
    assert.equal(acks.length, 1, 'queued behind the first binding\'s write');
    acks[0].resolve();
    await flush();
    await flush();
    assert.equal(state.ui.ide.autoSaveEnabled, true, 'the first binding\'s write still projects');
    assert.equal(acks.length, 2);
    acks[1].resolve();
    await flush();
    await flush();
    assert.equal(state.ui.ide.wordWrap, 'on');
  });
});
