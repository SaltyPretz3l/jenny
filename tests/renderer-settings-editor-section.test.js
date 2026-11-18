'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const editorSection = require('../renderer/shell/renderer-settings-editor-section');
const selectField = require('../renderer/inventory/select-field');
const toggleSwitchModule = require('../renderer/inventory/toggle-switch');
const actionButton = require('../renderer/inventory/action-button');
const ideState = require('../renderer/features/renderer-ide-state');
const {
  withGlobals,
  withGlobalsAsync,
  makeContainer,
  flush,
} = require('./helpers/settings-editor-section-harness');


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

test('renderEditorSection emits flat top-level groups, with Saving and Terminal outside the Advanced fold', () => {
  withGlobals(() => {
    const { container } = makeContainer();
    editorSection.renderEditorSection({ container, ide: {} });
    const blocks = [...container.children];
    assert.equal(blocks.length, 6, 'five groups and one fold, as siblings of the container');
    const groups = blocks.slice(0, 5);
    groups.forEach((block) => {
      assert.ok(block.matches('div.settings-group'), 'a group block');
      assert.ok(block.firstElementChild.matches('h4.settings-group-heading'), 'the heading comes first');
    });
    assert.deepEqual(groups.map((g) => g.firstElementChild.textContent), ['General', 'Cursor and text', 'Indentation', 'Saving', 'Terminal']);
    assert.deepEqual(groups.map((g) => g.getAttribute('data-editor-group')), ['general', 'cursor', 'indentation', 'autosave', 'terminal']);
    groups.forEach((g) => {
      assert.equal(g.getAttribute('aria-labelledby'), g.firstElementChild.id, 'the group is named by its heading');
    });
    assert.equal(container.querySelectorAll('.settings-group .settings-group').length, 0, 'no group is nested in another');
    const fold = blocks[5];
    assert.ok(fold.matches('details.settings-fold.settings-editor-advanced'), 'the last block is the standard fold');
    assert.equal(fold.matches('.settings-group'), false);
    assert.equal(fold.querySelector('summary').textContent, 'Advanced');

    const [general, , , saving, terminal] = groups;
    const has = (scope, id) => scope.querySelector(`#${id}, [data-inv-toggle="${id}"]`) !== null;
    ['editorFontSizeSelect', 'editorTabSizeSelect', 'editorWordWrapToggle', 'editorMinimapToggle', 'editorLineNumbersToggle']
      .forEach((id) => assert.ok(has(general, id), id + ' sits in General'));
    const savingIds = ['editorAutoSaveModeSelect', 'editorAutoSaveDelayInput', 'editorFormatOnSaveToggle',
      'editorTrimTrailingWhitespaceToggle', 'editorInsertFinalNewlineToggle'];
    const terminalIds = ['editorTerminalProfileSelect', 'editorTerminalScrollbackInput'];
    savingIds.forEach((id) => assert.ok(has(saving, id), id + ' sits in Saving'));
    terminalIds.forEach((id) => assert.ok(has(terminal, id), id + ' sits in Terminal'));
    [...savingIds, ...terminalIds].forEach((id) => assert.equal(has(fold, id), false, id + ' is not in the Advanced fold'));
    ['editorRenderWhitespaceSelect', 'editorRulersSelect', 'editorBracketPairColorizationToggle', 'editorIndentGuidesToggle',
      'editorStickyScrollToggle', 'editorFoldingToggle', 'editorScrollBeyondLastLineToggle', 'editorMouseWheelZoomToggle', 'editorInlineBlameToggle']
      .forEach((id) => assert.ok(has(fold, id), id + ' sits in Advanced'));
  });
});

test('renderEditorSection groups the row 82 editor options under labelled subgroups', () => {
  withGlobals(() => {
    const { container } = makeContainer();
    editorSection.renderEditorSection({ container, ide: {} });
    const headings = [...container.querySelectorAll('.settings-group-heading')].map((h) => h.textContent);
    assert.deepEqual(headings, ['General', 'Cursor and text', 'Indentation', 'Saving', 'Terminal']);
    const group = (id) => container.querySelector(`[data-editor-group="${id}"]`);
    assert.ok(group('cursor').querySelector('#editorCursorBlinkingSelect'));
    assert.ok(group('cursor').querySelector('[data-inv-toggle="editorFontLigaturesToggle"]'));
    assert.ok(group('indentation').querySelector('[data-inv-toggle="editorInsertSpacesToggle"]'));
    assert.ok(group('indentation').querySelector('[data-inv-toggle="editorDetectIndentationToggle"]'));
    assert.ok(group('autosave').querySelector('#editorAutoSaveModeSelect'));
    const advanced = container.querySelector('details.settings-editor-advanced');
    for (const id of ['editorBracketPairColorizationToggle', 'editorIndentGuidesToggle', 'editorStickyScrollToggle', 'editorFoldingToggle']) {
      assert.ok(advanced.querySelector(`[data-inv-toggle="${id}"]`), id + ' sits in Advanced');
    }
    assert.equal(container.querySelector('[data-inv-toggle="editorAutoSaveToggle"]'), null, 'the old on/off toggle is gone');
  });
});

test('auto save defaults off, migrates the old toggle, and only enables the delay for After a delay', () => {
  withGlobals(() => {
    const { container } = makeContainer();
    const delayRow = () => container.querySelector('[data-setting-id="editorAutoSaveDelayInput"]');
    editorSection.renderEditorSection({ container, ide: {} });
    assert.equal(container.querySelector('#editorAutoSaveModeSelect').value, 'off', 'defaults off (writes files)');
    assert.equal(delayRow().getAttribute('data-setting-parent-off'), 'true');
    // A slice from before row 82 carries only autoSaveEnabled:true: it reads as After a delay.
    editorSection.renderEditorSection({ container, ide: { autoSaveEnabled: true } });
    assert.equal(container.querySelector('#editorAutoSaveModeSelect').value, 'afterDelay');
    assert.equal(delayRow().hasAttribute('data-setting-parent-off'), false);
    editorSection.renderEditorSection({ container, ide: { autoSaveMode: 'onWindowChange' } });
    assert.equal(container.querySelector('#editorAutoSaveModeSelect').value, 'onWindowChange');
  });
});

test('picking an auto save mode projects only after the write is acknowledged', async () => {
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
    const select = container.querySelector('#editorAutoSaveModeSelect');
    select.value = 'onFocusChange';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    assert.equal(state.ui.ide.autoSaveMode, 'onFocusChange', 'the mode lands in the slice');
    assert.deepEqual(patches.at(-1), { autoSaveMode: 'onFocusChange' }, 'a partial patch of the one key');
  });
});

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

test('terminal scrollback (row 82 T1) renders as a number row and writes an integer inside its bounds', async () => {
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
    state.ui.ide.terminalScrollback = 5000;
    editorSection.renderEditorSection({ container, ide: state.ui.ide });
    const input = container.querySelector('#editorTerminalScrollbackInput');
    assert.ok(input, 'the scrollback row renders its input');
    assert.equal(input.value, '5000');
    editorSection.bindEditorSection({
      container,
      state,
      renderSettings: () => {},
      registerListener: (target, event, handler, options) => {
        target.addEventListener(event, handler, options);
        return true;
      },
    });
    input.value = '2500';
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    assert.equal(state.ui.ide.terminalScrollback, 2500, 'an in-range edit lands as an integer');
    assert.equal(patches.at(-1).terminalScrollback, 2500);
    // Below the 500 floor the descriptor's validation refuses the edit: nothing is written.
    const written = patches.length;
    input.value = '200';
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    assert.equal(state.ui.ide.terminalScrollback, 2500);
    assert.equal(patches.length, written);
    // D1: above the 25,000 ceiling is refused too, and the hint states the memory cost.
    input.value = '30000';
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await flush();
    assert.equal(state.ui.ide.terminalScrollback, 2500);
    assert.equal(patches.length, written);
    assert.match(container.textContent, /about 1\.5 MB per 1,000 lines/);
  });
});

// The Terminal "Start folder for Jenny's commands" row: a read-only path, Browse, and Use Downloads.
const START_FOLDER_ROW = '[data-settings-field="editorTerminalStartFolderField"]';
const BROWSE = '[data-action="terminal-start-folder-browse"]';
const USE_DOWNLOADS = '[data-action="terminal-start-folder-default"]';

function bindStartFolder(chooser, saved) {
  const { dom, container } = makeContainer();
  globalThis.window = dom.window;
  const patches = [];
  const workspaceIde = {
    async getState() { return {}; },
    async updateSettings(patch) { patches.push(patch); return { updated: true, ...patch }; },
  };
  if (chooser) workspaceIde.chooseTerminalStartFolder = chooser;
  dom.window.jennyShell = { workspaceIde };
  const state = { ui: { ide: ideState.createIdeUiState() } };
  if (saved) state.ui.ide.terminalStartFolder = saved;
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
  return { container, state, patches };
}
const errorLine = (container) => container.querySelector(START_FOLDER_ROW + ' .settings-field-error');

test('the Terminal group lists the start folder row between the shell and scrollback rows', () => {
  withGlobals(() => {
    const { container } = makeContainer();
    editorSection.renderEditorSection({ container, ide: {} });
    const terminal = container.querySelector('[data-editor-group="terminal"]');
    assert.deepEqual([...terminal.querySelectorAll('[data-settings-field]')].map((row) => row.getAttribute('data-settings-field')),
      ['editorTerminalProfileSelect', 'editorTerminalStartFolderField', 'editorTerminalScrollbackInput']);
    const row = terminal.querySelector(START_FOLDER_ROW);
    assert.match(row.textContent, /Start folder for Jenny's commands/);
    assert.match(row.textContent, /Downloads land here\./);
    assert.equal(row.querySelector('input[readonly]').value, 'Downloads folder (default)');
    assert.equal(row.querySelector(BROWSE).textContent, 'Browse…');
    assert.equal(row.querySelector(USE_DOWNLOADS), null, 'nothing to reset while the default is in use');

    editorSection.renderEditorSection({ container, ide: { terminalStartFolder: 'D:\\Installs' } });
    const saved = container.querySelector(START_FOLDER_ROW);
    assert.equal(saved.querySelector('input[readonly]').value, 'D:\\Installs');
    assert.equal(saved.querySelector(USE_DOWNLOADS).textContent, 'Use Downloads');
    editorSection.renderEditorSection({ container, ide: { terminalStartFolder: 'relative\\path' } });
    assert.equal(container.querySelector(START_FOLDER_ROW + ' input[readonly]').value, 'Downloads folder (default)', 'an invalid stored value reads as the default');
  });
});

test('Browse saves the picked folder and does nothing on cancel or a failed picker', async () => {
  await withGlobalsAsync(async () => {
    const picked = bindStartFolder(async () => ({ ok: true, picked: true, path: 'D:\\Installs' }));
    picked.container.querySelector(BROWSE).click();
    await flush();
    assert.deepEqual(picked.patches, [{ terminalStartFolder: 'D:\\Installs' }]);
    assert.equal(picked.state.ui.ide.terminalStartFolder, 'D:\\Installs');

    const cancelled = bindStartFolder(async () => ({ ok: true, picked: false }));
    cancelled.container.querySelector(BROWSE).click();
    await flush();
    assert.deepEqual(cancelled.patches, []);
    assert.equal(errorLine(cancelled.container).hidden, true, 'a cancel says nothing');

    const network = bindStartFolder(async () => ({ ok: false, picked: false, reason: 'network_path' }));
    network.container.querySelector(BROWSE).click();
    await flush();
    assert.deepEqual(network.patches, []);
    assert.equal(errorLine(network.container).hidden, false);
    assert.equal(errorLine(network.container).textContent, 'Choose a folder on this PC; network folders are not supported.');

    for (const chooser of [undefined, async () => ({ ok: false, picked: false, reason: 'unavailable' }), async () => { throw new Error('boom'); }, async () => null]) {
      const failed = bindStartFolder(chooser, 'D:\\Installs');
      failed.container.querySelector(BROWSE).click();
      await flush();
      assert.deepEqual(failed.patches, []);
      assert.equal(failed.state.ui.ide.terminalStartFolder, 'D:\\Installs', 'the value is unchanged');
      assert.equal(errorLine(failed.container).textContent, 'The folder picker is not available.');
    }
  });
});

test('a picker note survives a repaint and clears on the next pick', async () => {
  await withGlobalsAsync(async () => {
    let answer = { ok: false, picked: false, reason: 'network_path' };
    const { container, state } = bindStartFolder(async () => answer);
    container.querySelector(BROWSE).click();
    await flush();
    editorSection.renderEditorSection({ container, ide: state.ui.ide });
    assert.match(errorLine(container).textContent, /network folders are not supported/);
    answer = { ok: true, picked: false };
    container.querySelector(BROWSE).click();
    await flush();
    assert.equal(errorLine(container).hidden, true);
  });
});

test('Use Downloads saves an empty start folder', async () => {
  await withGlobalsAsync(async () => {
    const { container, state, patches } = bindStartFolder(async () => ({ ok: true, picked: false }), 'D:\\Installs');
    container.querySelector(USE_DOWNLOADS).click();
    await flush();
    assert.deepEqual(patches, [{ terminalStartFolder: '' }]);
    assert.equal(state.ui.ide.terminalStartFolder, '');
  });
});
