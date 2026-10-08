'use strict';

/* Secondary editor-group view (W5): DOM shape, tab strip rendering, the group's
 * own Monaco editor over shared models (view-state save/restore, empty state),
 * delegated tab events and the tab drag/drop contract. Driven in jsdom with a
 * fake editorHost + fake Monaco editor that record every call. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeEditorGroupView, TAB_MIME } = require('../renderer/features/renderer-ide-editor-group-view');
const { escapeHtml } = require('../renderer/shared/string-utils');

function makeEditor() {
  let counter = 0;
  const editor = {
    model: null,
    modelCalls: [],
    saved: [],
    restored: [],
    focused: 0,
    layouts: 0,
    disposed: false,
    contentCb: null,
    contentDisposed: false,
    setModelHook: null,
    setModel(model) { editor.model = model; editor.modelCalls.push(model); editor.setModelHook?.(); },
    saveViewState() { counter += 1; const state = { of: editor.model ? editor.model.path : null, n: counter }; editor.saved.push(state); return state; },
    restoreViewState(state) { editor.restored.push(state); },
    focus() { editor.focused += 1; },
    layout() { editor.layouts += 1; },
    onDidChangeModelContent(cb) { editor.contentCb = cb; return { dispose() { editor.contentDisposed = true; } }; },
  };
  return editor;
}

function makeRig({ dir = '', tabs = ['a.js', 'b.js', 'c.js'], active = 'a.js', monaco = true } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="root"${dir ? ` dir="${dir}"` : ''}></div></body>`);
  const document = dom.window.document;
  const state = { tabs: tabs.map((path) => ({ path, kind: 'file' })), active, dirty: new Set(), stale: new Set() };
  const models = new Map(['a.js', 'b.js', 'c.js'].map((path) => [path, { path }]));
  const log = { created: [], released: [], noted: [], calls: [] };
  const docViewStates = new Map();
  const editor = makeEditor();
  const editorHost = {
    getModel: (path) => models.get(path) || null,
    getViewState: (path) => docViewStates.get(path) || null,
    createGroupEditor(el, opts) { log.created.push({ el, opts }); return monaco ? editor : null; },
    releaseGroupEditor(released) { log.released.push(released); },
    noteModelEdited(path) { log.noted.push(path); },
  };
  const record = (name) => (...args) => log.calls.push([name, ...args]);
  const view = createIdeEditorGroupView({
    groupId: 'editor-2',
    groupNumber: 2,
    document,
    editorHost,
    escapeHtml,
    getTabs: () => state.tabs,
    getActive: () => state.active,
    getDirty: (path) => state.dirty.has(path),
    getStale: (path) => state.stale.has(path),
    onActivate: record('activate'),
    onClose: record('close'),
    onSave: record('save'),
    onFocus: record('focus'),
    onContextMenu: record('menu'),
    onDropTab: record('drop'),
  });
  document.getElementById('root').appendChild(view.el);
  const strip = view.el.querySelector('.ide-tabstrip');
  const stage = view.el.querySelector('.ide-group-stage');
  const emptyEl = view.el.querySelector('.ide-group-empty');
  const win = dom.window;
  return { dom, win, document, view, state, models, log, docViewStates, editor, strip, stage, emptyEl, editorHost };
}

function stubTabRects(strip) {
  [...strip.querySelectorAll('.ide-tab')].forEach((tab, index) => {
    tab.getBoundingClientRect = () => ({ left: index * 100, width: 100, right: index * 100 + 100, top: 0, bottom: 30, height: 30 });
  });
}

function dragEvent(win, type, { types = [TAB_MIME], data = {}, clientX = 0 } = {}) {
  const event = new win.Event(type, { bubbles: true, cancelable: true });
  const store = { ...data };
  event.clientX = clientX;
  event.dataTransfer = {
    types,
    effectAllowed: '',
    dropEffect: '',
    setData(mime, value) { store[mime] = value; },
    getData(mime) { return store[mime] || ''; },
    store,
  };
  return event;
}

test('builds the group section, labelled tab strip and stage once', () => {
  const rig = makeRig();
  const { view, strip, stage, emptyEl } = rig;
  assert.equal(view.el.tagName, 'SECTION');
  assert.equal(view.el.className, 'ide-group');
  assert.equal(view.el.getAttribute('data-ide-group'), 'editor-2');
  assert.equal(strip.getAttribute('role'), 'tablist');
  assert.equal(strip.getAttribute('aria-label'), 'Editor group 2');
  assert.equal(strip.parentElement.className, 'ide-tabbar');
  assert.equal(stage.id, 'ideGroupStage-editor-2');
  assert.equal(stage.getAttribute('role'), 'tabpanel');
  assert.equal(stage.getAttribute('tabindex'), '-1');
  assert.ok(stage.querySelector('.ide-group-editor'));
  assert.equal(emptyEl.getAttribute('role'), 'status');
  assert.ok(emptyEl.classList.contains('wb-empty'));
  assert.equal(emptyEl.hidden, true);
  assert.equal(emptyEl.textContent, 'This file is still opening.');
  assert.equal(rig.log.created.length, 0, 'the editor is created lazily');
});

test('render draws the tabs with active, dirty and stale state and points them at the group stage', () => {
  const rig = makeRig();
  rig.state.dirty.add('b.js');
  rig.state.stale.add('c.js');
  rig.view.render();
  const tabs = [...rig.strip.querySelectorAll('.ide-tab')];
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('data-ide-tab')), ['a.js', 'b.js', 'c.js']);
  assert.ok(tabs[0].classList.contains('ide-tab--active'));
  assert.ok(tabs[1].classList.contains('ide-tab--dirty'));
  assert.ok(tabs[2].classList.contains('ide-tab--stale'));
  assert.deepEqual(
    [...rig.strip.querySelectorAll('.ide-tab-label')].map((label) => label.getAttribute('aria-controls')),
    Array(3).fill('ideGroupStage-editor-2'),
  );
  assert.equal(rig.log.created.length, 1, 'render shows the active path, creating the editor');
  assert.equal(rig.editor.model, rig.models.get('a.js'));
  assert.equal(rig.log.created[0].el, rig.stage.querySelector('.ide-group-editor'));
});

test('showPath stores the outgoing view state and restores it on return', () => {
  const rig = makeRig();
  rig.view.showPath('a.js');
  assert.equal(rig.editor.restored.length, 0, 'nothing to restore on first show');
  rig.view.showPath('b.js');
  assert.equal(rig.editor.saved.length, 1);
  assert.equal(rig.editor.saved[0].of, 'a.js', 'the outgoing state was read while a.js was attached');
  assert.equal(rig.editor.model, rig.models.get('b.js'));
  assert.equal(rig.editor.restored.length, 0, 'b.js has no stored state');
  rig.view.showPath('a.js');
  assert.deepEqual(rig.editor.restored, [rig.editor.saved[0]]);
  assert.equal(rig.editor.model, rig.models.get('a.js'));
});

test('showPath falls back to the document-level view state when the view has none', () => {
  const rig = makeRig();
  const moved = { of: 'b.js', fromPrimary: true };
  rig.docViewStates.set('b.js', moved);
  rig.view.showPath('b.js');
  assert.deepEqual(rig.editor.restored, [moved]);
  rig.view.showPath('a.js');
  rig.view.showPath('b.js');
  assert.equal(rig.editor.restored.length, 2);
  assert.notEqual(rig.editor.restored[1], moved, 'the view own stored state wins once it has one');
  assert.equal(rig.editor.restored[1].of, 'b.js');
});

test('showPath is a no-op for an unchanged path', () => {
  const rig = makeRig();
  rig.view.showPath('a.js');
  const modelCalls = rig.editor.modelCalls.length;
  const saves = rig.editor.saved.length;
  rig.view.showPath('a.js');
  rig.view.render();
  assert.equal(rig.editor.modelCalls.length, modelCalls);
  assert.equal(rig.editor.saved.length, saves);
  assert.equal(rig.log.created.length, 1);
});

test('an empty path or a path without a model shows the empty state with the model detached', () => {
  const rig = makeRig();
  rig.view.showPath('');
  assert.equal(rig.emptyEl.hidden, false, 'empty state is shown even before an editor exists');
  assert.equal(rig.log.created.length, 0, 'no editor is created for an empty group');
  rig.view.showPath('a.js');
  assert.equal(rig.emptyEl.hidden, true);
  assert.equal(rig.stage.querySelector('.ide-group-editor').hidden, false);
  rig.view.showPath('');
  assert.equal(rig.editor.model, null);
  assert.equal(rig.emptyEl.hidden, false);
  assert.equal(rig.stage.querySelector('.ide-group-editor').hidden, true);
  rig.view.showPath('a.js');
  rig.view.showPath('missing.js');
  assert.equal(rig.editor.model, null, 'a path without a model detaches');
  assert.equal(rig.emptyEl.hidden, false);
  assert.equal(rig.view.getViewState('missing.js'), null);
});

test('without Monaco the group shows the empty state and retries creation on the next show', () => {
  const rig = makeRig({ monaco: false });
  rig.view.showPath('a.js');
  assert.equal(rig.log.created.length, 1);
  assert.equal(rig.emptyEl.hidden, false);
  rig.view.render();
  assert.equal(rig.log.created.length, 2, 'a later render retries the creation');
});

test('model edits are reported unless the view itself is applying a model', () => {
  const rig = makeRig();
  rig.view.showPath('a.js');
  rig.editor.contentCb();
  assert.deepEqual(rig.log.noted, ['a.js']);
  rig.editor.setModelHook = () => rig.editor.contentCb();
  rig.view.showPath('b.js');
  rig.editor.setModelHook = null;
  assert.deepEqual(rig.log.noted, ['a.js'], 'a content event during setModel is ignored');
  rig.editor.contentCb();
  assert.deepEqual(rig.log.noted, ['a.js', 'b.js']);
});

test('the save and focus callbacks passed to the host route through the view deps', () => {
  const rig = makeRig();
  rig.view.showPath('b.js');
  rig.log.created[0].opts.onSave();
  rig.log.created[0].opts.onFocus();
  assert.deepEqual(rig.log.calls, [['save', 'b.js'], ['focus', 'editor-2']]);
});

test('getViewState reads the live editor for the current path and the stored one otherwise', () => {
  const rig = makeRig();
  rig.view.showPath('a.js');
  rig.view.showPath('b.js');
  const stored = rig.editor.saved[0];
  assert.equal(rig.view.getViewState('a.js'), stored);
  const live = rig.view.getViewState('b.js');
  assert.equal(live.of, 'b.js');
  assert.equal(rig.editor.saved.length, 2, 'the live read asked the editor');
  assert.equal(rig.view.getViewState('c.js'), null);
});

test('forget detaches the current model and drops stored view state', () => {
  const rig = makeRig();
  rig.view.showPath('a.js');
  rig.view.showPath('b.js');
  rig.view.forget('a.js');
  assert.equal(rig.view.getViewState('a.js'), null);
  assert.equal(rig.editor.model, rig.models.get('b.js'), 'forgetting a background path leaves the editor alone');
  rig.view.forget('b.js');
  assert.equal(rig.editor.model, null);
  assert.equal(rig.emptyEl.hidden, false);
  rig.view.showPath('a.js');
  assert.equal(rig.editor.restored.length, 0, 'the dropped state is not restored');
  assert.equal(rig.editor.model, rig.models.get('a.js'));
});

test('click on a tab label activates and on the close button closes', () => {
  const rig = makeRig();
  rig.view.render();
  rig.strip.querySelector('[data-ide-tab-path="b.js"]').click();
  rig.strip.querySelector('[data-ide-tab-close="c.js"]').click();
  assert.deepEqual(rig.log.calls, [['activate', 'b.js'], ['close', 'c.js']]);
});

test('middle click closes a tab and left auxclick does not', () => {
  const rig = makeRig();
  rig.view.render();
  const tab = rig.strip.querySelector('[data-ide-tab="b.js"]');
  const middle = new rig.win.MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true });
  tab.querySelector('.ide-tab-label').dispatchEvent(middle);
  assert.equal(middle.defaultPrevented, true);
  tab.dispatchEvent(new rig.win.MouseEvent('auxclick', { button: 2, bubbles: true, cancelable: true }));
  assert.deepEqual(rig.log.calls, [['close', 'b.js']]);
});

test('context menu anchors on the pointer, or on the tab for a keyboard invocation', () => {
  const rig = makeRig();
  rig.view.render();
  const tab = rig.strip.querySelector('[data-ide-tab="b.js"]');
  const pointer = new rig.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 12 });
  tab.querySelector('.ide-tab-label').dispatchEvent(pointer);
  const keyboard = new rig.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 });
  tab.querySelector('.ide-tab-label').dispatchEvent(keyboard);
  assert.equal(pointer.defaultPrevented, true);
  assert.equal(keyboard.defaultPrevented, true);
  assert.deepEqual(rig.log.calls[0], ['menu', 'b.js', { anchorX: 40, anchorY: 12 }]);
  assert.equal(rig.log.calls[1][0], 'menu');
  assert.equal(rig.log.calls[1][1], 'b.js');
  assert.equal(rig.log.calls[1][2].anchorEl, tab);
  const outside = new rig.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
  rig.stage.dispatchEvent(outside);
  assert.equal(outside.defaultPrevented, false, 'the stage keeps the native menu');
  assert.equal(rig.log.calls.length, 2);
});

function press(rig, element, key) {
  const event = new rig.win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

test('arrow keys, Home and End rove focus across the tab labels with wrap', () => {
  const rig = makeRig();
  rig.view.render();
  const labels = [...rig.strip.querySelectorAll('.ide-tab-label')];
  labels[0].focus();
  assert.equal(press(rig, labels[0], 'ArrowRight').defaultPrevented, true);
  assert.equal(rig.document.activeElement, labels[1]);
  press(rig, labels[1], 'End');
  assert.equal(rig.document.activeElement, labels[2]);
  press(rig, labels[2], 'ArrowRight');
  assert.equal(rig.document.activeElement, labels[0], 'wraps forward');
  press(rig, labels[0], 'ArrowLeft');
  assert.equal(rig.document.activeElement, labels[2], 'wraps backward');
  press(rig, labels[2], 'Home');
  assert.equal(rig.document.activeElement, labels[0]);
  const other = press(rig, labels[0], 'a');
  assert.equal(other.defaultPrevented, false);
  assert.equal(rig.document.activeElement, labels[0]);
});

test('arrow keys mirror inside a dir=rtl ancestor', () => {
  const rig = makeRig({ dir: 'rtl' });
  rig.view.render();
  const labels = [...rig.strip.querySelectorAll('.ide-tab-label')];
  labels[0].focus();
  press(rig, labels[0], 'ArrowLeft');
  assert.equal(rig.document.activeElement, labels[1], 'ArrowLeft moves to the next tab in RTL');
  press(rig, labels[1], 'ArrowRight');
  assert.equal(rig.document.activeElement, labels[0]);
});

test('focus anywhere in the group reports the group', () => {
  const rig = makeRig();
  rig.view.render();
  rig.stage.focus();
  rig.strip.querySelector('.ide-tab-label').focus();
  assert.deepEqual(rig.log.calls, [['focus', 'editor-2'], ['focus', 'editor-2']]);
});

test('dragstart writes the tab payload and a move effect', () => {
  const rig = makeRig();
  rig.view.render();
  const event = dragEvent(rig.win, 'dragstart', { types: [] });
  rig.strip.querySelector('[data-ide-tab="b.js"]').dispatchEvent(event);
  assert.deepEqual(JSON.parse(event.dataTransfer.store[TAB_MIME]), { path: 'b.js', fromGroup: 'editor-2' });
  assert.equal(event.dataTransfer.effectAllowed, 'move');
});

test('dragover marks the strip or the stage only for tab payloads and drag end clears the marks', () => {
  const rig = makeRig();
  rig.view.render();
  const over = dragEvent(rig.win, 'dragover');
  rig.strip.dispatchEvent(over);
  assert.equal(over.defaultPrevented, true);
  assert.equal(rig.strip.getAttribute('data-ide-drop'), 'tabs');
  assert.equal(rig.view.el.getAttribute('data-ide-drop'), null);
  const overStage = dragEvent(rig.win, 'dragover');
  rig.stage.dispatchEvent(overStage);
  assert.equal(rig.view.el.getAttribute('data-ide-drop'), 'stage');
  assert.equal(rig.strip.getAttribute('data-ide-drop'), null);
  rig.view.el.dispatchEvent(dragEvent(rig.win, 'dragleave'));
  assert.equal(rig.view.el.getAttribute('data-ide-drop'), null);
  const foreign = dragEvent(rig.win, 'dragover', { types: ['Files'] });
  rig.strip.dispatchEvent(foreign);
  assert.equal(foreign.defaultPrevented, false);
  assert.equal(rig.strip.getAttribute('data-ide-drop'), null);
  rig.strip.dispatchEvent(dragEvent(rig.win, 'dragover'));
  rig.strip.dispatchEvent(dragEvent(rig.win, 'dragend'));
  assert.equal(rig.strip.getAttribute('data-ide-drop'), null);
});

function payload(path, fromGroup = 'editor-3') {
  return { [TAB_MIME]: JSON.stringify({ path, fromGroup }) };
}

test('dropping on the strip computes the index from the tab midpoints (LTR)', () => {
  const rig = makeRig();
  rig.view.render();
  stubTabRects(rig.strip);
  const drops = [[10, 0], [120, 1], [260, 3]];
  for (const [clientX] of drops) {
    rig.strip.dispatchEvent(dragEvent(rig.win, 'drop', { data: payload('x.js'), clientX }));
  }
  assert.deepEqual(rig.log.calls, drops.map(([, index]) => ['drop', { path: 'x.js', fromGroup: 'editor-3' }, index]));
  assert.equal(rig.strip.getAttribute('data-ide-drop'), null);
});

test('a tab reordered within its own group does not count itself (W5 review)', () => {
  const rig = makeRig();
  rig.view.render();
  stubTabRects(rig.strip);
  // a.js (0-100) dropped between b.js (100-200) and c.js (200-300): its final place is 1.
  rig.strip.dispatchEvent(dragEvent(rig.win, 'drop', { data: payload('a.js', 'editor-2'), clientX: 210 }));
  // a.js dropped on its own right half stays first.
  rig.strip.dispatchEvent(dragEvent(rig.win, 'drop', { data: payload('a.js', 'editor-2'), clientX: 60 }));
  assert.deepEqual(rig.log.calls.map((call) => call[2]), [1, 0]);
});

test('dropping on the strip mirrors the midpoint rule in RTL', () => {
  const rig = makeRig({ dir: 'rtl' });
  rig.view.render();
  stubTabRects(rig.strip);
  rig.strip.dispatchEvent(dragEvent(rig.win, 'drop', { data: payload('x.js'), clientX: 120 }));
  rig.strip.dispatchEvent(dragEvent(rig.win, 'drop', { data: payload('x.js'), clientX: 400 }));
  assert.deepEqual(rig.log.calls.map((call) => call[2]), [2, 0]);
});

test('dropping on the stage appends after the last tab', () => {
  const rig = makeRig();
  rig.view.render();
  const event = dragEvent(rig.win, 'drop', { data: payload('x.js', 'editor-1'), clientX: 5 });
  rig.stage.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(rig.log.calls, [['drop', { path: 'x.js', fromGroup: 'editor-1' }, 3]]);
});

test('an invalid or non-string drop payload is ignored', () => {
  const rig = makeRig();
  rig.view.render();
  for (const raw of ['', 'not json', '{"path":7}', '{"path":""}', 'null', '[]']) {
    const event = dragEvent(rig.win, 'drop', { data: { [TAB_MIME]: raw } });
    rig.stage.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, `payload ${raw} is not handled`);
  }
  assert.deepEqual(rig.log.calls, []);
});

test('focus targets the editor when a model is shown and the stage otherwise', () => {
  const rig = makeRig();
  rig.view.showPath('');
  rig.view.focus();
  assert.equal(rig.document.activeElement, rig.stage);
  assert.equal(rig.editor.focused, 0);
  rig.view.showPath('a.js');
  rig.view.focus();
  assert.equal(rig.editor.focused, 1);
  const layouts = rig.editor.layouts;
  rig.view.layout();
  assert.equal(rig.editor.layouts, layouts + 1);
});

test('dispose releases the editor, removes the listeners and the DOM', () => {
  const rig = makeRig();
  rig.view.render();
  const strip = rig.strip;
  const label = strip.querySelector('[data-ide-tab-path="b.js"]');
  rig.view.dispose();
  assert.deepEqual(rig.log.released, [rig.editor]);
  assert.equal(rig.editor.contentDisposed, true);
  assert.equal(rig.document.querySelector('[data-ide-group]'), null);
  rig.log.calls.length = 0;
  label.click();
  strip.dispatchEvent(dragEvent(rig.win, 'drop', { data: payload('x.js') }));
  assert.deepEqual(rig.log.calls, [], 'no listener survives dispose');
  rig.view.dispose();
  assert.equal(rig.log.released.length, 1, 'dispose is idempotent');
});
