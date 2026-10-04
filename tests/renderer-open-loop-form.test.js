'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createOpenLoopFormController,
  deferPresetLabel,
  getAvailableDeferPresets,
} = require('../renderer/features/renderer-open-loop-form.js');

function createForm({ companion = {} } = {}) {
  const { document } = new JSDOM('<form id="f"><input id="t"><textarea id="n"></textarea><select id="s"></select><button id="save"></button><button id="add"></button></form>').window;
  const byId = (id) => document.getElementById(id);
  const toasts = [];
  let companionState = { loaded: true };
  const controller = createOpenLoopFormController({
    windowRef: { jennyShell: { companion } },
    documentRef: document,
    dom: {
      homeOpenLoopForm: byId('f'),
      homeOpenLoopTitleInput: byId('t'),
      homeOpenLoopNotesInput: byId('n'),
      homeOpenLoopDeferSelect: byId('s'),
      homeOpenLoopSaveButton: byId('save'),
      homeOpenLoopAddButton: byId('add'),
    },
    getCompanionState: () => companionState,
    renderHomePanel: () => controller.render(companionState),
    loopToast: (message) => { toasts.push(message); return `toast-${toasts.length}`; },
  });
  return { controller, byId, toasts, setState: (next) => { companionState = next; } };
}

test('defer presets fall back to the three defaults and label through the catalog', () => {
  assert.deepEqual(getAvailableDeferPresets({}).map((preset) => preset.preset), ['later_today', 'tomorrow', 'next_week']);
  assert.deepEqual(getAvailableDeferPresets({ availableDeferPresets: [{ preset: 'x', label: 'Custom' }] }), [{ preset: 'x', label: 'Custom' }]);
  assert.equal(deferPresetLabel({ preset: 'next_week', label: 'ignored' }), 'Next week');
  assert.equal(deferPresetLabel({ preset: 'custom', label: 'Custom' }), 'Custom');
});

test('Save is disabled and busy for exactly the duration of the call', async () => {
  let resolveAdd;
  const { controller, byId } = createForm({
    companion: { addFollowUp: () => new Promise((resolve) => { resolveAdd = resolve; }) },
  });
  controller.open();
  byId('t').value = 'Title';
  const saving = controller.submit();
  assert.equal(byId('save').disabled, true);
  assert.equal(byId('save').getAttribute('aria-busy'), 'true');
  resolveAdd({});
  await saving;
  assert.equal(byId('save').hasAttribute('aria-busy'), false);
  assert.equal(byId('save').disabled, false);
  assert.equal(byId('f').hidden, true, 'a completed add closes its own form');
});

test('editing a completed loop never sends timing, and the timing select is locked', async () => {
  const patches = [];
  const { controller, byId } = createForm({
    companion: { updateFollowUp: async (_id, patch) => { patches.push(patch); return {}; } },
  });
  controller.open({ followUpId: 'r1', status: 'resolved', title: 'Done', body: '' });
  assert.equal(controller.editingFollowUpId(), 'r1');
  assert.equal(byId('s').disabled, true);
  byId('s').value = 'tomorrow';
  await controller.submit();
  assert.deepEqual(patches, [{ label: 'Done', body: '' }]);
  assert.equal(controller.editingFollowUpId(), '');
});

test('closeIfEditing only closes the form for that loop', () => {
  const { controller, byId } = createForm();
  controller.open({ followUpId: 'a', status: 'active', title: 'A' });
  controller.closeIfEditing('b');
  assert.equal(byId('f').hidden, false);
  controller.closeIfEditing('a');
  assert.equal(byId('f').hidden, true);
});

test('a missing title warns and keeps the form open without calling the service', async () => {
  let called = false;
  const { controller, byId, toasts } = createForm({ companion: { addFollowUp: async () => { called = true; return {}; } } });
  controller.open();
  byId('t').value = '   ';
  await controller.submit();
  assert.equal(called, false);
  assert.deepEqual(toasts, ['Add a title before saving this open loop.']);
  assert.equal(byId('f').hidden, false);
});
