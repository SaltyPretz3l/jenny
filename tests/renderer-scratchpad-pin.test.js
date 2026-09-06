// Coverage for the pinnable sticky-note overlay: the pin/unpin/toggle actions
// (pointer-only { pins } writes + delete-strips-pins) and the body-level pin
// controller (chips, expand-to-edit, save-coordination, echo-clobber guard).
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createScratchpadActions } = require('../renderer/features/renderer-dashboard-scratchpad-actions.js');
const { createScratchpadPinController } = require('../renderer/features/renderer-scratchpad-pin.js');
const inventoryTextField = require('../renderer/inventory/text-field.js');
const inventoryActionButton = require('../renderer/inventory/action-button.js');

const FIXED_NOW = new Date(2026, 5, 11, 10, 0);
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---- pin actions -------------------------------------------------------------

// writeScratchpad() adopts an echo only if scratchpadEchoMatches() sees a
// COMPLETE home config (links/weather/widgets/calendar/focusMode/
// showContextualTips) whose scratchpad carries notes + activeNoteId + settings
// + pins. A stub echoing only the patch is rejected, and every write silently
// degrades to { error: 'Could not update pins.' } — so the stub has to model
// the backend's section merge, not just parrot the patch back.
function shellStub(getScratchpad) {
  const updates = [];
  return {
    updates,
    shell: {
      home: {
        updateConfig: async (patch) => {
          updates.push(patch);
          const current = getScratchpad() || {};
          const merged = {
            notes: [],
            activeNoteId: '',
            settings: {},
            pins: [],
            ...current,
            ...(patch.scratchpad || {}),
          };
          return {
            links: [],
            weather: {},
            widgets: {},
            calendar: {},
            focusMode: false,
            showContextualTips: true,
            scratchpad: merged,
          };
        },
      },
    },
  };
}

function noteList(ids) {
  return ids.map((id, i) => ({ id, title: `N${i + 1}`, text: '', updatedAt: '', appendLog: false }));
}

function pinActions(scratchpadOrFn) {
  const getScratchpad = typeof scratchpadOrFn === 'function' ? scratchpadOrFn : () => scratchpadOrFn;
  const { shell, updates } = shellStub(getScratchpad);
  const actions = createScratchpadActions({ shell, getScratchpad, nowProvider: () => FIXED_NOW });
  return { actions, updates };
}

test('pinNote appends the id via a pointer-only { pins } patch (notes untouched)', async () => {
  const { actions, updates } = pinActions({
    notes: noteList(['note-1', 'note-2']), activeNoteId: 'note-1', settings: {}, pins: [],
  });

  const result = await actions.pinNote('note-2');

  assert.deepEqual(result, { ok: true, pinned: true });
  assert.equal(updates.length, 1);
  // Pointer-only patch: only `pins` is written, so the section merge keeps the
  // notes array + activeNoteId + settings intact.
  assert.deepEqual(updates[0].scratchpad, { pins: ['note-2'] });
});

test('pinNote refuses at the pin cap and writes nothing', async () => {
  const { actions, updates } = pinActions({
    notes: noteList(['note-1', 'note-2', 'note-3', 'note-4', 'note-5']),
    activeNoteId: 'note-1', settings: {}, pins: ['note-1', 'note-2', 'note-3', 'note-4'],
  });

  const result = await actions.pinNote('note-5');

  assert.match(result.error, /Up to 4/);
  assert.equal(updates.length, 0);
});

test('pinNote on an already-pinned note is an idempotent no-op', async () => {
  const { actions, updates } = pinActions({
    notes: noteList(['note-1']), activeNoteId: 'note-1', settings: {}, pins: ['note-1'],
  });

  const result = await actions.pinNote('note-1');

  assert.deepEqual(result, { ok: true, pinned: true });
  assert.equal(updates.length, 0);
});

test('unpinNote removes only the target id', async () => {
  const { actions, updates } = pinActions({
    notes: noteList(['note-1', 'note-2']), activeNoteId: 'note-1', settings: {}, pins: ['note-1', 'note-2'],
  });

  const result = await actions.unpinNote('note-1');

  assert.deepEqual(result, { ok: true, pinned: false });
  assert.deepEqual(updates[0].scratchpad, { pins: ['note-2'] });
});

test('togglePin flips the current pin state', async () => {
  // Mutable snapshot so the second toggle reads the first toggle is not applied
  // (the stub does not echo); two calls off the same baseline cover both flips.
  const pinned = pinActions({
    notes: noteList(['note-1', 'note-2']), activeNoteId: 'note-1', settings: {}, pins: ['note-1'],
  });
  const offResult = await pinned.actions.togglePin('note-1');
  assert.deepEqual(offResult, { ok: true, pinned: false });
  assert.deepEqual(pinned.updates[0].scratchpad, { pins: [] });

  const unpinned = pinActions({
    notes: noteList(['note-1', 'note-2']), activeNoteId: 'note-1', settings: {}, pins: ['note-1'],
  });
  const onResult = await unpinned.actions.togglePin('note-2');
  assert.deepEqual(onResult, { ok: true, pinned: true });
  assert.deepEqual(unpinned.updates[0].scratchpad, { pins: ['note-1', 'note-2'] });
});

test('deleteNote strips the deleted id from pins in the same write', async () => {
  const { actions, updates } = pinActions({
    notes: noteList(['note-1', 'note-2']), activeNoteId: 'note-1', settings: {}, pins: ['note-1', 'note-2'],
  });

  const result = await actions.deleteNote('note-2');

  assert.equal(result.ok, true);
  assert.equal(updates[0].scratchpad.notes.length, 1);
  assert.deepEqual(updates[0].scratchpad.pins, ['note-1']);
});

// ---- pin controller ----------------------------------------------------------

function pinState({ pins = [], notes = [{ id: 'note-1', title: 'Alpha', text: 'hello world' }], flag = true }) {
  return {
    features: { featureFlags: { scratchpad_pin: flag } },
    homeConfig: { scratchpad: { notes, activeNoteId: notes[0] && notes[0].id, settings: {}, pins } },
  };
}

function makeController(state, actions = {}, overrides = {}) {
  const dom = new JSDOM('<div id="pinnedNoteTabs"></div><div id="pinnedNoteLayer"></div>');
  const layer = dom.window.document.getElementById('pinnedNoteLayer');
  const tabs = dom.window.document.getElementById('pinnedNoteTabs');
  const controller = createScratchpadPinController({
    documentRef: dom.window.document,
    layerEl: layer,
    tabsEl: tabs,
    actionButton: inventoryActionButton,
    textField: inventoryTextField,
    getState: () => state,
    actions,
    ...overrides,
  });
  return { dom, layer, tabs, controller, window: dom.window, document: dom.window.document };
}

function clickEl(window, el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

test('flag-off renders nothing and hides both surfaces', () => {
  const { layer, tabs, controller } = makeController(pinState({ pins: ['note-1'], flag: false }));
  controller.render();
  assert.equal(tabs.querySelectorAll('.pin-tab').length, 0);
  assert.equal(tabs.hidden, true);
  assert.equal(layer.querySelectorAll('.scratchpad-pin').length, 0);
  assert.equal(layer.hidden, true);
});

test('flag-on with no pins keeps both surfaces empty + hidden', () => {
  const { layer, tabs, controller } = makeController(pinState({ pins: [] }));
  controller.render();
  assert.equal(tabs.querySelectorAll('.pin-tab').length, 0);
  assert.equal(tabs.hidden, true);
  assert.equal(layer.hidden, true);
});

test('renders one tab per pinned id in pin order; the layer stays closed until a click', () => {
  const state = pinState({
    notes: [
      { id: 'note-1', title: 'Alpha', text: 'line one\nline two' },
      { id: 'note-2', title: 'Beta', text: 'bbb' },
    ],
    pins: ['note-2', 'note-1'],
  });
  const { layer, tabs, controller } = makeController(state);
  controller.render();

  const tabEls = tabs.querySelectorAll('.pin-tab');
  assert.equal(tabEls.length, 2);
  assert.equal(tabEls[0].getAttribute('data-pin-expand'), 'note-2'); // pin order preserved
  assert.equal(tabEls[1].getAttribute('data-pin-expand'), 'note-1');
  assert.equal(tabs.hidden, false);
  // No pin is expanded yet, so the editor popover is empty + hidden.
  assert.equal(layer.hidden, true);
  // There is no side/edge accent-bar element (the rejected "vibecoded" treatment).
  assert.equal(tabs.querySelector('.scratchpad-pin__sidebar, .scratchpad-pin__accent-bar, .scratchpad-pin__bar'), null);
  // Preview is the first non-empty line of the note body, surfaced as the tooltip.
  assert.match(tabs.querySelector('[data-pin-expand="note-1"]').getAttribute('title'), /line one/);
});

test('clicking a tab expands it into an editable textarea panel in the popover', () => {
  const { layer, tabs, controller, window } = makeController(pinState({ pins: ['note-1'] }));
  controller.render();
  clickEl(window, tabs.querySelector('[data-pin-expand="note-1"]'));

  const editor = layer.querySelector('#scratchpadPinEditor');
  assert.ok(editor);
  assert.equal(editor.tagName, 'TEXTAREA');
  assert.equal(editor.value, 'hello world');
  assert.ok(layer.querySelector('.scratchpad-pin--expanded'));
  assert.equal(layer.hidden, false);
  // The active tab is marked selected.
  assert.equal(tabs.querySelector('[data-pin-expand="note-1"]').getAttribute('aria-selected'), 'true');
  assert.ok(tabs.querySelector('.pin-tab--active'));
});

test('clicking the active tab again toggles the popover closed', async () => {
  const actions = { flushSave: () => Promise.resolve() };
  const { layer, tabs, controller, window } = makeController(pinState({ pins: ['note-1'] }), actions);
  controller.render();
  clickEl(window, tabs.querySelector('[data-pin-expand="note-1"]'));
  assert.equal(layer.hidden, false);

  clickEl(window, tabs.querySelector('[data-pin-expand="note-1"]'));
  await flush();
  assert.equal(layer.hidden, true);
  assert.equal(layer.querySelector('#scratchpadPinEditor'), null);
  assert.equal(tabs.querySelector('.pin-tab--active'), null);
});

test('capture-phase pointerdown in the shared context menu keeps the pin open but outside collapses it', async () => {
  let flushes = 0;
  const actions = { flushSave: () => { flushes += 1; return Promise.resolve(); } };
  const { layer, tabs, controller, window, document } = makeController(pinState({ pins: ['note-1'] }), actions);
  controller.render();
  clickEl(window, tabs.querySelector('[data-pin-expand="note-1"]'));
  const editor = layer.querySelector('#scratchpadPinEditor');
  const menu = document.createElement('div');
  menu.className = 'inv-context-menu';
  const menuItem = document.createElement('button');
  menu.appendChild(menuItem);
  document.body.appendChild(menu);

  menuItem.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  await flush();
  assert.equal(flushes, 0);
  assert.equal(layer.querySelector('#scratchpadPinEditor'), editor);
  assert.equal(layer.hidden, false);

  const elsewhere = document.createElement('button');
  document.body.appendChild(elsewhere);
  elsewhere.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  await flush();
  assert.equal(flushes, 1);
  assert.equal(layer.querySelector('#scratchpadPinEditor'), null);
  assert.equal(layer.hidden, true);
});

test('editing the panel debounces a save and blur flushes it', () => {
  const saves = [];
  let flushes = 0;
  const actions = { queueSave: (text, id) => saves.push([text, id]), flushSave: () => { flushes += 1; return Promise.resolve(); } };
  const { layer, tabs, controller, window } = makeController(pinState({ pins: ['note-1'] }), actions);
  controller.render();
  clickEl(window, tabs.querySelector('[data-pin-expand="note-1"]'));

  const editor = layer.querySelector('#scratchpadPinEditor');
  editor.value = 'edited body';
  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(saves, [['edited body', 'note-1']]);

  editor.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  assert.ok(flushes >= 1);
});

test('the unpin control removes the tab after the action resolves', async () => {
  const state = pinState({ pins: ['note-1'] });
  const actions = {
    flushSave: () => Promise.resolve(),
    unpinNote: (id) => {
      state.homeConfig.scratchpad.pins = state.homeConfig.scratchpad.pins.filter((p) => p !== id);
      return Promise.resolve({ ok: true, pinned: false });
    },
  };
  const { layer, tabs, controller, window } = makeController(state, actions);
  controller.render();
  clickEl(window, tabs.querySelector('[data-pin-expand="note-1"]'));
  clickEl(window, layer.querySelector('[data-pin-unpin="note-1"]'));
  await flush();

  assert.equal(tabs.querySelectorAll('.pin-tab').length, 0);
  assert.equal(tabs.hidden, true);
  assert.equal(layer.hidden, true);
});

test('a deleted pinned note drops its tab on the next render (cross-filter)', () => {
  const state = pinState({
    notes: [
      { id: 'note-1', title: 'Alpha', text: 'a' },
      { id: 'note-2', title: 'Beta', text: 'b' },
    ],
    pins: ['note-1', 'note-2'],
  });
  const { tabs, controller } = makeController(state);
  controller.render();
  assert.equal(tabs.querySelectorAll('.pin-tab').length, 2);

  // Note-2 is deleted underneath us; its pin id lingers but the controller
  // cross-filters pins against surviving notes, so the tab disappears.
  state.homeConfig.scratchpad.notes = [{ id: 'note-1', title: 'Alpha', text: 'a' }];
  controller.render();
  const tabEls = tabs.querySelectorAll('.pin-tab');
  assert.equal(tabEls.length, 1);
  assert.equal(tabEls[0].getAttribute('data-pin-expand'), 'note-1');
});

test('an incoming echo while the editor is focused does not clobber the textarea', () => {
  const state = pinState({ pins: ['note-1'] });
  const { layer, tabs, controller, window } = makeController(state, { queueSave() {}, flushSave: () => Promise.resolve() });
  controller.render();
  clickEl(window, tabs.querySelector('[data-pin-expand="note-1"]'));

  const editor = layer.querySelector('#scratchpadPinEditor');
  editor.focus();
  editor.value = 'user is typing';
  // A config echo changes the note text underneath while the editor is focused.
  state.homeConfig.scratchpad.notes[0].text = 'remote change';
  controller.render();

  assert.equal(layer.querySelector('#scratchpadPinEditor').value, 'user is typing');
});

test('dispose tears down listeners and empties both surfaces', () => {
  const state = pinState({ pins: ['note-1'] });
  const { layer, tabs, controller, window } = makeController(state, { queueSave() {}, flushSave: () => Promise.resolve() });
  controller.render();
  assert.equal(tabs.querySelectorAll('.pin-tab').length, 1);

  controller.dispose();
  assert.equal(tabs.innerHTML, '');
  assert.equal(layer.innerHTML, '');
  // After dispose a stray click on the (now-empty) strip is inert and render is a no-op.
  clickEl(window, tabs);
  controller.render();
  assert.equal(tabs.querySelectorAll('.pin-tab').length, 0);
});
