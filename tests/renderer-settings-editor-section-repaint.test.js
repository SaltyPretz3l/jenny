'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const editorSection = require('../renderer/shell/renderer-settings-editor-section');
const ideState = require('../renderer/features/renderer-ide-state');
const {
  withGlobals,
  withGlobalsAsync,
  makeContainer,
  flush,
  listen,
} = require('./helpers/settings-editor-section-harness');

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

// A refused Advanced write rolls the control back without a repaint, so the
// open disclosure keeps its row reason on screen; it is toasted only when the
// person closed the disclosure while the write was in flight.
test('a refused write inside the Advanced disclosure is reported inline while open, toasted once collapsed', async () => {
  await withGlobalsAsync(async () => {
    const { dom, container } = makeContainer();
    globalThis.window = dom.window;
    const pending = [];
    dom.window.jennyShell = {
      workspaceIde: { async getState() { return {}; }, updateSettings() { return new Promise((resolve) => pending.push(resolve)); } },
    };
    const errors = [];
    const state = { ui: { ide: ideState.createIdeUiState() } };
    const render = () => editorSection.renderEditorSection({ container, ide: state.ui.ide });
    render();
    editorSection.bindEditorSection({ container, state, renderSettings: render, registerListener: listen,
      showShellErrorToast: (message, meta) => errors.push({ message, meta }) });
    const details = () => container.querySelector('details.settings-editor-advanced');
    const refuseWhitespaceChange = async (beforeSettle) => {
      const sel = container.querySelector('#editorRenderWhitespaceSelect');
      const before = sel.value;
      sel.value = [...sel.options].map((option) => option.value).find((value) => value !== before);
      sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      await flush();
      beforeSettle();
      pending.shift()({ updated: false, code: 'config_write_blocked' });
      await flush();
      assert.equal(container.querySelector('#editorRenderWhitespaceSelect').value, before, 'the control is rolled back');
    };
    details().open = true;
    await refuseWhitespaceChange(() => {});
    assert.equal(details().open, true, 'the disclosure stays open over the row reason');
    assert.match(container.querySelector('[data-settings-field="editorRenderWhitespaceSelect"] .settings-field-error').textContent, /could not be saved/);
    assert.equal(errors.length, 0, 'the reason is on screen, so there is no toast');

    await refuseWhitespaceChange(() => { details().open = false; });
    assert.equal(errors.length, 1, 'the reason went out of sight, so the failure is toasted');
    assert.equal(errors[0].meta.title, 'Editor Setting Not Saved');
  });
});

test('an unchanged editor render rewrites nothing, and a rewrite keeps the Advanced disclosure open', () => {
  withGlobals(() => {
    const { container } = makeContainer();
    const ide = ideState.createIdeUiState();
    editorSection.renderEditorSection({ container, ide });
    const details = container.querySelector('details.settings-editor-advanced');
    details.open = true;
    const tabSize = container.querySelector('#editorTabSizeSelect');
    editorSection.renderEditorSection({ container, ide: { ...ide } });
    assert.equal(container.querySelector('#editorTabSizeSelect'), tabSize, 'the same data keeps the same nodes');
    editorSection.renderEditorSection({ container, ide: { ...ide, tabSize: 4 } });
    assert.notEqual(container.querySelector('details.settings-editor-advanced'), details, 'changed data rewrites the rows');
    assert.equal(container.querySelector('#editorTabSizeSelect').value, '4');
    assert.equal(container.querySelector('details.settings-editor-advanced').open, true, 'the disclosure stays open across the rewrite');
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
      bubbles: true, detail: { id: 'editorFormatOnSaveToggle', checked },
    }));
    flip(true);
    await flush();
    assert.equal(state.ui.ide.formatOnSave, false, 'updated:true without the key confirms nothing');
    echo = (patch) => ({ updated: true, ...patch, formatOnSave: false });
    flip(true);
    await flush();
    assert.equal(state.ui.ide.formatOnSave, false, 'an echo carrying a different value is a refusal');
    echo = (patch) => ({ updated: true, ...patch });
    flip(true);
    await flush();
    assert.equal(state.ui.ide.formatOnSave, true, 'the matching echo is adopted');
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
      bubbles: true, detail: { id: 'editorFormatOnSaveToggle', checked },
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
    assert.equal(state.ui.ide.formatOnSave, true, 'the first binding\'s write still projects');
    assert.equal(acks.length, 2);
    acks[1].resolve();
    await flush();
    await flush();
    assert.equal(state.ui.ide.wordWrap, 'on');
  });
});
