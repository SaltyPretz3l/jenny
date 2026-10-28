'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const rendererIdeState = require('../renderer/features/renderer-ide-state');
const { createIdeAutoSave } = require('../renderer/features/renderer-ide-auto-save');
const { createFakeTimers } = require('./helpers/fake-timers');

// Minimal EventTarget-style window + document: counts listeners so dispose() is checkable.
function makeFakeWindow() {
  const make = () => {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(type, fn, opts) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push({ fn, capture: opts === true || opts?.capture === true });
      },
      removeEventListener(type, fn) {
        const list = (listeners.get(type) || []).filter((entry) => entry.fn !== fn);
        listeners.set(type, list);
      },
      fire(type, event = {}) { for (const entry of [...(listeners.get(type) || [])]) entry.fn({ type, ...event }); },
      count(type) { return (listeners.get(type) || []).length; },
    };
  };
  const win = make();
  win.document = make();
  return win;
}

// An element stub with `closest('.monaco-editor')` resolving to a given editor root.
function el(editorRoot) {
  return { closest: (selector) => (selector === '.monaco-editor' ? editorRoot : null) };
}

function buildIde(persisted) {
  const ide = rendererIdeState.createIdeUiState();
  rendererIdeState.applyPersistedState(ide, {
    openTabs: [{ path: 'A' }, { path: 'B' }],
    activeTabPath: 'A',
    ...persisted,
  });
  return ide;
}

function setup({ persisted = {}, state = {}, depsOverride = {} } = {}) {
  const ide = buildIde(persisted);
  const win = makeFakeWindow();
  const timers = createFakeTimers();
  const saves = [];
  let saving = false;
  const docs = {
    A: { kind: 'file', dirty: true },
    B: { kind: 'file', dirty: true },
    ...state.docs,
  };
  let focusedPath = 'A';
  const editorHost = {
    getActivePath: () => 'A',
    getFocusedPath: () => focusedPath,
    getDocumentKind: (p) => docs[p]?.kind || '',
    isDirty: (p) => docs[p]?.dirty === true,
  };
  const autoSave = createIdeAutoSave({
    editorHost,
    getIde: () => ide,
    saveFile: (path) => { saves.push(path); return Promise.resolve(true); },
    isSaving: () => saving,
    timers,
    windowRef: win,
    ...depsOverride,
  });
  return {
    ide, win, timers, saves, docs, autoSave,
    setSaving: (v) => { saving = v; },
    setFocusedPath: (p) => { focusedPath = p; },
  };
}

function activeChanged(win, path) {
  win.fire('ide:active-file-changed', { detail: { path } });
}

test('onFocusChange: deactivating dirty tab A saves A (the red-run contract)', () => {
  const ctx = setup({ persisted: { autoSaveMode: 'onFocusChange' } });
  activeChanged(ctx.win, 'A'); // seeds the tracked "previous" path
  activeChanged(ctx.win, 'B');
  assert.deepEqual(ctx.saves, ['A']);
});

test('onFocusChange: onChange arms nothing', () => {
  const ctx = setup({ persisted: { autoSaveMode: 'onFocusChange' } });
  ctx.autoSave.onChange('A');
  assert.equal(ctx.timers.pending(), 0);
});

test('onFocusChange: tab deactivation honors the stale / non-file / clean gating', () => {
  const stale = setup({ persisted: { autoSaveMode: 'onFocusChange' } });
  stale.ide.staleByPath = { A: true };
  activeChanged(stale.win, 'A');
  activeChanged(stale.win, 'B');
  assert.deepEqual(stale.saves, []);

  const diff = setup({ persisted: { autoSaveMode: 'onFocusChange' }, state: { docs: { A: { kind: 'diff', dirty: true } } } });
  activeChanged(diff.win, 'A');
  activeChanged(diff.win, 'B');
  assert.deepEqual(diff.saves, []);

  const clean = setup({ persisted: { autoSaveMode: 'onFocusChange' }, state: { docs: { A: { kind: 'file', dirty: false } } } });
  activeChanged(clean.win, 'A');
  activeChanged(clean.win, 'B');
  assert.deepEqual(clean.saves, []);
});

test('onFocusChange: isSaving() re-arms a retry instead of dropping the save', () => {
  const ctx = setup({ persisted: { autoSaveMode: 'onFocusChange' } });
  ctx.setSaving(true);
  activeChanged(ctx.win, 'A');
  activeChanged(ctx.win, 'B');
  assert.deepEqual(ctx.saves, []);
  assert.equal(ctx.timers.pending(), 1);
  ctx.setSaving(false);
  ctx.timers.runPending();
  assert.deepEqual(ctx.saves, ['A']);
});

test('onFocusChange: focusout leaving a Monaco editor saves the focused path; moving between editors does not', () => {
  const ctx = setup({ persisted: { autoSaveMode: 'onFocusChange' } });
  const editorOne = {};
  const editorTwo = {};
  assert.equal(ctx.win.document.count('focusout'), 1);
  assert.equal(ctx.win.document.listeners.get('focusout')[0].capture, true, 'capture-phase listener');
  // Inside the same editor: no save.
  ctx.win.document.fire('focusout', { target: el(editorOne), relatedTarget: el(editorOne) });
  assert.deepEqual(ctx.saves, []);
  // Between editors (relatedTarget is another .monaco-editor): still a focus change out of this editor -> saves.
  ctx.setFocusedPath('B');
  ctx.win.document.fire('focusout', { target: el(editorOne), relatedTarget: el(editorTwo) });
  assert.deepEqual(ctx.saves, ['B']);
  // Out to a non-editor element saves.
  ctx.setFocusedPath('A');
  ctx.win.document.fire('focusout', { target: el(editorOne), relatedTarget: el(null) });
  assert.deepEqual(ctx.saves, ['B', 'A']);
  // A non-editor focusout is ignored.
  ctx.win.document.fire('focusout', { target: el(null), relatedTarget: null });
  assert.deepEqual(ctx.saves, ['B', 'A']);
});

test('onWindowChange: window blur saves every dirty open file tab, skipping stale / non-file / clean', () => {
  const ctx = setup({
    persisted: { autoSaveMode: 'onWindowChange' },
    state: { docs: { B: { kind: 'file', dirty: true }, C: { kind: 'file', dirty: false } } },
  });
  ctx.ide.openTabs.push({ path: 'C', kind: 'file' }, { path: 'D', kind: 'file' });
  ctx.docs.D = { kind: 'diff', dirty: true };
  ctx.ide.staleByPath = { B: true };
  ctx.win.fire('blur');
  assert.deepEqual(ctx.saves, ['A']);
  // Focus-change events are inert in this mode.
  activeChanged(ctx.win, 'A');
  activeChanged(ctx.win, 'B');
  assert.deepEqual(ctx.saves, ['A']);
});

test('onWindowChange: isSaving() re-arms per path', () => {
  const ctx = setup({ persisted: { autoSaveMode: 'onWindowChange' } });
  ctx.setSaving(true);
  ctx.win.fire('blur');
  assert.deepEqual(ctx.saves, []);
  assert.equal(ctx.timers.pending(), 2);
  ctx.setSaving(false);
  ctx.timers.runPending();
  assert.deepEqual(ctx.saves.sort(), ['A', 'B']);
});

test('off mode is inert: no timers, no saves, onChange clears pending timers', () => {
  const ctx = setup({ persisted: { autoSaveMode: 'afterDelay' } });
  ctx.autoSave.onChange('A');
  assert.equal(ctx.timers.pending(), 1);
  ctx.ide.autoSaveMode = 'off';
  ctx.autoSave.onChange('A');
  assert.equal(ctx.timers.pending(), 0);
  ctx.win.fire('blur');
  activeChanged(ctx.win, 'A');
  activeChanged(ctx.win, 'B');
  ctx.win.document.fire('focusout', { target: el({}), relatedTarget: null });
  assert.deepEqual(ctx.saves, []);
});

test('afterDelay: debounces, reads delay live (clamped) and falls back when out of range', () => {
  const ctx = setup({ persisted: { autoSaveMode: 'afterDelay', autoSaveDelayMs: 2500 } });
  ctx.autoSave.onChange('A');
  assert.deepEqual(ctx.timers.delays(), [2500]);
  ctx.timers.runPending();
  assert.deepEqual(ctx.saves, ['A']);
  ctx.ide.autoSaveDelayMs = 5; // below the floor -> 100
  ctx.autoSave.onChange('A');
  assert.deepEqual(ctx.timers.delays(), [100]);
  ctx.ide.autoSaveDelayMs = 9e9; // above the ceiling -> 60000
  ctx.autoSave.onChange('A');
  assert.deepEqual(ctx.timers.delays(), [60000]);
  ctx.ide.autoSaveDelayMs = undefined; // missing -> 1000
  ctx.autoSave.onChange('A');
  assert.deepEqual(ctx.timers.delays(), [1000]);
});

test('afterDelay: missing delay falls back to deps.scheduleDelayMs, then 1000', () => {
  const ctx = setup({ persisted: { autoSaveMode: 'afterDelay' }, depsOverride: { scheduleDelayMs: 777 } });
  delete ctx.ide.autoSaveDelayMs;
  ctx.autoSave.onChange('A');
  assert.deepEqual(ctx.timers.delays(), [777]);
});

test('mode resolution: getMode wins; isEnabled-only maps to afterDelay/off', () => {
  const viaGetMode = setup({ persisted: { autoSaveMode: 'off' }, depsOverride: { getMode: () => 'afterDelay' } });
  viaGetMode.autoSave.onChange('A');
  assert.equal(viaGetMode.timers.pending(), 1);

  const viaIsEnabledOn = setup({ depsOverride: { isEnabled: () => true } });
  viaIsEnabledOn.autoSave.onChange('A');
  assert.equal(viaIsEnabledOn.timers.pending(), 1);

  const viaIsEnabledOff = setup({ persisted: { autoSaveMode: 'afterDelay' }, depsOverride: { isEnabled: () => false } });
  viaIsEnabledOff.autoSave.onChange('A');
  assert.equal(viaIsEnabledOff.timers.pending(), 0);
});

test('dispose removes every listener and pending timer', () => {
  const ctx = setup({ persisted: { autoSaveMode: 'onFocusChange' } });
  assert.equal(ctx.win.count('ide:active-file-changed'), 1);
  assert.equal(ctx.win.count('blur'), 1);
  assert.equal(ctx.win.document.count('focusout'), 1);
  ctx.autoSave.dispose();
  assert.equal(ctx.win.count('ide:active-file-changed'), 0);
  assert.equal(ctx.win.count('blur'), 0);
  assert.equal(ctx.win.document.count('focusout'), 0);
});

test('construction tolerates a window without addEventListener / document', () => {
  const autoSave = createIdeAutoSave({
    editorHost: {},
    getIde: () => ({}),
    saveFile: () => Promise.resolve(true),
    windowRef: {},
    timers: createFakeTimers(),
  });
  autoSave.dispose();
});

test('migration + mirror through the renderer state', () => {
  const legacy = buildIde({ autoSaveEnabled: true });
  assert.equal(legacy.autoSaveMode, 'afterDelay');
  assert.equal(legacy.autoSaveEnabled, true);
  const explicitOff = buildIde({ autoSaveMode: 'off', autoSaveEnabled: true });
  assert.equal(explicitOff.autoSaveMode, 'off');
  assert.equal(explicitOff.autoSaveEnabled, false, 'mirror is recomputed from the resolved mode');
  const focus = buildIde({ autoSaveMode: 'onFocusChange' });
  assert.equal(focus.autoSaveEnabled, true);
  const junk = buildIde({ autoSaveMode: 'sometimes' });
  assert.equal(junk.autoSaveMode, 'off');
  assert.equal(junk.autoSaveEnabled, false);
});
